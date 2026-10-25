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
import {morphoMarketUrl, STOCK_INCOME_MARKETS} from '../networks/stockIncome';
import * as recovery from '../structure/recovery';
import * as execution from '../structure/execution';
import * as workflow from '../structure/workflow';
import {positionIncome} from '../structure/positionIncome';
import * as strategy from '../structure/strategy';
import {calculateIncome} from '../structure/incomeProjection';
import StructureProgress from './StructureProgress';

const panelExports:Record<string,any>={};
runInNewContext(ts.transpileModule(readFileSync(join(__dirname,'StructurePanels.tsx'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText,{exports:panelExports,require:(id:string)=>({'react/jsx-runtime':jsx,'../utils/bn':{BN},'./StructureStockLogo':{default:()=>null}}[id] ?? {})});

function render(walletMode: boolean, overrides = {}) {
  const exports: Record<string, any> = {};
  const h = {walletMode, address: '0x1111111111111111111111111111111111111111', tradingAddress: '0x1111111111111111111111111111111111111111',
    chainId: 4663, access: {snapshot: null, consent: null, stage: 'loading', controller: null},
    market: STOCK_INCOME_MARKETS[0], marketData: {futuresAssetIndexMap: {}, market: {}}, expiries: [2_000_000_000], expiry: 2_000_000_000,
    quantity: '1', style: 'balanced', now: Date.now(), journal: null, positions: [], review: null, snapshot: null,
    holdingBalance: null, holdingMultiplier: null, login: {ready: true}, error: '', busy: false, ...overrides};
  const none = () => null;
  const modules: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, viem: {}, '../utils/bn': {BN},
    'react-router-dom': {Link: ({children}: any) => React.createElement('a', {}, children)},
    '../networks/apis': {BLOCK_EXPLORER: {}}, '../networks/stockIncome': {STOCK_INCOME_MARKETS, morphoMarketUrl},
    '../structure/useStockIncome': {useStockIncome: () => h},
    '../structure/recovery': recovery,
    '../structure/execution': execution,
    '../structure/workflow': workflow,
    '../structure/positionIncome': {positionIncome},
    '../structure/strategy': strategy,
    '../structure/incomeProjection': {calculateIncome},
    './StructurePanels': {HoldingsSummary: ({controls}:any)=>React.createElement('section',{},controls), StrategyChoices: panelExports.StrategyChoices,
      ExpiryChoices:panelExports.ExpiryChoices,StrategyReview: ({children}: any) => React.createElement('section', {}, children)},
    './StructureStockLogo': {default: none}, './StructureExample': {default: none}, './StructurePayoff': {default: ({variant}:any)=>variant==='position' ? React.createElement('div',{},'Saved position payoff calculator') : null},
    './StructureProgress': {default: StructureProgress},
    '../components/NavBar/Wallet': {default: none}, '../components/NavBar/ToggleChain': {default: none},
  };
  const code = ts.transpileModule(readFileSync(join(__dirname, 'Structure.tsx'), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  }).outputText.replaceAll('import.meta.env.DEV', 'true');
  runInNewContext(code, {exports, require: (id: string) => modules[id] ?? {}, window: {location: {hostname: 'localhost'}}, console});
  return renderToStaticMarkup(React.createElement(exports.default));
}

test('connected local wallet can review without deposit account setup or HTTPS login', () => {
  const html = render(true);
  assert.match(html, /Review strategy/);
  assert.match(html, /Wallet trading/);
  assert.doesNotMatch(html, /Enable trading|requires the configured HTTPS/);
});

test('active execution shows the full sequence beside one primary action and keeps errors local',()=>{
  const saved={plan:{id:'progress',quantity:'0.01',quote:{quotedAt:90,amount:'300900'},
    spread:{symbol:'NVDA',expiry:2_000_000_000,short:{strikePrice:225},long:{strikePrice:255}}},
    steps:{approve:{status:'confirmed'},supply:{status:'pending',hash:`0x${'a'.repeat(64)}`},borrow:{status:'idle'}}};
  const html=render(true,{journal:saved,now:100_000,error:'Check the pending transaction.'});
  assert.match(html,/Strategy setup progress/);
  assert.match(html,/USDG approval/);
  assert.match(html,/Automatic fill/);
  assert.match(html,/Confirming on-chain/);
  assert.match(html,/Check the pending transaction\./);
  assert.doesNotMatch(html,/class="st-outline-btn st-wide"[^>]*>Refresh funding quote/);
  assert.match(html,/Quote &amp; recovery/);
});

test('funded unavailable legs offer explicit replacement review instead of another financial attempt',()=>{
  const journal={plan:{id:'saved',style:'balanced',quantity:'0.01',quote:{quotedAt:90,amount:'300900'},spread:{symbol:'NVDA',expiry:2_000_000_000,short:{strikePrice:225},long:{strikePrice:255}}},
    steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'confirmed'}}};
  const html=render(true,{journal,now:100_000,error:'A saved spread leg is unavailable.'});
  assert.match(html,/Refresh order quote/);
  assert.match(html,/Review available Balanced strategy/);
  assert.doesNotMatch(html,/Approve USDG \/ open spread|Continue funding/);
});

