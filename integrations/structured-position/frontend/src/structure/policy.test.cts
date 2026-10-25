import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Address} from 'viem';
import type {OptionsMarketItem} from '../_shared/types/mark-iv-price';
import {STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import type {IncomePlan} from './workflow';
import type {Spread} from './strategy';
import {assertAccountReady, refreshSpread} from './policy';

const owner = '0x1111111111111111111111111111111111111111' as Address;
const account = '0x2222222222222222222222222222222222222222' as Address;
const factory = '0x3333333333333333333333333333333333333333';
const implementation = '0x4444444444444444444444444444444444444444';
const implementationHash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const sessionId = `0x${'c'.repeat(64)}`;
const marketConfig = STOCK_INCOME_MARKETS[0];
const expiry = 5_000;
const option = (strikePrice: number, markPrice: number, n: number, isOptionAvailable = true) => ({
  optionId: `0x${n.toString(16).padStart(64, '0')}`, strikePrice, markPrice, markIv: .5,
  riskPremiumRateForBuy: 0, riskPremiumRateForSell: 0, delta: 0, gamma: 0,
  vega: 0, theta: 0, volume: 1, isOptionAvailable,
});
const spread: Spread = {symbol: 'NVDA', expiry, short: option(105, 5, 1), long: option(130, 1, 2),
  width: '25', premium: '4', sourceAt: 1_000};
const plan: IncomePlan = {id: 'plan', chainId: 4663, owner, account, marketId: marketConfig.id,
  createdBlock:'1', quantity: '1', multiplier: '1', spread,
  quote: {amount: '10000000', size: '1000000000000000000', minSize: '995000000000000000',
    fee: '100000', price: '4000000000000000000000000000000', optionTokenId: '1',
    quotedAt: 1_000, expiry, target: '1000000000000000000',premiumAmount:'4000000'}};

function access(overrides: {installed?: boolean; approvalRecorded?: boolean; awaitingDeposit?: boolean;
  operationPending?: boolean; balance?: string; chainId?: string; owner?: string; account?: string; token?: string;
  blockTimestamp?: string; accountRegistered?: boolean; canOpen?: boolean; strategies?: string;
  underlyings?: string[]; amountSpent?: string; maxAmountPerOpen?: string; maxAmount?: string;
  opens?: string; maxOpens?: string; feesSpent?: string; maxFees?: string; maxFeePerTrade?: string;
  validUntil?: string; localApprovalCurrent?: boolean} = {}) {
  const installed = overrides.installed ?? true;
  const identity = {chainId: overrides.chainId ?? '4663', owner: overrides.owner ?? owner,
    account: overrides.account ?? account, factory, implementationHash, token: overrides.token ?? USDG};
  const grant = {epoch: '1', validAfter: '900', validUntil: overrides.validUntil ?? '4000',
    strategies: overrides.strategies ?? '64', underlyings: overrides.underlyings ?? [String(marketConfig.index)],
    maxAmountPerOpen: overrides.maxAmountPerOpen ?? '20000000', maxAmount: overrides.maxAmount ?? '50000000',
    maxOpens: overrides.maxOpens ?? '2', maxFeePerTrade: overrides.maxFeePerTrade ?? '1000',
    maxFees: overrides.maxFees ?? '3000'};
  const session = {identity: {chainId: identity.chainId, owner: identity.owner, account: identity.account},
    sessionId, grant};
  const state = {sessionId, installed, revoked: false, opens: overrides.opens ?? '0', closes: '0',
    amountSpent: overrides.amountSpent ?? '0', feesSpent: overrides.feesSpent ?? '0'};
  const context = {chainId: identity.chainId, owner: identity.owner, account: identity.account,
    factory, implementation, implementationHash, epoch: '1', accountRegistered: overrides.accountRegistered ?? true,
    canOpen: overrides.canOpen ?? true, blockNumber: '100', blockHash,
    blockTimestamp: overrides.blockTimestamp ?? '1000', sessions: [state]};
  const directDeposit = {...context, token: identity.token, balance: overrides.balance ?? (installed ? '10000000' : '0'),
    canActivate: false};
  const current = {preparation: {session}, context, resolution: null, keyStatus: 'available',
    operationState: overrides.operationPending === false ? null : 'queued',
    operationPending: overrides.operationPending ?? !installed,
    approvalRecorded: overrides.approvalRecorded ?? true,
    awaitingDeposit: overrides.awaitingDeposit ?? !installed,
    installed, localApprovalCurrent: overrides.localApprovalCurrent ?? installed};
  const snapshot = {account: context, directDeposit, grants: []};
  const seen: string[][] = [];
  const controller = {identity, async refresh(ids: string[]) {seen.push(ids); return snapshot;},
    trading: {policy: {maxFeePerTrade: '1000'}, selectedSession: () => session,
      async observeState(value: unknown) {assert.equal(value, snapshot); return {current, queue: {pending: [], hasMore: false}};}}};
  return {controller, seen};
}

test('permits borrowing with either an installed grant or a recorded approval awaiting the empty deposit', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const installed = access();
  await assert.doesNotReject(() => assertAccountReady(installed.controller as any, plan, false));
  assert.deepEqual(installed.seen, [[sessionId]]);
  const awaiting = access({installed: false, balance: '0', approvalRecorded: true, awaitingDeposit: true});
  await assert.doesNotReject(() => assertAccountReady(awaiting.controller as any, plan, false));
});

