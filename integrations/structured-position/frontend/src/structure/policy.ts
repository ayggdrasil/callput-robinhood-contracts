import type {OptionsMarketItem} from '../_shared/types/mark-iv-price';
import {STOCK_INCOME_CHAIN_ID, STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import {readAccountAccess} from '../utils/readAccountAccess';
import type {SponsoredSetupController} from '../utils/sponsoredSetup';
import {BN} from '../utils/bn';
import {assertFreshSource, type Spread} from './strategy';
import type {IncomePlan} from './workflow';

const STRATEGY_SELL_CALL_SPREAD = 6n;
const CONTEXT_MAX_AGE_SECONDS = 300n;
const CONTEXT_FUTURE_TOLERANCE_SECONDS = 30n;
const MIN_SESSION_REMAINING_SECONDS = 30n;

function requirePolicy(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function uint(value: unknown, message: string) {
  requirePolicy(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), message);
  return BigInt(value);
}

const sameAddress = (left: unknown, right: unknown) =>
  typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();

function sameContext(left: Record<string, unknown>, right: Record<string, unknown>) {
  return ['chainId', 'owner', 'account', 'factory', 'implementationHash', 'epoch', 'accountRegistered',
    'canOpen', 'blockNumber', 'blockHash', 'blockTimestamp'].every(key => left[key] === right[key]);
}

/**
 * Re-reads the one canonical account/session snapshot used by sponsored order
 * entry. This function never creates a session, polls, or prompts a wallet.
 */
export async function assertAccountReady(controller: SponsoredSetupController, plan: IncomePlan, funded: boolean) {
  const now = Math.floor(Date.now() / 1_000);
  requirePolicy(plan.chainId === STOCK_INCOME_CHAIN_ID && controller.identity.chainId === String(STOCK_INCOME_CHAIN_ID),
    'Select Robinhood Chain.');
  requirePolicy(sameAddress(controller.identity.owner, plan.owner)
    && sameAddress(controller.identity.account, plan.account), 'Trading account identity changed.');
  requirePolicy(sameAddress(controller.identity.token, USDG), 'The trading account settlement token is not USDG.');
  const market = STOCK_INCOME_MARKETS.find(candidate => candidate.id.toLowerCase() === plan.marketId.toLowerCase());
  requirePolicy(market && market.symbol === plan.spread.symbol, 'The stock market route changed.');
  requirePolicy(plan.quote.expiry === plan.spread.expiry && plan.spread.expiry > now, 'The spread expiry is no longer valid.');
  assertFreshSource(plan.spread.sourceAt, now);
  requirePolicy(Number.isSafeInteger(plan.quote.quotedAt) && plan.quote.quotedAt > 0
    && plan.quote.quotedAt <= now && now - plan.quote.quotedAt <= 150, 'The funding quote is stale.');
  const amount = uint(plan.quote.amount, 'The funding amount is invalid.');
  requirePolicy(amount > 0n, 'The funding amount is invalid.');

  const trading = controller.trading;
  requirePolicy(trading, 'Trading permission is unavailable.');
  const selected = trading.selectedSession();
  requirePolicy(selected, 'No trading session is selected.');
  requirePolicy(selected.identity.chainId === controller.identity.chainId
    && sameAddress(selected.identity.owner, plan.owner) && sameAddress(selected.identity.account, plan.account),
  'Trading session identity changed.');

  const {snapshot, consent} = await readAccountAccess(controller);
  const account = snapshot.account, deposit = snapshot.directDeposit, current = consent?.current;
  requirePolicy(account && deposit && current, 'Trading account access is unavailable.');
  requirePolicy(account.chainId === String(STOCK_INCOME_CHAIN_ID) && sameAddress(account.owner, plan.owner)
    && sameAddress(account.account, plan.account), 'Trading account identity changed.');
  requirePolicy(sameAddress(deposit.token, USDG), 'The trading account deposit token is not USDG.');
  requirePolicy(sameContext(account as unknown as Record<string, unknown>, deposit as unknown as Record<string, unknown>)
    && sameContext(account as unknown as Record<string, unknown>, current.context as unknown as Record<string, unknown>),
  'The canonical account context changed.');
  requirePolicy(account.factory === controller.identity.factory
    && account.implementationHash === controller.identity.implementationHash, 'The trading account implementation changed.');
  requirePolicy(!account.accountRegistered || account.canOpen, 'Account open access is unavailable.');
  const observed = uint(account.blockTimestamp, 'The account chain time is invalid.');
  const wall = BigInt(now);
  requirePolicy(observed >= wall - CONTEXT_MAX_AGE_SECONDS && observed <= wall + CONTEXT_FUTURE_TOLERANCE_SECONDS,
    'The account chain context is stale.');
  requirePolicy(/^0x[0-9a-f]{64}$/.test(account.blockHash) && uint(account.blockNumber, 'The account block is invalid.') > 0n,
    'The account block is invalid.');

  const prepared = current.preparation?.session;
  requirePolicy(prepared?.sessionId === selected.sessionId, 'The selected trading session changed.');
  requirePolicy(current.resolution === null && current.keyStatus === 'available', 'The local trading approval is invalid.');
  requirePolicy(account.sessions.length === 1 && account.sessions[0].sessionId === selected.sessionId,
    'The selected trading session is absent from the account context.');
  const state = account.sessions[0], grant = selected.grant;
  requirePolicy(!state.revoked && grant.epoch === account.epoch, 'The trading session is revoked or from an old epoch.');
  const validAfter = uint(grant.validAfter, 'The trading session expiry is invalid.');
  const validUntil = uint(grant.validUntil, 'The trading session expiry is invalid.');
  requirePolicy(observed >= validAfter && validUntil - observed >= MIN_SESSION_REMAINING_SECONDS
    && validUntil - wall >= MIN_SESSION_REMAINING_SECONDS, 'The trading session expiry is too close.');
  const strategies = uint(grant.strategies, 'The trading strategy permission is invalid.');
  requirePolicy((strategies & (1n << STRATEGY_SELL_CALL_SPREAD)) !== 0n,
    'Trading strategy 6 is not permitted.');
  const underlyings = grant.underlyings;
  requirePolicy(Array.isArray(underlyings) && underlyings.every(value => typeof value === 'string'),
    'The stock asset permission is invalid.');
  const assets = underlyings as string[];
  requirePolicy(assets.length === 0 || assets.includes(String(market.index)), 'The stock asset is outside the trading permission.');
  requirePolicy(amount <= uint(grant.maxAmountPerOpen, 'The per-open budget is invalid.'),
    'The per-open amount budget is insufficient.');
  requirePolicy(uint(state.amountSpent, 'The cumulative amount budget is invalid.') + amount
    <= uint(grant.maxAmount, 'The cumulative amount budget is invalid.'), 'The cumulative amount budget is insufficient.');
  requirePolicy(uint(state.opens, 'The open-count budget is invalid.') < uint(grant.maxOpens, 'The open-count budget is invalid.'),
    'No sponsored opens remain.');

  const policyFee = trading.policy?.maxFeePerTrade;
  if (policyFee !== undefined) {
    const fee = uint(policyFee, 'The relay fee budget is invalid.');
    requirePolicy(fee > 0n && fee <= uint(grant.maxFeePerTrade, 'The relay fee budget is invalid.')
      && uint(state.feesSpent, 'The relay fee budget is invalid.') + fee
        <= uint(grant.maxFees, 'The relay fee budget is invalid.'), 'The relay fee budget is insufficient.');
  }

  const installed = state.installed && current.installed && current.localApprovalCurrent;
  const balance = uint(deposit.balance, 'The account USDG balance is invalid.');
  if (funded) {
    requirePolicy(installed, 'The trading grant must be installed before opening the spread.');
    requirePolicy(balance >= amount, 'The account USDG balance is insufficient.');
  } else {
    const awaitingEmptyDeposit = !state.installed && !current.installed && balance === 0n
      && current.approvalRecorded && current.awaitingDeposit && current.operationPending;
    requirePolicy(installed || awaitingEmptyDeposit,
      balance === 0n ? 'A valid trading approval is required before borrowing.'
        : 'A pending approval is valid only for an empty account.');
  }
  return {snapshot, consent, session: selected};
}

/** Refresh marks for the exact saved legs; strategy selection never changes here. */
export function refreshSpread(saved: Spread, market: OptionsMarketItem, sourceAt: number,
  pricePolicy: 'preserve' | 'review' = 'preserve'): Spread {
  const now = Math.floor(Date.now() / 1_000);
  assertFreshSource(sourceAt, now);
  requirePolicy(saved.expiry > now && market.expiries.includes(saved.expiry), 'The saved spread expiry is unavailable.');
  const calls = market.options[String(saved.expiry)]?.call;
  requirePolicy(Array.isArray(calls), 'The saved spread legs are no longer listed.');
  const locate = (id: string) => calls.filter(option => option.optionId.toLowerCase() === id.toLowerCase());
  const shortMatches = locate(saved.short.optionId), longMatches = locate(saved.long.optionId);
  requirePolicy(shortMatches.length === 1 && longMatches.length === 1, 'The saved spread legs are no longer listed.');
  const short = shortMatches[0], long = longMatches[0];
  requirePolicy(short.isOptionAvailable && long.isOptionAvailable, 'A saved spread leg is unavailable.');
  requirePolicy(new BN(String(short.strikePrice)).eq(saved.short.strikePrice)
    && new BN(String(long.strikePrice)).eq(saved.long.strikePrice), 'A saved spread strike changed.');
  const width = new BN(String(saved.long.strikePrice)).minus(String(saved.short.strikePrice));
  const previous = new BN(String(saved.short.markPrice)).minus(String(saved.long.markPrice));
  const premium = new BN(String(short.markPrice)).minus(String(long.markPrice));
  requirePolicy(width.isFinite() && width.gt(0) && width.eq(saved.width)
    && previous.isFinite() && previous.gt(0) && previous.eq(saved.premium), 'The saved spread economics are invalid.');
  requirePolicy(premium.isFinite() && premium.gt(0) && premium.lt(width), 'A positive refreshed premium is unavailable.');
  if (pricePolicy !== 'review') requirePolicy(premium.times(100).gt(previous.times(95)), 'The refreshed premium worsened by 5% or more.');
  return {...saved,
    short: {...short, optionId: saved.short.optionId, strikePrice: saved.short.strikePrice},
    long: {...long, optionId: saved.long.optionId, strikePrice: saved.long.strikePrice},
    width: width.toFixed(), premium: premium.toFixed(), sourceAt};
}
