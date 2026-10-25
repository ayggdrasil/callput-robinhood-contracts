import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionPlan, reviewFundedExecution, updateFundedQuote, assertFundedPosition} from './execution';
import {decodeFunctionData,erc20Abi} from 'viem';
import {STOCK_INCOME_MARKETS} from '../networks/stockIncome';
import {fundingTransactions} from './wallet';
import {MORPHO_ABI} from './morpho';
import {walletApprovalTransaction,walletOrderTransaction} from './walletOrder';
import PositionManagerAbi from '../_shared/abis/PositionManager.json';

const hash=`0x${'a'.repeat(64)}`;
const short={optionId:`0x${'1'.repeat(64)}`,strikePrice:225,markPrice:'0.8',isOptionAvailable:true};
const long={optionId:`0x${'2'.repeat(64)}`,strikePrice:255,markPrice:'0.1',isOptionAvailable:true};
const quote={amount:'300900',fee:'600',target:'10000000000000000',size:'10000000000000000',minSize:'9950000000000000',optionTokenId:'77',expiry:2_000_000_000,price:'700',quotedAt:1000,premiumAmount:'7000'};
const original:any={version:1,plan:{id:'frozen',chainId:4663,owner:`0x${'3'.repeat(40)}`,account:`0x${'3'.repeat(40)}`,createdBlock:'100',quantity:'0.01',multiplier:'1',marketId:'market',fundingMode:'wallet',quote,
  spread:{symbol:'NVDA',expiry:quote.expiry,short,long,width:'30',premium:'0.7',sourceAt:1000}},
  steps:{approve:{status:'confirmed',hash},supply:{status:'confirmed',hash},borrow:{status:'confirmed',hash}},walletApproval:{status:'rejected'},error:'unavailable'};
const spread={...original.plan.spread,long:{...long,optionId:`0x${'4'.repeat(64)}`,strikePrice:250},width:'25'};
const cheaper={...quote,amount:'250900',optionTokenId:'88'};
const baseline={borrowShares:'300000',collateral:'10000000000000000',block:'120'};
const position={borrowShares:300000n,collateral:10000000000000000n};

test('explicit funded replacement preserves original lending plan and receipts and uses less than borrowed',()=>{
  const next=reviewFundedExecution(original,cheaper,spread,'balanced',baseline,position);
  assert.deepEqual(next.plan,original.plan);
  assert.deepEqual(next.steps,original.steps);
  assert.equal(next.walletApproval,undefined);
  assert.equal(next.error,undefined);
  const active=executionPlan(next);
  assert.equal(active.quote.amount,'250900');
  assert.equal(active.spread.long.strikePrice,250);
  assert.equal(active.owner,original.plan.owner);
  assert.equal(original.execution,undefined);
  assert.doesNotThrow(()=>assertFundedPosition(next,position));
  assert.throws(()=>assertFundedPosition(next,{...position,borrowShares:300001n}),/debt|position/i);
  assert.throws(()=>assertFundedPosition(next,{...position,collateral:position.collateral-1n}),/collateral|position/i);
});
test('funded execution accepts new styles and rejects unknown persisted styles',()=>{
  const next=reviewFundedExecution(original,cheaper,spread,'near',baseline,position);
  assert.equal(executionPlan(next).style,'near');
  assert.throws(()=>executionPlan({...next,execution:{...next.execution!,style:'unknown'}}),/spread|style|invalid/i);
});
test('funded replacement rejects more funding, changed route/size and uncertain transactions',()=>{
  const run=(j=original,q=cheaper,s=spread,b=baseline,p=position)=>reviewFundedExecution(j,q,s,'balanced',b,p);
  assert.throws(()=>run(original,{...cheaper,amount:'300901'}),/borrow|amount|funding/i);
  assert.throws(()=>run(original,cheaper,{...spread,symbol:'TSLA'}),/route/i);
  assert.throws(()=>run(original,{...cheaper,expiry:2_000_000_001}),/expiry|route/i);
  assert.throws(()=>run(original,{...cheaper,minSize:'1'}),/size/i);
  assert.throws(()=>run(original,cheaper,spread,baseline,{...position,borrowShares:1n}),/debt|position/i);
  for(const status of ['sending','pending','unknown','confirmed']) assert.throws(()=>run({...original,walletApproval:{status,hash}}),/approval/i);
  for(const status of ['pending','failed','filled']) assert.throws(()=>run({...original,order:{status,hash}}),/order/i);
  assert.throws(()=>run({...original,management:{status:'confirmed'}}),/manage/i);
  assert.throws(()=>run({...original,steps:{...original.steps,borrow:{status:'idle'}}}),/fund/i);
  assert.throws(()=>run(original,cheaper,{...spread,long:{...spread.long,isOptionAvailable:false}}),/available|spread/i);
  assert.throws(()=>run(original,{...cheaper,optionTokenId:'0'}),/invalid/i);
  assert.throws(()=>run(original,cheaper,{...spread,premium:'0.6'}),/spread/i);
});
test('exact funded quote review preserves confirmed approval and never changes its amount or legs',()=>{
  const replaced=reviewFundedExecution(original,cheaper,spread,'balanced',baseline,position);
  const approved={...replaced,walletApproval:{status:'confirmed',hash}} as any;
  const next=updateFundedQuote(approved,{...cheaper,quotedAt:1001},spread,baseline,position);
  assert.deepEqual(next.walletApproval,approved.walletApproval);
  assert.throws(()=>updateFundedQuote(approved,{...cheaper,amount:'250899'},spread,baseline,position),/amount/i);
  assert.throws(()=>updateFundedQuote(approved,cheaper,{...spread,long:{...spread.long,strikePrice:245}},baseline,position),/legs|spread/i);
  assert.throws(()=>executionPlan({...replaced,execution:{...replaced.execution!,quote:{...cheaper,target:'20000000000000000'}}}),/size/i);
});

test('legacy exact quote refresh preserves missing style and the original legs',()=>{
  const next=updateFundedQuote(original,{...quote,quotedAt:1001},original.plan.spread,baseline,position);
  assert.equal(next.execution?.style,undefined);
  const active=executionPlan(next);
  assert.equal(active.style,undefined);
  assert.equal(active.spread.short.optionId,original.plan.spread.short.optionId);
  assert.equal(active.spread.long.optionId,original.plan.spread.long.optionId);
  assert.throws(()=>executionPlan({...next,execution:{...next.execution!,style:'unknown'}}),/spread|style|invalid/i);
});

test('execution approval and order use the amended amount while original borrow calldata remains pinned',()=>{
  const canonical={...original,plan:{...original.plan,marketId:STOCK_INCOME_MARKETS[0].id}};
  const reviewed=reviewFundedExecution(canonical,cheaper,spread,'balanced',baseline,position);
  const active=executionPlan(reviewed);
  const loan=decodeFunctionData({abi:MORPHO_ABI,data:fundingTransactions(reviewed.plan).borrow.data});
  const approval=decodeFunctionData({abi:erc20Abi,data:walletApprovalTransaction(active).data});
  const order=decodeFunctionData({abi:PositionManagerAbi,data:walletOrderTransaction(active).data});
  assert.equal(loan.args?.[1],300900n);
  assert.equal(approval.args?.[1],250900n);
  assert.equal(order.args?.[7],250900n);
  assert.deepEqual((order.args?.[3] as string[]).slice(0,2),[spread.short.optionId,spread.long.optionId]);
});
