import {test} from 'node:test';
import assert from 'node:assert/strict';
import {concatHex,encodeFunctionData,decodeFunctionData, erc20Abi, parseEther, zeroAddress, zeroHash, type PublicClient} from 'viem';
import {Attribution} from 'ox/erc8021';
import PositionManagerAbi from '../_shared/abis/PositionManager.json';
import {CONTRACT_ADDRESSES, SupportedChains} from '../_shared';
import {STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import {EXECUTION_FEE} from '../utils/constants';
import type {TradeRoute} from '../utils/tradeRoutePolicy';
import type {IncomePlan} from './workflow';
import {assertWalletPlan, readPositionOrder, readWalletOrder, walletApprovalTransaction, walletOrderTransaction} from './walletOrder';

const owner = '0x1111111111111111111111111111111111111111' as const;
const other = '0x2222222222222222222222222222222222222222' as const;
const hash = `0x${'a'.repeat(64)}` as const;
const requestId = `0x${'b'.repeat(64)}` as const;
const requestTopic = '0xd829e644f4628ea23643d25cad533269af97d942cfa01b92b5cea1769b99600a' as const;
const market = STOCK_INCOME_MARKETS[0];
const now = 10_000;
const short = `0x${'1'.repeat(64)}` as const;
const long = `0x${'2'.repeat(64)}` as const;
const plan = {
  id: 'wallet-plan', chainId: 4663, owner, account: owner, fundingMode: 'wallet', marketId: market.id,
  createdBlock: '100', quantity: '1', multiplier: '1',
  spread: {symbol: market.symbol, expiry: 20_000, short: {optionId: short, isOptionAvailable: true, strikePrice: '100', markPrice: '5'},
    long: {optionId: long, isOptionAvailable: true, strikePrice: '110', markPrice: '2'}, width: '10', premium: '3', sourceAt: now - 10},
  quote: {amount: '10000000', size: '1000000000000000000', minSize: '995000000000000000', fee: '10000', price: '3',
    optionTokenId: '987', quotedAt: now - 10, expiry: 20_000, target: '1000000000000000000', premiumAmount: '3000000'},
} as IncomePlan;
const route: TradeRoute = {kind: 'wallet', walletOpenAllowed: true, owner, tradeAddress: owner,
  snapshot: null, isResolving: false, canOpen: true};

test('wallet validation requires the explicit wallet route, same owner/custodian, fresh canonical plan and balance', () => {
  assert.doesNotThrow(() => assertWalletPlan(route, plan, 10_000_000n, now));
  assert.throws(() => assertWalletPlan({...route, walletOpenAllowed: undefined}, plan, undefined, now), /wallet route/i);
  assert.throws(() => assertWalletPlan({...route, kind: 'account'}, plan, undefined, now), /wallet route/i);
  assert.throws(() => assertWalletPlan({...route, tradeAddress: other}, plan, undefined, now), /identity/i);
  assert.throws(() => assertWalletPlan(route, {...plan, account: other}, undefined, now), /identity/i);
  assert.throws(() => assertWalletPlan(route, {...plan, fundingMode: 'account'}, undefined, now), /funding mode/i);
  assert.throws(() => assertWalletPlan(route, {...plan, quote: {...plan.quote, quotedAt: now - 151}}, undefined, now), /quote is stale/i);
  assert.throws(() => assertWalletPlan(route, {...plan, spread: {...plan.spread, sourceAt: now - 151}}, undefined, now), /market data is stale/i);
  assert.throws(() => assertWalletPlan(route, {...plan, quote: {...plan.quote, expiry: plan.quote.expiry + 1}}, undefined, now), /expiry/i);
  assert.throws(() => assertWalletPlan(route, {...plan, spread: {...plan.spread, symbol: 'TSLA'}}, undefined, now), /market/i);
  assert.throws(() => assertWalletPlan(route, plan, 9_999_999n, now), /balance/i);
});

test('wallet approval and open encode the exact canonical Robinhood transactions', () => {
  const approval = walletApprovalTransaction(plan);
  assert.equal(approval.to, USDG); assert.equal(approval.value, 0n);
  assert.deepEqual(decodeFunctionData({abi: erc20Abi, data: approval.data}), {
    functionName: 'approve', args: [CONTRACT_ADDRESSES[SupportedChains.Robinhood].CONTROLLER, 10_000_000n],
  });

  const order = walletOrderTransaction(plan);
  assert.equal(order.to, CONTRACT_ADDRESSES[SupportedChains.Robinhood].POSITION_MANAGER);
  assert.equal(order.value, parseEther(EXECUTION_FEE));
  const decoded = decodeFunctionData({abi: PositionManagerAbi, data: order.data});
  assert.equal(decoded.functionName, 'createOpenPosition');
  assert.deepEqual(decoded.args, [market.index, 2, [false, true, false, false], [short, long, zeroHash, zeroHash],
    [true, true, false, false], 995_000_000_000_000_000n, [USDG], 10_000_000n, 0n, zeroAddress]);
});

function orderClient(overrides: Record<string, unknown> = {}) {
  const order = walletOrderTransaction(plan);
  const calls: Array<{address?: string; functionName?: string; args?: readonly unknown[]}> = [];
  const request = [owner, market.index, BigInt(plan.quote.expiry), BigInt(plan.quote.optionTokenId),
    BigInt(plan.quote.minSize), BigInt(plan.quote.amount), 0n, false, 10_001n, 0, 0n, 0n, 0n, 0n] as const;
  const client = {
    async getChainId() {return 4663;},
    async getTransaction() {return {from: owner, to: order.to, input: order.data, value: order.value, chainId: 4663, blockNumber: 101n};},
    async waitForTransactionReceipt() {return {status: 'success', transactionHash: hash, blockNumber: 101n,
      logs: [{address: order.to, topics: [requestTopic, zeroHash, requestId]}]};},
    async readContract(input: {address?: string; functionName?: string; args?: readonly unknown[]}) {calls.push(input); return request;},
    ...overrides,
  };
  return {client, calls, request};
}

test('account order recovery authenticates a filled request whose account differs from its owner',async()=>{
  const accountPlan={...plan,account:other,fundingMode:'account'} as IncomePlan;
  const calls: Array<{address?: string;functionName?: string;args?: readonly unknown[]}>=[];
  const client={async getChainId(){return 4663;},async readContract(input: {address?: string;functionName?: string;args?: readonly unknown[]}){
    calls.push(input); return [other,market.index,BigInt(plan.quote.expiry),BigInt(plan.quote.optionTokenId),BigInt(plan.quote.minSize),
      BigInt(plan.quote.amount),0n,false,10_001n,2,1_001_000_000_000_000_000n,3n,10_123n,3_100_000n];}};
  assert.deepEqual(await readPositionOrder(client as unknown as PublicClient,accountPlan,requestId),{
    status:'filled',requestId,fill:{size:'1001000000000000000',premium:'3100000',filledAt:10_123},
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].address,CONTRACT_ADDRESSES[SupportedChains.Robinhood].POSITION_MANAGER);
  assert.equal(calls[0].functionName,'openPositionRequests');
  assert.deepEqual(calls[0].args,[requestId]);
});

test('account order recovery rejects every mismatched canonical request field',async()=>{
  const accountPlan={...plan,account:other,fundingMode:'account'} as IncomePlan;
  const canonical=[other,market.index,BigInt(plan.quote.expiry),BigInt(plan.quote.optionTokenId),BigInt(plan.quote.minSize),
    BigInt(plan.quote.amount),0n,false,10_001n,0,0n,0n,0n,0n];
  for(const [index,value] of [[0,owner],[1,market.index+1],[2,BigInt(plan.quote.expiry)+1n],
    [3,BigInt(plan.quote.optionTokenId)+1n],[4,BigInt(plan.quote.minSize)+1n],[5,BigInt(plan.quote.amount)+1n]] as const){
    const request=[...canonical]; request[index]=value;
    const client={async getChainId(){return 4663;},async readContract(){return request;}};
    await assert.rejects(()=>readPositionOrder(client as unknown as PublicClient,accountPlan,requestId),/request does not match/i);
  }
});

test('wallet order recovery authenticates the transaction, receipt, manager event and exact request', async () => {
  const pending = orderClient();
  assert.deepEqual(await readWalletOrder(pending.client as unknown as PublicClient, plan, hash, 100n), {status: 'pending', requestId});
  assert.equal(pending.calls.length, 1);
  assert.equal(pending.calls[0].address, CONTRACT_ADDRESSES[SupportedChains.Robinhood].POSITION_MANAGER);
  assert.equal(pending.calls[0].functionName, 'openPositionRequests');
  assert.deepEqual(pending.calls[0].args, [requestId]);

  const filled = orderClient({async readContract() {return [...pending.request.slice(0, 9), 2,
    1_001_000_000_000_000_000n, 3n, 10_123n, 3_100_000n];}});
  assert.deepEqual(await readWalletOrder(filled.client as unknown as PublicClient, plan, hash), {
    status: 'filled', requestId, fill: {size: '1001000000000000000', premium: '3100000', filledAt: 10_123},
  });
  const failed = orderClient({async readContract() {return [...pending.request.slice(0, 9), 1, ...pending.request.slice(10)];}});
  assert.deepEqual(await readWalletOrder(failed.client as unknown as PublicClient, plan, hash), {status: 'failed', requestId});
});

test('filled wallet recovery rejects missing or invalid authenticated execution values', async () => {
  const base = [...orderClient().request.slice(0, 9), 2, 1n, 3n, 10_123n, 3_100_000n];
  for (const [index, value] of [[10, 0n], [10, undefined], [12, 0n], [12, undefined], [13, -1], [13, undefined]] as const) {
    const request = [...base]; request[index] = value;
    const recovered = orderClient({async readContract() {return request;}});
    await assert.rejects(() => readWalletOrder(recovered.client as unknown as PublicClient, plan, hash), /wallet order (size|fill time|premium) is invalid/i);
  }
});

test('recovery matches the actual writer ERC-8021 calldata suffix exactly',async()=>{
  const bare=encodeFunctionData({abi:PositionManagerAbi,functionName:'createOpenPosition',args:[market.index,2,
    [false,true,false,false],[short,long,zeroHash,zeroHash],[true,true,false,false],BigInt(plan.quote.minSize),[USDG],BigInt(plan.quote.amount),0n,zeroAddress]});
  const suffix=Attribution.toDataSuffix({codes:['bc_pjqd8vwg']});
  const input=concatHex([bare,suffix]);
  const broadcast=orderClient({async getTransaction(){return {...await orderClient().client.getTransaction(),input};}});
  assert.deepEqual(await readWalletOrder(broadcast.client as unknown as PublicClient,plan,hash),{status:'pending',requestId});
  for(const wrong of [bare,concatHex([input,'0x00']),input.slice(0,-2)+'00']) {
    const invalid=orderClient({async getTransaction(){return {...await orderClient().client.getTransaction(),input:wrong};}});
    await assert.rejects(()=>readWalletOrder(invalid.client as unknown as PublicClient,plan,hash),/does not match/i);
  }
});

test('a reverted receipt alone is failed; absent or unrelated canonical evidence stays unknown by throwing', async () => {
  const reverted = orderClient({async waitForTransactionReceipt() {return {status: 'reverted', transactionHash: hash, blockNumber: 101n, logs: []};}});
  assert.deepEqual(await readWalletOrder(reverted.client as unknown as PublicClient, plan, hash), {status: 'failed'});

  const noEvent = orderClient({async waitForTransactionReceipt() {return {status: 'success', transactionHash: hash, blockNumber: 101n, logs: []};}});
  await assert.rejects(() => readWalletOrder(noEvent.client as unknown as PublicClient, plan, hash), /request event/i);
  const otherManager = orderClient({async waitForTransactionReceipt() {return {status: 'success', transactionHash: hash, blockNumber: 101n,
    logs: [{address: other, topics: [requestTopic, zeroHash, requestId]}]};}});
  await assert.rejects(() => readWalletOrder(otherManager.client as unknown as PublicClient, plan, hash), /request event/i);
  const unknownKeeper = orderClient({async readContract() {return [...orderClient().request.slice(0, 9), 3, ...orderClient().request.slice(10)];}});
  await assert.rejects(() => readWalletOrder(unknownKeeper.client as unknown as PublicClient, plan, hash), /request status/i);
});

test('recovery rejects wrong chain, sender, calldata, receipt identity/block and mismatched request fields', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{async getChainId() {return 1;}}, /Robinhood Chain/i],
    [{async getTransaction() {const tx = await orderClient().client.getTransaction(); return {...tx, from: other};}}, /does not match/i],
    [{async getTransaction() {const tx = await orderClient().client.getTransaction(); return {...tx, to: other};}}, /does not match/i],
    [{async getTransaction() {const tx = await orderClient().client.getTransaction(); return {...tx, input: '0x1234'};}}, /does not match/i],
    [{async getTransaction() {const tx = await orderClient().client.getTransaction(); return {...tx, value: tx.value + 1n};}}, /does not match/i],
    [{async waitForTransactionReceipt() {return {status: 'success', transactionHash: requestId, blockNumber: 101n, logs: []};}}, /replaced/i],
    [{async waitForTransactionReceipt() {return {status: 'success', transactionHash: hash, blockNumber: 99n, logs: []};}}, /predates/i],
    [{async readContract() {return [other, market.index, BigInt(plan.quote.expiry), BigInt(plan.quote.optionTokenId), BigInt(plan.quote.minSize), BigInt(plan.quote.amount), 0n, false, 1n, 0, 0n, 0n, 0n, 0n];}}, /request does not match/i],
    [{async readContract() {return [owner, market.index + 1, BigInt(plan.quote.expiry), BigInt(plan.quote.optionTokenId), BigInt(plan.quote.minSize), BigInt(plan.quote.amount), 0n, false, 1n, 0, 0n, 0n, 0n, 0n];}}, /request does not match/i],
    [{async readContract() {return [owner, market.index, BigInt(plan.quote.expiry) + 1n, BigInt(plan.quote.optionTokenId), BigInt(plan.quote.minSize), BigInt(plan.quote.amount), 0n, false, 1n, 0, 0n, 0n, 0n, 0n];}}, /request does not match/i],
    [{async readContract() {return [owner, market.index, BigInt(plan.quote.expiry), BigInt(plan.quote.optionTokenId) + 1n, BigInt(plan.quote.minSize), BigInt(plan.quote.amount), 0n, false, 1n, 0, 0n, 0n, 0n, 0n];}}, /request does not match/i],
    [{async readContract() {return [owner, market.index, BigInt(plan.quote.expiry), BigInt(plan.quote.optionTokenId), BigInt(plan.quote.minSize) + 1n, BigInt(plan.quote.amount), 0n, false, 1n, 0, 0n, 0n, 0n, 0n];}}, /request does not match/i],
    [{async readContract() {return [owner, market.index, BigInt(plan.quote.expiry), BigInt(plan.quote.optionTokenId), BigInt(plan.quote.minSize), BigInt(plan.quote.amount) + 1n, 0n, false, 1n, 0, 0n, 0n, 0n, 0n];}}, /request does not match/i],
  ];
  for (const [overrides, message] of cases) {
    await assert.rejects(() => readWalletOrder(orderClient(overrides).client as unknown as PublicClient, plan, hash, 100n), message);
  }
});
