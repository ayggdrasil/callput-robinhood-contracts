import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import StructurePayoff, {payoffPriceAtChartX,payoffChartBounds} from './StructurePayoff';
import {exampleIncome, EXAMPLE_ASSETS} from '../structure/exampleIncome';
import {calculateIncome,incomePayoff} from '../structure/incomeProjection';
import {BN} from '../utils/bn';

const input = {quantity:'10', multiplier:'0.5', tokenPrice:'50', spot:'100', shortStrike:'105', longStrike:'120',
  premiumPerShare:'3', borrowApr:'0.1', durationSeconds:'3153600', fee:'1', lltv:'0.625'};
const render = (extra = {}) => renderToStaticMarkup(createElement(StructurePayoff, {input, symbol:'NVDA', expiry:1800000000, ...extra}));

test('payoff shows net overlay breakeven and a focusable chart without a gauge', () => {
  const html = render();
  assert.match(html, /<h2[^>]*>Payoff<\/h2>/);
  assert.match(html, /Options break-even/);
  assert.match(html, /107\.648/);
  assert.match(html, /USDG/);
  assert.doesNotMatch(html, /type="range"|class="st-scenario"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /Hover or tap/);
  assert.match(html, /arrow keys/i);
  assert.match(html, /<svg/);
  assert.match(html, /Strategy range/);
  assert.match(html, /Full range/);
  assert.match(html, /Linear axes/);
  assert.match(html, />Zoomed<\/span>/);
  assert.doesNotMatch(html, /Zoomed \(Full range available\)/);
  const svg=html.slice(html.indexOf('<svg'),html.indexOf('</svg>'));
  assert.match(svg,/Buy \$120\.00/,'the protective strike must be visible in the strategy range');
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('strategy range starts its descending overlay at the midpoint and includes both kinks',()=>{
  const calc=calculateIncome(input),bounds=payoffChartBounds(input),focus=bounds.focus;
  assert.ok(focus);
  assert.ok(focus.low.lte(input.spot) && focus.high.gte(input.spot));
  assert.ok(new BN(input.shortStrike).minus(focus.low).eq(focus.high.minus(input.shortStrike)));
  assert.equal(payoffPriceAtChartX(focus.low.toFixed(),focus.high.toFixed(),412),input.shortStrike);
  assert.ok(focus.high.gt(input.longStrike),'include a small flat tail after the bought call');
  assert.ok(focus.high.lt(bounds.full.high));
  assert.ok(incomePayoff(input,input.shortStrike).overlayPnl.eq(calc.netIncome));
  assert.ok(incomePayoff(input,'110').overlayPnl.lt(calc.netIncome));
  const end=incomePayoff(input,focus.high.toFixed()).overlayPnl;
  assert.ok(end.eq(calc.maxOverlayLoss.negated()),'retain the actual capped spread loss');
  assert.equal(bounds.full.low.toFixed(),'0');
  assert.ok(bounds.full.high.gte(input.longStrike));
});

test('focus falls back to full range rather than hiding losses at an already high current price',()=>{
  assert.equal(payoffChartBounds({...input,spot:'130'}).focus,null);
  assert.equal(payoffChartBounds({...input,spot:'1'}).focus,null,'a symmetric loss window must not imply negative stock prices');
  assert.equal(payoffChartBounds({...input,fee:'20'}).focus,null);
  const html=render({input:{...input,fee:'20'}});
  assert.match(html, /Full range/);
  assert.match(html, /Range from \$0/);
  assert.doesNotMatch(html,/NaN|Infinity/);
  const combined=render({variant:'position',input:{...input,fee:'20'}});
  assert.match(combined,/data-advantage="negative"/);
  assert.doesNotMatch(combined,/data-advantage="positive"/);
});

test('focus bounds scale precisely and the comparison delta is the real overlay at every sampled price',()=>{
  const tiny={...input,spot:'0.0001',tokenPrice:'0.0001',shortStrike:'0.000105',longStrike:'0.00012',premiumPerShare:'0.000003',fee:'0',borrowApr:'0'};
  const focus=payoffChartBounds(tiny).focus;
  assert.ok(focus && focus.low.gte(0) && focus.high.gt(focus.low));
  assert.ok(new BN(tiny.shortStrike).minus(focus.low).eq(focus.high.minus(tiny.shortStrike)));
  for(const price of ['0','99','100','105','107.648','120','140']) {
    const payoff=incomePayoff(input,price);
    assert.ok(payoff.totalPnl.minus(payoff.stockPnl).eq(payoff.overlayPnl));
  }
  assert.ok(incomePayoff(input,'100').overlayPnl.gt(0));
  assert.ok(incomePayoff(input,'120').overlayPnl.lt(0));
  const html=render({variant:'position'});
  assert.match(html,/vs holding/);
  assert.match(html,/st-comparison-band/);
  assert.ok(new BN(focus.high).isFinite());
});

test('current price is highlighted and each strike reports its signed move from that price',()=>{
  const html=render();
  assert.match(html,/class="st-current-price"/);
  assert.match(html,/Current \$100\.000/);
  assert.match(html,/Sell \$105\.00/);
  assert.match(html,/Buy \$120\.00/);
  assert.match(html,/\+5\.0%/);
  assert.match(html,/\+20\.0%/);
  const itm=render({input:{...input,spot:'110'}});
  assert.match(itm,/-4\.5%/);
  assert.match(itm,/\+9\.1%/);
  const position=render({variant:'position'});
  assert.match(position,/Reference \$100\.000/);
  assert.doesNotMatch(position,/Current \$100\.000/);
});

test('illustrative chart visibly distinguishes sample prices from a live quote', () => {
  const html = render({illustrative:true});
  assert.match(html, /Sample prices and rates · not a live quote/);
});

test('filled position calculator shows exact expiry risk on stock value and full downside controls',()=>{
  const html=render({variant:'position',valuationNote:'Entry value saved.'});
  assert.match(html,/Position payoff &amp; risk/);
  assert.match(html,/Max premium APR/);
  assert.match(html,/26\.480%/);
  assert.match(html,/Max drawdown · options \+ loan/);
  assert.match(html,/12\.352%/);
  assert.match(html,/Max drawdown · incl\. stock/);
  assert.match(html,/97\.352%/);
  assert.doesNotMatch(html,/type="range"/);
  assert.match(html,/Stock falls to \$0/);
  assert.match(html,/Entry value saved\./);
  assert.match(html,/<summary>Details<\/summary>/);
  assert.match(html,/Expiry loss ÷ stock token value/);
  assert.match(html,/liquidation/i);
  assert.doesNotMatch(html,/NaN|Infinity/);
});

test('chart inspection uses plot coordinates and clamps both edges',()=>{
  assert.equal(payoffPriceAtChartX('70','140',112),'70');
  assert.equal(payoffPriceAtChartX('70','140',412),'105');
  assert.equal(payoffPriceAtChartX('70','140',712),'140');
  assert.equal(payoffPriceAtChartX('70','140',0),'70');
  assert.equal(payoffPriceAtChartX('70','140',1000),'140');
});

test('position inspection includes zero and supports tiny fractional stock prices',()=>{
  assert.equal(payoffPriceAtChartX('0','140',112),'0');
  assert.equal(payoffPriceAtChartX('0','140',412),'70');
  assert.equal(payoffPriceAtChartX('0.00000001','0.00000003',412),'0.00000002');
  assert.throws(()=>payoffPriceAtChartX('70','140',NaN));
  assert.throws(()=>payoffPriceAtChartX('140','70',412));
});

test('all supported stocks have a finite illustrative chart without market or wallet data', () => {
  for (const symbol of Object.keys(EXAMPLE_ASSETS) as (keyof typeof EXAMPLE_ASSETS)[]) {
    for (const style of ['balanced', 'conservative'] as const) {
      const example = exampleIncome(symbol, '1', 30, style);
      const html = render({input:example.input, symbol, illustrative:true});
      assert.match(html, /<svg/);
      assert.match(html, /30-day illustration/);
      assert.match(html, /not a live quote/);
      assert.doesNotMatch(html, /NaN|Infinity/);
      assert.ok(example.result.overlayBreakeven?.gt(example.short));
      assert.ok(example.result.overlayBreakeven?.lt(example.long));
    }
  }
  assert.throws(() => exampleIncome('NVDA', '0', 30, 'balanced'));
  assert.throws(() => exampleIncome('NVDA', 'not-a-number', 30, 'balanced'));
});