test('deposit mode still requires its trading account access', () => {
  const html = render(false);
  assert.match(html, /Enable trading/);
  assert.match(html, /requires the configured HTTPS/);
});

test('filled strategy offers a new builder while keeping prior positions visible', () => {
  const filled = (id: string) => ({version:1, plan:{id, chainId:4663, marketId:STOCK_INCOME_MARKETS[0].id,
    quantity:'0.01',quote:{quotedAt:90,amount:'300900'},spread:{symbol:'NVDA',expiry:2_000_000_000,short:{strikePrice:225},long:{strikePrice:255}}},
    steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'confirmed'}},order:{status:'filled'}});
  const first = filled('first'), second = filled('second');
  const html=render(true,{journal:second,positions:[first,second],now:100_000});
  assert.match(html,/New strategy/);
  assert.equal((html.match(/NVDA stock income/g) ?? []).length,2);
  assert.match(html,/View strategy/);
  const pending=render(true,{journal:{...second,order:{status:'pending'}},positions:[first],now:100_000});
  assert.doesNotMatch(pending,/New strategy/);
});

test('safe filled positions allow choosing the next option or expiry directly',()=>{
  const journal={plan:{id:'filled',quantity:'0.01',quote:{quotedAt:90,amount:'300900'},
    spread:{symbol:'NVDA',expiry:2_000_000_000,short:{strikePrice:225},long:{strikePrice:255}}},
    steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'confirmed'}},order:{status:'filled'}};
  const rows=(html:string)=>[...html.matchAll(/<button[^>]*class="st-strategy-row"[^>]*>/g)].map(item=>item[0]);
  const html=render(true,{journal,positions:[journal],now:100_000});
  assert.equal(rows(html).length,5);
  assert.ok(rows(html).every(row=>!row.includes('disabled')),'filled option rows must stay selectable');
  const expiryButtons=(markup:string)=>[...markup.matchAll(/<button[^>]*class="st-expiry-option"[^>]*>/g)].map(item=>item[0]);
  assert.ok(expiryButtons(html).length>0);
  assert.ok(expiryButtons(html).every(button=>!button.includes('disabled')));
  for (const overrides of [{busy:true},{journal:{...journal,order:{status:'pending'}}},
    {journal:{...journal,incomeBasis:{tokenPrice:'200',borrowApr:'0.08',startedAt:90}}},
    {journal:{...journal,walletApproval:{status:'unknown'}}},{journal:{...journal,management:{status:'pending'}}}]) {
    const locked=render(true,{journal,now:100_000,...overrides});
    assert.ok(rows(locked).every(row=>row.includes('disabled')),'unresolved financial work must keep its inputs locked');
    assert.ok(expiryButtons(locked).every(button=>button.includes('disabled')));
  }
});

test('legacy saved legs are not assigned a guessed preset and replacement requires explicit style',()=>{
  const journal={plan:{id:'legacy',quantity:'0.01',quote:{quotedAt:90,amount:'300900'},
    spread:{symbol:'NVDA',expiry:2_000_000_000,short:{strikePrice:235},long:{strikePrice:295}}},
    steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'confirmed'}}};
  const html=render(true,{journal,now:100_000,error:'A saved spread leg is unavailable.'});
  assert.match(html,/Saved strategy/);
  assert.doesNotMatch(html,/class="st-strategy-row"[^>]*aria-pressed="true"/);
  assert.match(html,/Choose replacement style/);
  assert.match(html,/<button(?=[^>]*disabled)[^>]*>Choose replacement strategy/);
  assert.doesNotMatch(html,/Review available Balanced/);
});

