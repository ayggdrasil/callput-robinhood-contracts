import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {runManagement, managementPending, canReconcileTransaction, canArchive, resumeOriginalOrder, updateUnborrowedQuote, reviewUnborrowedStrategy} from './recovery';

const hash = '0x' + 'a'.repeat(64);
const journal: any = {plan: {owner: '0x' + '1'.repeat(40)}, steps: {approve: {status: 'confirmed'}, supply: {status: 'confirmed'}, borrow: {status: 'confirmed'}}};
test('wallet rejection can be reconciled with an independently verified original receipt', () => {
  for (const status of ['sending', 'pending', 'unknown', 'rejected']) assert.equal(canReconcileTransaction({status}), true);
  for (const status of ['idle', 'confirmed', 'reverted']) assert.equal(canReconcileTransaction({status}), false);
  assert.equal(canReconcileTransaction(undefined), false);
  assert.equal(managementPending({status: 'rejected'}), false);
});

test('explicit preborrow repricing preserves completed funding and refuses any possible loan or changed legs', () => {
  const original: any = {version:1, plan:{id:'frozen', chainId:4663, owner:'0x'+'1'.repeat(40), account:'0x'+'1'.repeat(40),
    createdBlock:'100', quantity:'0.01', multiplier:'1', marketId:'market',
    quote:{amount:'300900', fee:'600', target:'10000000000000000', minSize:'9950000000000000', optionTokenId:'77', expiry:2000},
    spread:{symbol:'NVDA', expiry:2000, short:{optionId:'short',strikePrice:225},long:{optionId:'long',strikePrice:255}}},
    steps:{approve:{status:'confirmed',hash}, supply:{status:'confirmed',hash}, borrow:{status:'idle'}}, error:'stale'};
  const quote = {...original.plan.quote,amount:'301000'};
  const spread = {...original.plan.spread,premium:'0.8',sourceAt:1000};
  const updated = updateUnborrowedQuote(original, quote, spread, 0n, 101n);
  assert.equal(updated.plan.id,original.plan.id);
  assert.equal(updated.plan.quote.amount,'301000');
  assert.deepEqual(updated.steps,original.steps);
  assert.equal(original.plan.quote.amount,'300900');
  assert.equal(updated.error,undefined);
  assert.throws(()=>updateUnborrowedQuote(original,quote,spread,1n,101n),/debt|borrow/i);
  assert.throws(()=>updateUnborrowedQuote(original,quote,spread,0n,99n),/block/i);
  for(const status of ['sending','pending','unknown','rejected','confirmed','reverted']) {
    assert.throws(()=>updateUnborrowedQuote({...original,steps:{...original.steps,borrow:{status}}},quote,spread,0n,101n),/borrow/i);
  }
  assert.throws(()=>updateUnborrowedQuote({...original,order:{status:'failed'}},quote,spread,0n,101n),/order|strategy/i);
  assert.throws(()=>updateUnborrowedQuote({...original,steps:{...original.steps,supply:{status:'unknown'}}},quote,spread,0n,101n),/pending|reconcile/i);
  assert.throws(()=>updateUnborrowedQuote(original,quote,{...spread,long:{...spread.long,optionId:'different'}},0n,101n),/legs|route/i);
  assert.throws(()=>updateUnborrowedQuote(original,{...quote,target:'20000000000000000'},spread,0n,101n),/size|quote/i);
  assert.doesNotThrow(()=>updateUnborrowedQuote({...original,plan:{...original.plan,initialBorrowShares:'5'}},quote,spread,5n,101n));
  const replacement = {...spread,width:'25',premium:'0.8',short:{...spread.short,isOptionAvailable:true},
    long:{optionId:'replacement',strikePrice:250,isOptionAvailable:true}};
  const replacementQuote = {...quote,optionTokenId:'88',amount:'250900'};
  const reviewed = reviewUnborrowedStrategy(original,replacementQuote,replacement,0n,101n,'balanced');
  assert.equal(reviewed.plan.style,'balanced');
  assert.equal(reviewed.plan.spread.long.strikePrice,250);
  assert.equal(reviewed.plan.account,original.plan.account);
  assert.equal(reviewed.plan.quantity,original.plan.quantity);
  assert.deepEqual(reviewed.steps,original.steps);
  assert.throws(()=>reviewUnborrowedStrategy({...original,steps:{...original.steps,borrow:{status:'confirmed'}}},replacementQuote,replacement,0n,101n,'balanced'),/borrow/i);
  assert.throws(()=>reviewUnborrowedStrategy(original,replacementQuote,{...replacement,symbol:'TSLA'},0n,101n,'balanced'),/route/i);
  const near = reviewUnborrowedStrategy(original,replacementQuote,replacement,0n,101n,'near');
  assert.equal(near.plan.style,'near');
  assert.throws(()=>reviewUnborrowedStrategy(original,replacementQuote,replacement,0n,101n,'unknown' as never),/strategy|style|available/i);
});
test('repay persists intent before send and resumes the exact pending transaction once', async () => {
  let saved: any, sends = 0, receipts = 0;
  const adapter: any = {guard() {}, persist(s: any) {saved = structuredClone(s);}, prepare: async () => ({action:'repay',amount:'12',to:'0x'+'2'.repeat(40),data:'0x1234'}),
    send: async () => {assert.equal(saved.management.status, 'sending'); sends++; return hash;},
    receipt: async (op: any) => {assert.equal(op.amount, '12'); receipts++; return receipts === 1 ? 'pending' : 'confirmed';}, isRejected: () => false};
  const pending = await runManagement(journal, 'repay', adapter);
  assert.equal(pending.management.status, 'pending');
  const done = await runManagement(pending, 'repay', adapter);
  assert.equal(done.management.status, 'confirmed'); assert.equal(sends, 1);
});
test('unknown management send and a different pending action never resend', async () => {
  const adapter: any = {guard() {},persist() {},prepare: async () => {throw Error('must not prepare');}};
  await assert.rejects(() => runManagement({...journal, management:{action:'repay',status:'unknown'}},'repay',adapter), /Reconcile/);
  await assert.rejects(() => runManagement({...journal, management:{action:'repay',status:'pending',hash}},'withdraw',adapter), /previous/);
});
test('archive blocks outstanding debt, collateral, transaction ambiguity and unconfirmed orders', () => {
  assert.equal(managementPending({status:'unknown'} as any),true);
  assert.equal(canArchive(journal,0n,0n),true);
  assert.equal(canArchive(journal,1n,0n),false);
  assert.equal(canArchive(journal,0n,1n),false);
  assert.equal(canArchive({...journal,order:{status:'sending'}},0n,0n),false);
  assert.equal(canArchive({...journal,steps:{...journal.steps,borrow:{status:'unknown'}}},0n,0n),false);
});

