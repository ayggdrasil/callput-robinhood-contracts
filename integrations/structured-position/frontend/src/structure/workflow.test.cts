import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activateFunding, archiveFunding, canStartNextStrategy, createFunding, journalKey, loadFunding, loadPositions,
  runFunding, saveFunding, startNextStrategy, type FundingAdapter, type FundingJournal, type IncomePlan} from './workflow';
const hash = `0x${'a'.repeat(64)}` as const;
const plan = {id: 'first', chainId: 4663, owner: '0x1111111111111111111111111111111111111111',
  account: '0x2222222222222222222222222222222222222222', marketId: `0x${'f'.repeat(64)}`,
  createdBlock:'1', quantity: '1', multiplier: '1', quote: {amount: '10000000'}, spread: {symbol: 'NVDA'}} as IncomePlan;
const owner = plan.owner;
function journal(id: string, order: 'filled' | 'pending' = 'filled'): FundingJournal {
  return {...createFunding({...plan,id}),steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'confirmed'}},
    incomeBasis:{tokenPrice:'123.45',borrowApr:'0.08',startedAt:1000},
    order:{status:order,fill:order === 'filled' ? {size:'1',premium:'2',filledAt:1100} : undefined}};
}
function memoryStorage(entries: Record<string,string> = {}) {
  const values = new Map(Object.entries(entries));
  const storage = {
    get length() {return values.size;}, key(index: number) {return [...values.keys()][index] ?? null;},
    getItem(key: string) {return values.get(key) ?? null;}, setItem(key: string,value: string) {values.set(key,value);},
    removeItem(key: string) {values.delete(key);}, clear() {values.clear();},
  } as Storage;
  return {storage,values};
}
function useStorage(t: {after(fn: () => void): void}, entries: Record<string,string> = {}) {
  const previous = globalThis.localStorage, mock = memoryStorage(entries);
  Object.defineProperty(globalThis,'localStorage',{value:mock.storage,writable:true,configurable:true});
  t.after(() => {if (previous) Object.defineProperty(globalThis,'localStorage',{value:previous,writable:true,configurable:true}); else delete (globalThis as {localStorage?: Storage}).localStorage;});
  return mock;
}
function harness() {
  let saved: FundingJournal | null = null;
  const sent: string[] = [], checked: string[] = [];
  const adapter: FundingAdapter = {
    load: () => saved, persist: state => {saved = structuredClone(state);},
    guard: () => undefined, preflight: async (_plan, step) => {checked.push(step);},
    submit: async (_plan, step) => {sent.push(step); return hash;},
    receipt: async () => 'confirmed', isRejected: () => false,
  };
  return {adapter, sent, checked, saved: () => saved};
}
test('runs supply and borrowing once and resumes only a pending receipt', async () => {
  const h = harness(); let pending = true;
  h.adapter.receipt = async (_plan, step) => step === 'borrow' && pending ? 'pending' : 'confirmed';
  const first = await runFunding(createFunding(plan), h.adapter);
  assert.equal(first.steps.borrow.status, 'pending');
  assert.deepEqual(h.sent, ['approve', 'supply', 'borrow']);
  pending = false;
  const result = await runFunding(first, h.adapter);
  assert.equal(result.steps.borrow.status, 'confirmed');
  assert.deepEqual(h.sent, ['approve', 'supply', 'borrow']);
});
test('funding accepts known styles, preserves legacy plans and rejects unknown runtime styles', () => {
  assert.equal(createFunding({...plan,style:'near'}).plan.style,'near');
  assert.equal(createFunding(plan).plan.style,undefined);
  assert.throws(() => createFunding({...plan,style:'unknown'} as IncomePlan),/style|identity/i);
});
test('persists sending before calling the wallet; lost response never rebroadcasts', async () => {
  const h = harness();
  h.adapter.submit = async (_plan, step) => {assert.equal(h.saved()?.steps[step].status, 'sending'); h.sent.push(step); throw new Error('lost');};
  const first = await runFunding(createFunding(plan), h.adapter);
  assert.equal(first.steps.approve.status, 'unknown');
  await runFunding(first, h.adapter);
  assert.deepEqual(h.sent, ['approve']);
});
test('identity change after a receipt stops before the next wallet prompt', async () => {
  const h = harness(); let changed = false;
  h.adapter.receipt = async () => {changed = true; return 'confirmed';};
  h.adapter.guard = () => {if (changed) throw new Error('Wallet changed');};
  const result = await runFunding(createFunding(plan), h.adapter);
  assert.match(result.error ?? '', /Wallet changed/);
  assert.deepEqual(h.sent, ['approve']);
});
test('rejects a new plan while a previous loan journal exists', async () => {
  const h = harness(); await runFunding(createFunding(plan), h.adapter);
  await assert.rejects(() => runFunding(createFunding({...plan, id: 'second'}), h.adapter), /existing/i);
  assert.equal(h.sent.filter(step => step === 'borrow').length, 1);
});
test('a rejected signature can be retried; failed preflight cannot send', async () => {
  const h = harness(); let rejected = true;
  h.adapter.isRejected = () => true;
  h.adapter.submit = async (_plan, step) => {if (rejected) throw new Error('4001'); h.sent.push(step); return hash;};
  const first = await runFunding(createFunding(plan), h.adapter);
  assert.equal(first.steps.approve.status, 'rejected');
  rejected = false; h.adapter.preflight = async (_plan, step) => {if (step === 'borrow') throw new Error('Quote expired');};
  const result = await runFunding(first, h.adapter);
  assert.deepEqual(h.sent, ['approve', 'supply']);
  assert.match(result.error ?? '', /expired/);
});
test('legacy v1 journals load as active without mutation and filled state gates the next strategy', t => {
  const filled = journal('legacy'), key = journalKey(owner), raw = JSON.stringify(filled), h = useStorage(t,{[key]:raw});
  assert.equal(loadFunding(owner)?.plan.id,'legacy');
  assert.deepEqual(loadPositions(owner).map(item => item.plan.id),['legacy']);
  assert.equal(canStartNextStrategy(loadFunding(owner)),true);
  assert.equal(h.values.get(key),raw);
  h.values.set(key,JSON.stringify(journal('legacy','pending')));
  assert.equal(canStartNextStrategy(loadFunding(owner)),false);
  assert.equal(canStartNextStrategy(null),false);
});
test('starting a second strategy retains the first completed position', t => {
  useStorage(t);
  saveFunding(journal('first')); startNextStrategy(owner);
  assert.equal(loadFunding(owner),null);
  saveFunding(journal('second','pending'));
  assert.equal(loadFunding(owner)?.plan.id,'second');
  assert.deepEqual(loadPositions(owner).map(item => item.plan.id),['first','second']);
});
test('funding a second run and selecting the first preserves every prior receipt and fill',async t=>{
  useStorage(t);
  const first=journal('first'); saveFunding(first); startNextStrategy(owner);
  const second=createFunding({...plan,id:'second',initialBorrowShares:'300492343641'});
  const sent:string[]=[];
  const funded=await runFunding(second,{load:()=>loadFunding(owner),persist:saveFunding,guard:()=>undefined,
    preflight:async()=>undefined,submit:async(_plan,step)=>{sent.push(step);return hash;},receipt:async()=> 'confirmed',isRejected:()=>false});
  assert.deepEqual(sent,['approve','supply','borrow']);
  assert.deepEqual(loadPositions(owner).find(item=>item.plan.id==='first'),first);
  assert.equal(funded.plan.initialBorrowShares,'300492343641');
  const filled={...funded,incomeBasis:first.incomeBasis,order:structuredClone(first.order)};
  saveFunding(filled); startNextStrategy(owner);
  assert.deepEqual(activateFunding(owner,'first'),first);
  assert.deepEqual(loadPositions(owner).find(item=>item.plan.id==='second'),JSON.parse(JSON.stringify(filled)));
});
test('unresolved active work blocks completion and activation', t => {
  const active = journal('first','pending'), parked = journal('second');
  useStorage(t,{[journalKey(owner)]:JSON.stringify({version:2,active,completed:[parked]})});
  assert.throws(() => startNextStrategy(owner),/resolve|filled|complete/i);
  assert.throws(() => activateFunding(owner,'second'),/resolve|filled|complete/i);
  active.order = {status:'filled'}; active.walletApproval = {status:'unknown'};
  localStorage.setItem(journalKey(owner),JSON.stringify({version:2,active,completed:[parked]}));
  assert.equal(canStartNextStrategy(loadFunding(owner)),false);
});
test('activation atomically parks the old active journal and selects a completed one', t => {
  const active = journal('first'), selected = journal('second');
  useStorage(t,{[journalKey(owner)]:JSON.stringify({version:2,active,completed:[selected]})});
  assert.equal(activateFunding(owner,'second').plan.id,'second');
  assert.equal(loadFunding(owner)?.plan.id,'second');
  assert.deepEqual(loadPositions(owner).map(item => item.plan.id),['first','second']);
});
test('late writes cannot replace another active journal or revive a completed ID', t => {
  useStorage(t,{[journalKey(owner)]:JSON.stringify({version:2,active:journal('second','pending'),completed:[journal('first')]})});
  assert.throws(() => saveFunding(journal('first')),/active|late|existing/i);
});
test('late writes are rejected while a new ID is allowed when active is empty', t => {
  useStorage(t,{[journalKey(owner)]:JSON.stringify({version:2,active:null,completed:[journal('first')]})});
  assert.throws(() => saveFunding(journal('first')),/late|completed|existing/i);
  saveFunding(journal('second','pending'));
  assert.equal(loadFunding(owner)?.plan.id,'second');
  assert.throws(() => saveFunding(journal('third','pending')),/active|existing/i);
});
test('malformed envelopes, owner mismatches and duplicate IDs fail closed', t => {
  const key = journalKey(owner), h = useStorage(t,{[key]:'{'});
  assert.throws(() => loadPositions(owner));
  h.values.set(key,JSON.stringify({version:2,active:journal('same'),completed:[journal('same')]}));
  assert.throws(() => loadPositions(owner),/unique|duplicate|verified/i);
  h.values.set(key,JSON.stringify({version:2,active:null,completed:[journal('other-owner')]}));
  const wrong = journal('other-owner'); wrong.plan.owner = '0x3333333333333333333333333333333333333333';
  h.values.set(key,JSON.stringify({version:2,active:null,completed:[wrong]}));
  assert.throws(() => loadPositions(owner),/verified|owner/i);
});
test('unresolved work cannot be hidden in completed positions to unlock another loan', t => {
  useStorage(t,{[journalKey(owner)]:JSON.stringify({version:2,active:null,completed:[journal('unresolved','pending')]})});
  assert.throws(()=>loadFunding(owner),/completed|resolve|verified/i);
  assert.throws(()=>saveFunding(journal('next')),/completed|resolve|verified/i);
});
test('new filled strategies must retain authenticated fill amounts before the next strategy',()=>{
  const saved=journal('new'); saved.order={status:'filled'};
  assert.equal(canStartNextStrategy(saved),false);
  delete saved.incomeBasis;
  assert.equal(canStartNextStrategy(saved),true); // legacy v1 did not record fill economics
});
test('archive preserves completed records and verifies the archive before clearing active', t => {
  const key = journalKey(owner); useStorage(t,{[key]:JSON.stringify({version:2,active:journal('second'),completed:[journal('first')]})});
  archiveFunding(owner,'second');
  assert.equal(loadFunding(owner),null);
  assert.deepEqual(loadPositions(owner).map(item => item.plan.id),['first']);
  assert.equal(JSON.parse(localStorage.getItem(`${key}:archive:second`)!).plan.id,'second');
});
test('storage readback failure cannot clear the active journal', t => {
  const key = journalKey(owner), active = journal('first'), raw = JSON.stringify(active), h = useStorage(t,{[key]:raw});
  const originalSet = h.storage.setItem.bind(h.storage);
  h.storage.setItem = (target,value) => {if (target !== key) originalSet(target,value);};
  assert.throws(() => startNextStrategy(owner),/saved|storage|progress/i);
  assert.equal(loadFunding(owner)?.plan.id,'first');
  assert.equal(h.values.get(key),raw);
  assert.throws(() => archiveFunding(owner,'first'),/saved|storage|progress/i);
  assert.equal(loadFunding(owner)?.plan.id,'first');
  assert.equal(JSON.parse(h.values.get(`${key}:archive:first`)!).plan.id,'first');
});
