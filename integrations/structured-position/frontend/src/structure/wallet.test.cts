import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbiItem, parseAbiParameters, parseUnits, type PublicClient} from 'viem';
import {checkFundingPlan, fundingTransactions, managementTransaction, readFundedState, verifyReceiptTransaction} from './wallet';
import {MORPHO_ABI, type MorphoSnapshot} from './morpho';
import {MORPHO, STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import type {IncomePlan} from './workflow';
const owner = '0x1111111111111111111111111111111111111111' as const;
const account = '0x2222222222222222222222222222222222222222' as const;
const market = STOCK_INCOME_MARKETS[0];
const plan = {id:'x',chainId:4663,owner,account,marketId:market.id,quantity:'1',multiplier:'1',quote:{amount:'10000000'}} as IncomePlan;
const snapshot = {market, multiplier:10n**18n, balance:10n**18n, debt:0n, liquidity:1000000000n,
  oraclePrice:200000000000000000000000000n,position:{collateral:0n,borrowShares:0n}, usdgBalance:100000000n} as MorphoSnapshot;
const borrowHash = `0x${'a'.repeat(64)}` as const;
const receiptBlockHash = `0x${'b'.repeat(64)}` as const;
const currentBlockHash = `0x${'c'.repeat(64)}` as const;
const otherHash = `0x${'d'.repeat(64)}` as const;
const fundedPlan = {...plan,createdBlock:'100',initialBorrowShares:'7'} as IncomePlan;
const borrowEvent = parseAbiItem('event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)');
function receiptBorrow(overrides: Record<string, unknown> = {}) {
  const args = {id:fundedPlan.marketId,caller:owner,onBehalf:owner,receiver:account,assets:BigInt(fundedPlan.quote.amount),shares:2n,...overrides};
  return {address:MORPHO,blockNumber:120n,blockHash:receiptBlockHash,transactionHash:borrowHash,transactionIndex:0,logIndex:4,removed:false,
    topics:encodeEventTopics({abi:[borrowEvent],eventName:'Borrow',args:{id:args.id as typeof fundedPlan.marketId,onBehalf:args.onBehalf as typeof owner,receiver:args.receiver as typeof account}}),
    data:encodeAbiParameters(parseAbiParameters('address,uint256,uint256'),[args.caller as typeof owner,args.assets as bigint,args.shares as bigint])};
}
const receipt = (logs: unknown[] = [receiptBorrow()]) => ({status:'success',transactionHash:borrowHash,blockNumber:120n,blockHash:receiptBlockHash,logs});
function indexedLog(eventName: string, blockNumber: bigint, logIndex: number, overrides: Record<string, unknown> = {}) {
  return {address:MORPHO,eventName,args:{id:fundedPlan.marketId,...(eventName === 'Liquidate' ? {borrower:owner} : {onBehalf:owner})},
    blockNumber,blockHash:otherHash,transactionHash:otherHash,transactionIndex:0,logIndex,removed:false,...overrides};
}
type LogQuery = {address: string; event: {name: string}; args: Record<string, string>; fromBlock: bigint; toBlock: bigint};
function defaultLogs(input: LogQuery) {
  return input.event.name === 'Borrow' && input.fromBlock <= 120n && input.toBlock >= 120n
    ? [{...receiptBorrow(),eventName:'Borrow',args:{id:fundedPlan.marketId,caller:owner,onBehalf:owner,receiver:account,assets:BigInt(fundedPlan.quote.amount),shares:2n}}] : [];
}
function fundedClient(overrides: Record<string, unknown> = {}) {
  const borrow = fundingTransactions(fundedPlan).borrow;
  const reads: Array<Record<string, unknown>> = [], logQueries: LogQuery[] = [];
  const client = {
    async getChainId() {return 4663;},
    async getTransaction() {return {from:owner,to:borrow.to,input:borrow.data,value:borrow.value,chainId:4663,blockNumber:120n};},
    async waitForTransactionReceipt() {return receipt();},
    async getTransactionReceipt() {return receipt();},
    async getBlock() {return {number:20150n,hash:currentBlockHash};},
    async readContract(input: Record<string, unknown>) {
      reads.push(input); if (input.blockNumber === 120n) throw new Error('historical state 120 is not available');
      return {supplyShares:0n,borrowShares:9n,collateral:parseUnits('1',18)};
    },
    async getLogs(input: LogQuery) {logQueries.push(input); return defaultLogs(input);},
    ...overrides,
  } as unknown as PublicClient;
  return {client,reads,logQueries,borrow};
}
test('supply projection includes new collateral; borrowing requires already supplied collateral', () => {
  assert.doesNotThrow(() => checkFundingPlan(plan,snapshot,'supply'));
  assert.throws(() => checkFundingPlan(plan,snapshot,'borrow'), /health/i);
  assert.doesNotThrow(() => checkFundingPlan(plan,{...snapshot,position:{...snapshot.position,collateral:parseUnits('1',18)}},'borrow'));
  assert.throws(() => checkFundingPlan(plan,{...snapshot,multiplier:parseUnits('1.001',18)},'supply'), /multiplier/i);
  assert.throws(() => checkFundingPlan(plan,{...snapshot,position:{...snapshot.position,collateral:parseUnits('1',18),borrowShares:1n}},'borrow'), /debt|borrow/i);
});
test('repay uses borrow shares to close debt, withdrawal is allowed only after loan is zero', () => {
  const funded = {...snapshot,debt:10000001n,position:{...snapshot.position,borrowShares:1234567n,collateral:10n**18n}};
  const repay = managementTransaction('repay',funded,owner);
  assert.deepEqual(decodeFunctionData({abi:MORPHO_ABI,data:repay.tx.data}).args?.slice(1), [0n,1234567n,owner,'0x']);
  const approve = managementTransaction('approve-repay',funded,owner);
  assert.equal(approve.tx.to,USDG);
  assert.ok((decodeFunctionData({abi:erc20Abi,data:approve.tx.data}).args?.[1] as bigint) > funded.debt);
  assert.throws(() => managementTransaction('withdraw',funded,owner), /repay/i);
  assert.throws(() => managementTransaction('repay',{...funded,usdgBalance:funded.debt},owner), /interest reserve/i);
  const withdraw = managementTransaction('withdraw',{...funded,debt:0n,position:{...funded.position,borrowShares:0n}},owner);
  assert.equal(decodeFunctionData({abi:MORPHO_ABI,data:withdraw.tx.data}).functionName,'withdrawCollateral');
});
test('recovery refuses unrelated hashes even if their receipts succeeded', () => {
  const tx = {to:USDG,data:'0x1234' as const,value:0n};
  assert.doesNotThrow(() => verifyReceiptTransaction({from:owner,to:USDG,input:'0x1234',value:0n,chainId:4663},owner,tx));
  assert.throws(() => verifyReceiptTransaction({from:account,to:USDG,input:'0x1234',value:0n,chainId:4663},owner,tx), /match/i);
  assert.throws(() => verifyReceiptTransaction({from:owner,to:USDG,input:'0xabcd',value:0n,chainId:4663},owner,tx), /match/i);
  assert.throws(() => verifyReceiptTransaction({from:owner,to:USDG,input:'0x1234',value:0n,chainId:4663,blockNumber:10n},owner,tx,11n), /predates/i);
});
test('funded-state recovery uses the Borrow event plus a chunked current-position proof without historical state', async () => {
  const h = fundedClient();
  assert.deepEqual(await readFundedState(h.client,fundedPlan,borrowHash), {
    borrowShares:'9',collateral:parseUnits('1',18).toString(),block:'120',
  });
  assert.equal(h.reads.length,1);
  assert.deepEqual(h.reads[0], {address:MORPHO,abi:MORPHO_ABI,functionName:'position',args:[fundedPlan.marketId,owner],blockNumber:20150n});
  assert.equal(h.logQueries.length,15);
  for (const query of h.logQueries) {
    assert.equal(query.address,MORPHO); assert.equal(query.args.id,fundedPlan.marketId);
    assert.equal(query.args[query.event.name === 'Liquidate' ? 'borrower' : 'onBehalf'],owner);
    assert.ok(query.toBlock - query.fromBlock < 10000n);
  }
});
test('funded-state recovery rejects a mismatched borrow transaction and non-confirmed receipt', async () => {
  const base = fundedClient();
  const pending = new Error('pending'); pending.name = 'WaitForTransactionReceiptTimeoutError';
  const cases: Array<[Record<string, unknown>,RegExp]> = [
    [{async getTransaction() {return {from:account,to:base.borrow.to,input:base.borrow.data,value:0n,chainId:4663,blockNumber:120n};}},/match/i],
    [{async getTransaction() {return {from:owner,to:base.borrow.to,input:'0x1234',value:0n,chainId:4663,blockNumber:120n};}},/match/i],
    [{async getTransaction() {return {from:owner,to:base.borrow.to,input:base.borrow.data,value:0n,chainId:4663,blockNumber:99n};}},/predates/i],
    [{async waitForTransactionReceipt() {return {...receipt(),status:'reverted'};}},/confirmed/i],
    [{async waitForTransactionReceipt() {throw pending;}},/confirmed/i],
  ];
  for (const [overrides,error] of cases) await assert.rejects(() => readFundedState(fundedClient(overrides).client,fundedPlan,borrowHash),error);
});
test('funded-state recovery rechecks the canonical receipt before reading the position', async () => {
  const cases: Array<[Record<string, unknown>,RegExp]> = [
    [{async getTransactionReceipt() {return {...receipt(),transactionHash:otherHash};}},/match|replaced/i],
    [{async getTransactionReceipt() {return {...receipt(),status:'reverted'};}},/confirmed/i],
    [{async getTransactionReceipt() {return {...receipt(),blockNumber:99n};}},/predates/i],
  ];
  for (const [overrides,error] of cases) {
    const h = fundedClient(overrides);
    await assert.rejects(() => readFundedState(h.client,fundedPlan,borrowHash),error);
    assert.equal(h.reads.length,0);
  }
});
test('funded-state recovery requires exactly one matching canonical Borrow receipt event', async () => {
  const cases: Array<[unknown[],RegExp]> = [
    [[],/Borrow event/i],
    [[receiptBorrow({receiver:owner})],/Borrow event/i],
    [[receiptBorrow({assets:1n})],/Borrow event/i],
    [[receiptBorrow({shares:0n})],/Borrow event/i],
    [[receiptBorrow(),receiptBorrow()],/Borrow event/i],
    [[{...receiptBorrow(),removed:true}],/canonical|removed/i],
    [[{...receiptBorrow(),blockHash:otherHash}],/block/i],
  ];
  for (const [logs,error] of cases) {
    const h = fundedClient({async getTransactionReceipt() {return receipt(logs);}});
    await assert.rejects(() => readFundedState(h.client,fundedPlan,borrowHash),error);
    assert.equal(h.reads.length,0);
  }
});
test('funded-state recovery rejects later and same-block-after-borrow Morpho mutations', async () => {
  const mutations = [indexedLog('Repay',121n,0),indexedLog('Borrow',120n,5)];
  for (const mutation of mutations) {
    const h = fundedClient({async getLogs(input: LogQuery) {return [...defaultLogs(input),...(input.event.name === mutation.eventName ? [mutation] : [])];}});
    await assert.rejects(() => readFundedState(h.client,fundedPlan,borrowHash),/changed|mutation/i);
  }
});
test('funded-state recovery fails closed for incomplete or malformed mutation history', async () => {
  const removed = indexedLog('WithdrawCollateral',121n,0,{removed:true});
  const badHash = indexedLog('Liquidate',121n,0,{blockHash:'0x1234'});
  for (const mutation of [removed,badHash]) {
    const h = fundedClient({async getLogs(input: LogQuery) {return [...defaultLogs(input),...(input.event.name === mutation.eventName ? [mutation] : [])];}});
    await assert.rejects(() => readFundedState(h.client,fundedPlan,borrowHash),/log|canonical|hash/i);
  }
  const unavailable = fundedClient({async getLogs() {throw new Error('log history unavailable');}});
  await assert.rejects(() => readFundedState(unavailable.client,fundedPlan,borrowHash),/unavailable/i);
  const incomplete = fundedClient({async getLogs() {return [];}});
  await assert.rejects(() => readFundedState(incomplete.client,fundedPlan,borrowHash),/Borrow.*history|history.*Borrow/i);
});
test('funded-state recovery rejects missing or inconsistent current Morpho position totals', async () => {
  const cases: Array<[unknown,RegExp]> = [
    [undefined,/position/i],
    [{supplyShares:0n,borrowShares:8n,collateral:parseUnits('1',18)},/borrow/i],
    [{supplyShares:0n,borrowShares:10n,collateral:parseUnits('1',18)},/borrow/i],
    [{supplyShares:0n,borrowShares:9n,collateral:parseUnits('0.999',18)},/collateral/i],
    [{supplyShares:0n,borrowShares:'9',collateral:parseUnits('1',18)},/position/i],
  ];
  for (const [position,error] of cases) {
    const h = fundedClient({async readContract() {return position;}});
    await assert.rejects(() => readFundedState(h.client,fundedPlan,borrowHash),error);
  }
});