const requestId = '11111111-1111-4111-8111-111111111111';
const order = {requestId, deadline: '1100'} as any;
const known = {id: requestId, state: 'queued'} as any;
const pending = {order, status: null};
function recovery(reads: Array<any>, block = 1000n) {
  const submitted: any[] = [], discarded: string[] = [], verified: any[] = [];
  const port = {guard() {}, verify(result: any) {verified.push(result);},
    async read(id: string) {assert.equal(id, requestId); return reads.shift() ?? null;},
    async discardUnsigned(id: string) {discarded.push(id);}, async blockTimestamp() {return block;},
    async submit(original: any) {submitted.push(original); return known;}};
  return {port, submitted, discarded, verified};
}

test('lost relay response resubmits the exact original order and UUID', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const h = recovery([pending]);
  const result = await resumeOriginalOrder(requestId, h.port);
  assert.equal(result.status, 'observed');
  assert.equal((result as any).result.order, order);
  assert.equal((result as any).result.order.requestId, requestId);
  assert.deepEqual(h.submitted, [order]);
  assert.deepEqual(h.discarded, []);
});

test('two canonical null-status reads beyond deadline grace retire only the original local intent', async t => {
  t.mock.method(Date, 'now', () => 2_000_000);
  const expired = {order: {...order, deadline: '1600'}, status: null};
  const h = recovery([expired, expired], 2000n);
  assert.deepEqual(await resumeOriginalOrder(requestId, h.port), {status: 'failed', requestId});
  assert.equal(h.verified.length, 2);
  assert.deepEqual(h.submitted, []);
  assert.deepEqual(h.discarded, []);
});

test('a status discovered by the post-grace re-read is preserved', async t => {
  t.mock.method(Date, 'now', () => 2_000_000);
  const expired = {order: {...order, deadline: '1600'}, status: null};
  const discovered = {order: expired.order, status: known};
  const h = recovery([expired, discovered], 2000n);
  assert.deepEqual(await resumeOriginalOrder(requestId, h.port), {status: 'observed', result: discovered});
  assert.deepEqual(h.submitted, []);
});

test('future canonical block is rejected before resubmit', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const h = recovery([pending], 1061n);
  await assert.rejects(() => resumeOriginalOrder(requestId, h.port), /future block/i);
  assert.deepEqual(h.submitted, []);
});

test('order mismatch fails verification before any resubmit', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const h = recovery([pending]);
  h.port.verify = () => {throw new Error('Order does not match this strategy.');};
  await assert.rejects(() => resumeOriginalOrder(requestId, h.port), /does not match/i);
  assert.deepEqual(h.submitted, []);
});

test('known status is preserved without block reads or writes', async () => {
  const observed = {order, status: known};
  const h = recovery([observed]);
  h.port.blockTimestamp = async () => {throw new Error('must not read block');};
  h.port.submit = async () => {throw new Error('must not submit');};
  assert.deepEqual(await resumeOriginalOrder(requestId, h.port), {status: 'observed', result: observed});
  assert.deepEqual(h.verified, [observed]);
});

test('only discardUnsigned can classify a missing first read as failed', async () => {
  const h = recovery([null]);
  assert.deepEqual(await resumeOriginalOrder(requestId, h.port), {status: 'failed', requestId});
  assert.deepEqual(h.discarded, [requestId]);
});

test('grace window and missing second evidence remain unresolved', async t => {
  t.mock.method(Date, 'now', () => 2_000_000);
  const waiting = {order: {...order, deadline: '1800'}, status: null};
  await assert.rejects(() => resumeOriginalOrder(requestId, recovery([waiting], 2000n).port), /five minutes/i);
  const expired = {order: {...order, deadline: '1600'}, status: null};
  await assert.rejects(() => resumeOriginalOrder(requestId, recovery([expired, null], 2000n).port), /evidence is unavailable/i);
});
