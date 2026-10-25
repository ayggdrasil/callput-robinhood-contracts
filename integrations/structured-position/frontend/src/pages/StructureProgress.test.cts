import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import StructureProgress, {strategyProgress} from './StructureProgress';
import type {FundingJournal} from '../structure/workflow';

const hash=`0x${'a'.repeat(64)}` as const;
const journal=():FundingJournal=>({version:1,plan:{id:'test'} as FundingJournal['plan'],
  steps:{approve:{status:'idle'},supply:{status:'idle'},borrow:{status:'idle'}}});
const funded=()=>({...journal(),steps:{approve:{status:'confirmed',hash},supply:{status:'confirmed',hash},borrow:{status:'confirmed',hash}}} as FundingJournal);

test('previews all wallet operations and automatic fill separately',()=>{
  const rows=strategyProgress(null,true);
  assert.deepEqual(rows.map(row=>row.id),['approve','supply','borrow','walletApproval','order','fill']);
  assert.equal(rows[0].status,'ready');
  assert.ok(rows.slice(1).every(row=>row.status==='upcoming'));
  const html=renderToStaticMarkup(React.createElement(StructureProgress,{journal:null,walletMode:true}));
  assert.match(html,/Up to 5 wallet confirmations/);
  assert.match(html,/Automatic fill/);
  assert.doesNotMatch(html,/>Waiting<|>Next<|>Complete</);
  assert.doesNotMatch(html,/all in one transaction/i);
});

test('shows descriptive status only for the current operation while retaining semantic labels',()=>{
  const saved=funded();saved.steps.supply={status:'pending',hash};
  const html=renderToStaticMarkup(React.createElement(StructureProgress,{journal:saved,walletMode:true}));
  assert.match(html,/Supply stock · Confirming on-chain/);
  assert.match(html,/<small>Confirming on-chain<\/small>/);
  assert.match(html,/aria-label="Stock approval: Complete"/);
  assert.match(html,/aria-label="Borrow USDG: Complete"/);
  assert.doesNotMatch(html,/<small>Complete<\/small>|<small>Waiting<\/small>/);
});

test('shortens the deposit preview note',()=>{
  const html=renderToStaticMarkup(React.createElement(StructureProgress,{journal:null,walletMode:false}));
  assert.match(html,/3 lending steps → submit order\./);
  assert.doesNotMatch(html,/3 lending transactions/);
});

test('retains failed and ambiguous operation labels even behind an earlier incomplete step',()=>{
  for(const status of ['rejected','reverted','unknown','failed'] as const) {
    const saved=journal();saved.steps.borrow={status,hash};
    const html=renderToStaticMarkup(React.createElement(StructureProgress,{journal:saved,walletMode:true}));
    assert.match(html,/Borrow USDG<\/strong><small>(Signature declined|Transaction reverted|Verify original transaction|Failed)<\/small>/);
  }
});

test('pending and ambiguous funding stop progress at their original operation',()=>{
  for(const status of ['sending','pending','unknown','rejected','reverted'] as const) {
    const saved=journal();saved.steps.approve={status:'confirmed',hash};saved.steps.supply={status,hash};
    const rows=strategyProgress(saved,true);
    assert.equal(rows[1].status,status);
    assert.equal(rows[1].hash,hash);
    assert.ok(rows.slice(2).every(row=>row.status==='upcoming'));
    const html=renderToStaticMarkup(React.createElement(StructureProgress,{journal:saved,walletMode:true}));
    assert.match(html,/aria-current="step"/);
    if(status==='unknown') assert.match(html,/Verify original transaction/);
    if(status==='sending') assert.match(html,/Confirm in wallet/);
    if(status==='pending') assert.match(html,/Confirming on-chain/);
  }
});

test('funded wallet exposes USDG approval, then order, then authenticated fill',()=>{
  const saved=funded();
  assert.equal(strategyProgress(saved,true)[3].status,'ready');
  saved.walletApproval={status:'pending',hash};
  assert.equal(strategyProgress(saved,true)[3].status,'pending');
  assert.equal(strategyProgress(saved,true)[4].status,'upcoming');
  saved.walletApproval.status='confirmed';
  assert.equal(strategyProgress(saved,true)[4].status,'ready');
  saved.order={status:'pending',hash};
  assert.equal(strategyProgress(saved,true)[4].status,'pending');
  saved.order.requestId=hash;
  assert.equal(strategyProgress(saved,true)[4].status,'confirmed');
  assert.equal(strategyProgress(saved,true)[5].status,'pending');
  saved.order.status='filled';
  assert.ok(strategyProgress(saved,true).every(row=>row.status==='confirmed'));
});

test('existing allowance is not fabricated as an approval receipt',()=>{
  const saved=funded();saved.order={status:'pending',hash,requestId:hash};
  const rows=strategyProgress(saved,true);
  assert.equal(rows[3].status,'confirmed');
  assert.equal(rows[3].hash,undefined);
  const failed=funded();failed.order={status:'failed'};
  assert.notEqual(strategyProgress(failed,true)[3].status,'confirmed');
  const legacy=funded();legacy.order={status:'filled'};
  assert.ok(strategyProgress(legacy,true).every(row=>row.status==='confirmed'),'a saved fill completes setup even without a separate approval receipt');
});

test('order failure or unknown outcome is never reported as a filled strategy',()=>{
  for(const status of ['unknown','failed','sending'] as const) {
    const saved=funded();saved.walletApproval={status:'confirmed',hash};saved.order={status,hash};
    const rows=strategyProgress(saved,true);
    assert.equal(rows[4].status,status);
    assert.equal(rows[5].status,'upcoming');
  }
  const saved=funded();saved.order={status:'failed',hash,requestId:hash};
  assert.equal(strategyProgress(saved,true)[5].status,'failed');
});

test('deposit mode omits the wallet-only USDG approval and does not infer submission from a local UUID',()=>{
  const saved=funded();saved.order={status:'pending',requestId:'local-uuid'};
  const rows=strategyProgress(saved,false);
  assert.deepEqual(rows.map(row=>row.id),['approve','supply','borrow','order','fill']);
  assert.equal(rows[3].status,'pending');
  assert.equal(rows[4].status,'upcoming');
});

test('review and error statuses stay visible beside per-operation receipts',()=>{
  const saved=funded();saved.walletApproval={status:'unknown',hash};
  const html=renderToStaticMarkup(React.createElement(StructureProgress,{journal:saved,walletMode:true,reviewRequired:true,error:'Refresh the quote.',transactionUrl:(value:string)=>`https://explorer.example/tx/${value}`}));
  assert.match(html,/USDG approval · Verify original transaction/);
  assert.match(html,/Refresh the quote\./);
  assert.match(html,/role="alert"/);
  assert.match(html,new RegExp(`href="https://explorer.example/tx/${hash}"`));
  assert.match(html,/View USDG approval transaction/);
  const ready=renderToStaticMarkup(React.createElement(StructureProgress,{journal:funded(),walletMode:true,reviewRequired:true}));
  assert.match(ready,/Review order quote/);
});
