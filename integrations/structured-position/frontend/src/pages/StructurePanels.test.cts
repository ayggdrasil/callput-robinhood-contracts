import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {BN} from '../utils/bn';
import {calculateIncome} from '../structure/incomeProjection';

function panels() {
  const exports:Record<string,any>={};
  runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'StructurePanels.tsx'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText,{exports,require:(id:string)=>({'react/jsx-runtime':jsx,'../utils/bn':{BN},'./StructureStockLogo':{default:()=>null}}[id] ?? {})});
  return exports;
}

test('expiry chooser uses one button per unique real expiry with date, remaining time and selection',()=>{
  const now=1_800_000_000, first=now+6*86400+13*3600, second=first+21*86400;
  const html=renderToStaticMarkup(React.createElement(panels().ExpiryChoices,{
    expiries:[second,first,first,now-1],selected:second,now,disabled:false,onSelect:()=>{},
  }));
  assert.equal((html.match(/<button/g) ?? []).length,2);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length,1);
  assert.match(html,/6d 13h/);
  assert.match(html,/27d 13h/);
  assert.doesNotMatch(html,/Shortest| left/);
  assert.match(html,/Expiry/);
  assert.match(html,/UTC/);
  const selectedDate=new Date(second*1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
  assert.match(html,new RegExp(`${selectedDate} UTC`));
  assert.doesNotMatch(html,/<select|Within 1 day|Within 3 days|All expiries/);
});

test('real shorter maturities use the same selector and financial input locks still apply',()=>{
  const now=1_800_000_000;
  const props={expiries:[now+18*3600,now+2*86400],selected:now+18*3600,now,onSelect:()=>{}};
  const html=renderToStaticMarkup(React.createElement(panels().ExpiryChoices,props));
  assert.equal((html.match(/<button/g) ?? []).length,2);
  assert.match(html,/18h/);
  assert.match(html,/2d/);
  assert.doesNotMatch(html,/<select/);
  const locked=renderToStaticMarkup(React.createElement(panels().ExpiryChoices,{...props,disabled:true}));
  assert.ok([...locked.matchAll(/<button[^>]*>/g)].every(([button])=>button.includes('disabled')));
});

test('unlisted saved maturity is visible but cannot be chosen for a new trade',()=>{
  const now=1_800_000_000, saved=now-86400;
  const html=renderToStaticMarkup(React.createElement(panels().ExpiryChoices,{
    expiries:[now+86400],savedExpiry:saved,selected:saved,now,onSelect:()=>{},
  }));
  assert.equal((html.match(/<button/g) ?? []).length,2);
  assert.match(html,/<button(?=[^>]*disabled)(?=[^>]*aria-pressed="true")[^>]*>/);
  assert.match(html,/Saved/);
  assert.doesNotMatch(html,/1h left/);
  const empty=renderToStaticMarkup(React.createElement(panels().ExpiryChoices,{expiries:[],selected:0,now,onSelect:()=>{}}));
  assert.match(empty,/No expiries listed/);
  assert.doesNotMatch(empty,/<button|<select/);
});

test('lower-moneyness row shows actual signed distance, policy label and stock APR',()=>{
  const html=renderToStaticMarkup(React.createElement(panels().StrategyChoices,{
    symbol:'NVDA',selected:'atm',onSelect:()=>{},duration:'6d',description:'Choose a strike',
    choices:[{id:'atm',label:'At the money',target:'$210',protection:'$250',upside:'−0.7%',premium:'0.038',returnLabel:'Public estimate',apr:'96.314%',aprNote:'before fees'}],
  }));
  assert.match(html,/At the money/);
  assert.match(html,/−0\.7%/);
  assert.match(html,/96\.314%/);
  assert.match(html,/before fees/);
  assert.match(html,/Premium \(USDG\) \/ APR/);
  assert.match(html,/aria-label="0\.038 USDG">0\.038<\/strong>/);
  assert.doesNotMatch(html,/>0\.038 USDG</);
});

test('tiny strategy shows third decimal and stock-value net APR in the main review',()=>{
  const exports:Record<string,any>={};
  const modules:Record<string,unknown>={react:React,'react/jsx-runtime':jsx,'../utils/bn':{BN},
    '../structure/incomeProjection':{calculateIncome},'./StructureStockLogo':{default:()=>null}};
  const code=ts.transpileModule(readFileSync(join(__dirname,'StructurePanels.tsx'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  runInNewContext(code,{exports,require:(id:string)=>modules[id] ?? {}});
  const input={quantity:'0.01',multiplier:'1',tokenPrice:'200',spot:'200',shortStrike:'225',longStrike:'255',
    premiumPerShare:'0.7135',premium:'0.007135',loan:'0.300872',fee:'0.0006',borrowApr:'0.08',durationSeconds:'604800'};
  const html=renderToStaticMarkup(React.createElement(exports.StrategyReview,{symbol:'NVDA',input,accountSpecific:true}));
  const expected=calculateIncome(input).apr.times(100).toFormat(3);
  assert.match(html,/0\.007 USDG/);
  assert.match(html,/0\.006<small>USDG/);
  assert.match(html,/APR on stock/);
  assert.ok(html.includes(`${expected}%`));
  assert.match(html,/2\.000 USDG stock/);
  assert.match(html,/<details class="st-review-costs">/);
  assert.match(html,/<summary>Costs/);
  assert.doesNotMatch(html,/<details class="st-review-costs"[^>]*open/);
  assert.match(html,/Loan 0\.301 USDG/);
  assert.match(html,/variable APR/);
  assert.match(html,/Stock\/option losses/);
  const pending=renderToStaticMarkup(React.createElement(exports.StrategyReview,{symbol:'NVDA',input}));
  assert.match(pending,/Costs · quote needed/);
  assert.match(pending,/Before opening fees/);
  assert.doesNotMatch(pending,/Estimate details/);
});
