import assert from 'node:assert/strict';
import {test} from 'node:test';
import {positionIncome} from './positionIncome';
import type {FundingJournal} from './workflow';
import {BN} from '../utils/bn';

const hash=`0x${'a'.repeat(64)}`;
const originalSpread={symbol:'NVDA',expiry:4_153_600,short:{optionId:`0x${'1'.repeat(64)}`,strikePrice:105,markPrice:'4',isOptionAvailable:true},
  long:{optionId:`0x${'2'.repeat(64)}`,strikePrice:120,markPrice:'1',isOptionAvailable:true},width:'15',premium:'3',sourceAt:999_990};
const executionSpread={...originalSpread,short:{...originalSpread.short,optionId:`0x${'3'.repeat(64)}`,strikePrice:110,markPrice:'3.5'},
  long:{...originalSpread.long,optionId:`0x${'4'.repeat(64)}`,strikePrice:125,markPrice:'0.5'}};
const quote={amount:'81000000',fee:'2000000',target:'5000000000000000000',size:'5000000000000000000',minSize:'4975000000000000000',
  optionTokenId:'77',expiry:4_153_600,price:'3000',quotedAt:999_990,premiumAmount:'15000000'};
const journal={version:1,plan:{id:'income',chainId:4663,owner:`0x${'5'.repeat(40)}`,account:`0x${'5'.repeat(40)}`,createdBlock:'100',
  quantity:'10',multiplier:'0.5',marketId:`0x${'6'.repeat(64)}`,fundingMode:'wallet',quote,spread:originalSpread},
  steps:{approve:{status:'confirmed',hash},supply:{status:'confirmed',hash},borrow:{status:'confirmed',hash}},
  execution:{borrowShares:'1',collateral:'1',block:'101',quote:{...quote,amount:'76000000',fee:'1000000'},spread:executionSpread,style:'balanced'},
  incomeBasis:{tokenPrice:'50',borrowApr:'0.1',startedAt:1_000_000}} satisfies FundingJournal;

test('filled income uses authenticated execution amounts and entry tenor with the original stock and loan',()=>{
  const value=positionIncome({...journal,order:{status:'filled',fill:{size:'5010000000000000000',premium:'17000000',filledAt:1_864_000}}});
  assert.ok(value);
  assert.deepEqual(value.input,{quantity:'10',multiplier:'0.5',tokenPrice:'50',spot:'100',shortStrike:'110',longStrike:'125',
    premiumPerShare:'3',borrowApr:'0.1',durationSeconds:'2289600',loan:'81',fee:'1',shares:'5.01',premium:'17',cashPerUsd:'1'});
  assert.equal(value.result.stockValue.toFixed(),'500');
  assert.equal(value.result.grossPremium.toFixed(),'17');
  assert.equal(value.result.loan.toFixed(),'81');
  assert.equal(value.result.fee.toFixed(),'1');
  assert.equal(value.result.interest.toFixed(6),'0.588082');
  assert.equal(value.result.apr.toFixed(6),'0.424555');
});

test('prepared income uses the frozen quote and basis start, even after the calendar expiry',()=>{
  const expired={...journal,plan:{...journal.plan,spread:{...journal.plan.spread,expiry:2_000_000},quote:{...journal.plan.quote,expiry:2_000_000}},
    execution:{...journal.execution,spread:{...journal.execution.spread,expiry:2_000_000},quote:{...journal.execution.quote,expiry:2_000_000}}};
  const value=positionIncome(expired);
  assert.ok(value);
  assert.equal(value.input.durationSeconds,'1000000');
  assert.equal(value.input.shares,'5');
  assert.equal(value.input.premium,'15');
});

test('income is unavailable without a valid immutable basis',()=>{
  assert.equal(positionIncome({...journal,incomeBasis:undefined}),null);
  for (const basis of [{tokenPrice:'0',borrowApr:'0.1',startedAt:1_000_000},{tokenPrice:'50',borrowApr:'-1',startedAt:1_000_000},
    {tokenPrice:'50',borrowApr:'0.1',startedAt:0},{tokenPrice:'50',borrowApr:'0.1',startedAt:4_153_600}]) {
    assert.equal(positionIncome({...journal,incomeBasis:basis}),null);
  }
});
test('entry spot for payoff converts the stock token USDG value back to USD',()=>{
  const value=positionIncome({...journal,execution:{...journal.execution,quote:{...journal.execution.quote,amount:'77500000'}}});
  assert.ok(value);
  assert.equal(value.input.cashPerUsd,'1.02');
  assert.equal(new BN(value.input.spot).times('1.02').toFixed(6),'100.000000');
  assert.equal(value.result.stockValue.toFixed(),'500');
});
