import {concatHex, encodeFunctionData, erc20Abi, parseEther, zeroAddress, zeroHash,
  type Abi, type Address, type Hex, type PublicClient} from 'viem';
import PositionManagerAbi from '../_shared/abis/PositionManager.json';
import {CONTRACT_ADDRESSES, SupportedChains} from '../_shared';
import {STOCK_INCOME_CHAIN_ID, STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import {BN} from '../utils/bn';
import {EXECUTION_FEE} from '../utils/constants';
import {DATA_SUFFIX} from '../utils/transactionAttribution';
import type {TradeRoute} from '../utils/tradeRoutePolicy';
import {assertFreshSource} from './strategy';
import {verifyReceiptTransaction} from './wallet';
import type {LendingTransaction} from './morpho';
import type {IncomePlan} from './workflow';

const QUOTE_MAX_AGE_SECONDS = 150;
const REQUEST_EVENT_TOPIC = '0xd829e644f4628ea23643d25cad533269af97d942cfa01b92b5cea1769b99600a';
const addresses = CONTRACT_ADDRESSES[SupportedChains.Robinhood];
const CONTROLLER = addresses.CONTROLLER as Address;
const POSITION_MANAGER = addresses.POSITION_MANAGER as Address;

export interface PositionOrderResult {
  status: 'pending' | 'filled' | 'failed';
  requestId?: string;
  fill?: {size: string; premium: string; filledAt: number};
}

const sameAddress = (left: unknown, right: unknown) =>
  typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();

function uint(value: unknown, label: string, positive = true): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`The ${label} is invalid.`);
  const decimal = new BN(value);
  if (!decimal.isFinite() || !decimal.isInteger() || (positive ? !decimal.gt(0) : decimal.lt(0))) {
    throw new Error(`The ${label} is invalid.`);
  }
  return BigInt(value);
}

function requestUint(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' && typeof value !== 'number') throw new Error(`The wallet order ${label} is invalid.`);
  const result = BigInt(value);
  if (result < 0n) throw new Error(`The wallet order ${label} is invalid.`);
  return result;
}

function assertWalletIdentity(plan: IncomePlan) {
  if (plan.chainId !== STOCK_INCOME_CHAIN_ID) throw new Error('Select Robinhood Chain.');
  if (plan.fundingMode !== 'wallet') throw new Error('The strategy funding mode is not wallet.');
  if (!sameAddress(plan.owner, plan.account)) throw new Error('The wallet strategy identity changed.');
}

function planMarket(plan: IncomePlan) {
  const market = STOCK_INCOME_MARKETS.find(candidate => candidate.id.toLowerCase() === plan.marketId.toLowerCase());
  if (!market || market.symbol !== plan.spread.symbol) throw new Error('The stock market route changed.');
  return market;
}

export function assertWalletPlan(route: TradeRoute, plan: IncomePlan, balance?: bigint,
  now = Math.floor(Date.now() / 1_000)): void {
  if (route.kind !== 'wallet' || route.walletOpenAllowed !== true || route.isResolving || !route.canOpen) {
    throw new Error('The explicit wallet route is not available.');
  }
  assertWalletIdentity(plan);
  if (!sameAddress(route.owner, plan.owner) || !sameAddress(route.tradeAddress, plan.account)) {
    throw new Error('The wallet strategy identity changed.');
  }
  planMarket(plan);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('The wallet strategy time is invalid.');
  if (!Number.isSafeInteger(plan.quote.expiry) || plan.quote.expiry !== plan.spread.expiry
    || plan.quote.expiry <= now) throw new Error('The spread expiry is no longer valid.');
  assertFreshSource(plan.spread.sourceAt, now);
  if (!Number.isSafeInteger(plan.quote.quotedAt) || plan.quote.quotedAt <= 0 || plan.quote.quotedAt > now
    || now - plan.quote.quotedAt > QUOTE_MAX_AGE_SECONDS) throw new Error('The funding quote is stale.');
  const amount = uint(plan.quote.amount, 'funding amount');
  uint(plan.quote.minSize, 'minimum order size');
  uint(plan.quote.optionTokenId, 'option token');
  if (balance !== undefined && (balance < 0n || balance < amount)) throw new Error('The wallet USDG balance is insufficient.');
}