test('funded readiness requires the installed local grant and enough account USDG', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  await assert.doesNotReject(() => assertAccountReady(access({balance: plan.quote.amount}).controller as any, plan, true));
  await assert.rejects(() => assertAccountReady(access({installed: false, balance: plan.quote.amount}).controller as any,
    plan, true), /installed/i);
  await assert.rejects(() => assertAccountReady(access({balance: '9999999'}).controller as any,
    plan, true), /USDG balance/i);
});

test('rejects identity, token, stale-chain and safe-mode context changes', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  await assert.rejects(() => assertAccountReady(access({chainId: '8453'}).controller as any, plan, false), /Robinhood/i);
  await assert.rejects(() => assertAccountReady(access({owner: '0x5555555555555555555555555555555555555555'}).controller as any,
    plan, false), /identity/i);
  await assert.rejects(() => assertAccountReady(access({token: '0x6666666666666666666666666666666666666666'}).controller as any,
    plan, false), /USDG/i);
  await assert.rejects(() => assertAccountReady(access({blockTimestamp: '699'}).controller as any, plan, false), /stale/i);
  await assert.rejects(() => assertAccountReady(access({accountRegistered: true, canOpen: false}).controller as any,
    plan, false), /open/i);
});

test('rejects grants outside strategy, asset, amount, open, expiry or relay-fee budgets', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const cases: Array<[string, Parameters<typeof access>[0]]> = [
    ['strategy', {strategies: '32'}], ['asset', {underlyings: ['3']}],
    ['per-open', {maxAmountPerOpen: '9999999'}], ['cumulative', {amountSpent: '45000000'}],
    ['open', {opens: '2'}], ['expiry', {validUntil: '1029'}],
    ['fee', {feesSpent: '2501', maxFees: '3000'}],
  ];
  for (const [message, override] of cases) {
    await assert.rejects(() => assertAccountReady(access(override).controller as any, plan, false),
      new RegExp(message, 'i'));
  }
});

test('pre-borrow pending permission must be recorded for an empty account', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  await assert.rejects(() => assertAccountReady(access({installed: false, approvalRecorded: false}).controller as any,
    plan, false), /approval/i);
  await assert.rejects(() => assertAccountReady(access({installed: false, balance: '1'}).controller as any,
    plan, false), /empty account/i);
});

function optionMarket(calls: ReturnType<typeof option>[]): OptionsMarketItem {
  return {expiries: [expiry], options: {[String(expiry)]: {call: calls, put: []}}};
}

test('refreshes only the saved legs and accepts less than 5% premium worsening', t => {
  t.mock.method(Date, 'now', () => 1_100_000);
  const refreshed = refreshSpread(spread, optionMarket([option(130, 1, 2), option(105, 4.81, 1), option(115, 9, 3)]), 1_100);
  assert.equal(refreshed.short.optionId, spread.short.optionId);
  assert.equal(refreshed.long.optionId, spread.long.optionId);
  assert.equal(refreshed.short.strikePrice, spread.short.strikePrice);
  assert.equal(refreshed.long.strikePrice, spread.long.strikePrice);
  assert.equal(refreshed.expiry, spread.expiry);
  assert.equal(refreshed.premium, '3.81');
  assert.equal(refreshed.sourceAt, 1_100);
});

test('refresh rejects stale sources, missing/changed/unavailable legs and 5% worsening', t => {
  t.mock.method(Date, 'now', () => 1_200_000);
  const current = 1_100;
  assert.throws(() => refreshSpread(spread, optionMarket([option(105, 5, 1), option(130, 1, 2)]), 1_049), /stale/i);
  assert.throws(() => refreshSpread(spread, optionMarket([option(105, 5, 1)]), current), /listed/i);
  assert.throws(() => refreshSpread(spread, optionMarket([option(106, 5, 1), option(130, 1, 2)]), current), /strike/i);
  assert.throws(() => refreshSpread(spread, optionMarket([option(105, 5, 1, false), option(130, 1, 2)]), current), /unavailable/i);
  assert.throws(() => refreshSpread(spread, optionMarket([option(105, 4.8, 1), option(130, 1, 2)]), current), /5%/i);
  assert.throws(() => refreshSpread(spread, optionMarket([option(105, 1, 1), option(130, 1, 2)]), current), /positive/i);
});

test('explicit preborrow review can show changed premium without relaxing automatic refresh', t => {
  t.mock.method(Date, 'now', () => 1_200_000);
  const market = optionMarket([option(105, 4, 1), option(130, 1, 2)]);
  assert.throws(() => refreshSpread(spread, market, 1_100), /5%/);
  const reviewed = refreshSpread(spread, market, 1_100, 'review');
  assert.equal(reviewed.premium, '3');
  assert.equal(reviewed.short.optionId, spread.short.optionId);
  assert.equal(reviewed.long.optionId, spread.long.optionId);
});