test('live builder exposes lower moneyness and per-choice APR without inventing shorter markets',()=>{
  const now=Date.now(), expiry=Math.floor(now/1000)+6*86400;
  const call=[90,95,100,102,105,110,130].map((strikePrice,i)=>({strikePrice,markPrice:(140-strikePrice)/5,
    optionId:`0x${(i+1).toString(16).padStart(64,'0')}`,isOptionAvailable:true}));
  const html=render(true,{style:'atm',now,expiry,expiries:[expiry],quantity:'0.01',
    marketData:{sourceChain:'Robinhood',sourceTimestamp:now,futuresAssetIndexMap:{NVDA:100},market:{NVDA:{expiries:[expiry],options:{[expiry]:{call,put:[]}}}}},
    snapshot:{block:1n,checkedAt:now,multiplier:10n**18n,oraclePrice:100n*10n**24n,borrowRate:1000000000n,debt:0n,position:{collateral:0n}},
  });
  assert.match(html,/In the money/);
  assert.match(html,/At the money/);
  assert.match(html,/Near the money/);
  assert.match(html,/-5\.0%/);
  assert.match(html,/\+0\.0%/);
  assert.match(html,/before fees/);
  assert.doesNotMatch(html,/Within 1 day|Within 3 days|All expiries/);
  assert.match(html,/Expiry/);
  assert.match(html,/Guide/);
  assert.doesNotMatch(html,/Example portfolio|Risk &amp; details/);
  assert.match(html,/>Details<\/button>/);
});

test('supplied collateral requires a new review when the borrowing quote is stale or a preflight failed', () => {
  const journal = {plan:{id:'saved',style:'balanced',quantity:'0.01', quote:{quotedAt:90,amount:'300900'},
    spread:{symbol:'NVDA',expiry:2_000_000_000,short:{strikePrice:225},long:{strikePrice:255}}},
    steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'idle'}}};
  const fresh = render(true,{journal,now:100_000});
  assert.match(fresh,/Borrow 0\.30090 USDG/);
  assert.doesNotMatch(fresh,/Continue funding/);
  for(const extra of [{now:140_000},{now:100_000,journal:{...journal,error:'The refreshed premium worsened by 5% or more.'}}]) {
    const stale = render(true,{journal,...extra});
    assert.match(stale,/Review updated quote/);
    assert.doesNotMatch(stale,/Borrow 0\.30090 USDG|Continue funding/);
  }
  const unavailable = render(true,{journal,now:100_000,error:'A saved spread leg is unavailable.'});
  assert.match(unavailable,/Review current Balanced strategy/);
  assert.doesNotMatch(unavailable,/Borrow 0\.30090 USDG|Continue funding/);
});

test('each filled strategy has its own payoff calculator and unavailable estimates stay explicit',()=>{
  const journal={version:1,plan:{id:'analyzed',chainId:4663,owner:'0x1111111111111111111111111111111111111111',marketId:STOCK_INCOME_MARKETS[0].id,
    quantity:'0.01',multiplier:'1',quote:{quotedAt:1_000_000,amount:'300600',fee:'600',size:'10000000000000000',premiumAmount:'7000'},
    spread:{symbol:'NVDA',expiry:1_604_800,width:'30',premium:'0.7',short:{strikePrice:225},long:{strikePrice:255}}},
    incomeBasis:{tokenPrice:'200',borrowApr:'0.08',startedAt:1_000_000},steps:{approve:{status:'confirmed'},supply:{status:'confirmed'},borrow:{status:'confirmed'}},
    order:{status:'filled',fill:{size:'10000000000000000',premium:'7100',filledAt:1_000_000}}};
  const another={...journal,plan:{...journal.plan,id:'another'}};
  const html=render(true,{journal,positions:[journal,another],now:1_001_000_000});
  assert.equal((html.match(/Saved position payoff calculator/g) ?? []).length,2);
  const pending={...journal,order:{status:'pending'}};
  assert.doesNotMatch(render(true,{journal:pending,positions:[pending]}),/Saved position payoff calculator/);
  const missing={...journal,incomeBasis:undefined};
  const unavailable=render(true,{journal:missing,positions:[missing]});
  assert.match(unavailable,/Payoff estimate unavailable/);
  assert.doesNotMatch(unavailable,/Saved position payoff calculator/);
});