export function walletApprovalTransaction(plan: IncomePlan): LendingTransaction {
  assertWalletIdentity(plan);
  const amount = uint(plan.quote.amount, 'funding amount');
  return {to: USDG, value: 0n,
    data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [CONTROLLER, amount]})};
}

export function walletOrderTransaction(plan: IncomePlan): LendingTransaction {
  assertWalletIdentity(plan);
  const market = planMarket(plan);
  const amount = uint(plan.quote.amount, 'funding amount');
  const minSize = uint(plan.quote.minSize, 'minimum order size');
  const optionIds = [plan.spread.short.optionId, plan.spread.long.optionId, zeroHash, zeroHash] as const;
  if (!optionIds.slice(0, 2).every(value => /^0x[0-9a-fA-F]{64}$/.test(value))) {
    throw new Error('The wallet order option legs are invalid.');
  }
  return {to: POSITION_MANAGER, value: parseEther(EXECUTION_FEE),
    data: concatHex([encodeFunctionData({abi: PositionManagerAbi as Abi, functionName: 'createOpenPosition',
      args: [market.index, 2, [false, true, false, false], optionIds, [true, true, false, false],
        minSize, [USDG], amount, 0n, zeroAddress]}),DATA_SUFFIX])};
}

export async function readPositionOrder(client: PublicClient, plan: IncomePlan,
  requestId: Hex): Promise<PositionOrderResult> {
  if (await client.getChainId() !== STOCK_INCOME_CHAIN_ID) throw new Error('Select Robinhood Chain.');
  const request = await client.readContract({address: POSITION_MANAGER, abi: PositionManagerAbi,
    functionName: 'openPositionRequests', args: [requestId]}) as readonly unknown[];
  if (!Array.isArray(request) || request.length < 10) throw new Error('The wallet order request is unavailable.');
  const market = planMarket(plan);
  const matches = sameAddress(request[0], plan.account)
    && requestUint(request[1], 'market index') === BigInt(market.index)
    && requestUint(request[2], 'expiry') === BigInt(plan.quote.expiry)
    && requestUint(request[3], 'option token') === uint(plan.quote.optionTokenId, 'option token')
    && requestUint(request[4], 'minimum size') === uint(plan.quote.minSize, 'minimum order size')
    && requestUint(request[5], 'amount') === uint(plan.quote.amount, 'funding amount');
  if (!matches) throw new Error('The wallet order request does not match this strategy.');
  const status = requestUint(request[9], 'request status');
  if (status === 0n) return {status: 'pending', requestId};
  if (status === 1n) return {status: 'failed', requestId};
  if (status === 2n) {
    const size = requestUint(request[10], 'size');
    const fillTime = requestUint(request[12], 'fill time');
    const premium = requestUint(request[13], 'premium');
    const filledAt = Number(fillTime);
    if (size === 0n) throw new Error('The wallet order size is invalid.');
    if (fillTime === 0n || !Number.isSafeInteger(filledAt)) throw new Error('The wallet order fill time is invalid.');
    return {status: 'filled', requestId, fill: {size: size.toString(), premium: premium.toString(), filledAt}};
  }
  throw new Error('The wallet order request status is invalid.');
}

export async function readWalletOrder(client: PublicClient, plan: IncomePlan, hash: Hex,
  minimumBlock?: bigint): Promise<PositionOrderResult> {
  if (await client.getChainId() !== STOCK_INCOME_CHAIN_ID) throw new Error('Select Robinhood Chain.');
  const expected = walletOrderTransaction(plan);
  const transaction = await client.getTransaction({hash});
  verifyReceiptTransaction(transaction, plan.owner, expected, minimumBlock);
  const receipt = await client.waitForTransactionReceipt({hash, confirmations: 2, timeout: 30_000});
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error('Transaction was replaced. Reconcile the original operation.');
  }
  if (minimumBlock !== undefined && receipt.blockNumber < minimumBlock) {
    throw new Error('Receipt predates this strategy.');
  }
  if (receipt.status === 'reverted') return {status: 'failed'};

  const events = receipt.logs.filter(log => sameAddress(log.address, POSITION_MANAGER)
    && log.topics[0]?.toLowerCase() === REQUEST_EVENT_TOPIC
    && typeof log.topics[2] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(log.topics[2]));
  if (events.length !== 1) throw new Error('The wallet order request event is unavailable or ambiguous.');
  const requestId = events[0].topics[2] as Hex;
  return readPositionOrder(client, plan, requestId);
}
