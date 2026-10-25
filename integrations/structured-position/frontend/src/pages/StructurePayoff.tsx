import {useId, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {BN} from '../utils/bn';
import {calculateIncome, incomePayoff, incomeRisk, type IncomeProjectionInput} from '../structure/incomeProjection';

const money = (value: InstanceType<typeof BN>, places = 3) => `${value.isNegative() ? '−' : ''}$${value.abs().toFormat(places)}`;
const cash = (value: InstanceType<typeof BN>) => `${value.isNegative() ? '−' : ''}${value.abs().toFormat(3)}`;

export function payoffPriceAtChartX(low:string,high:string,chartX:number):string {
  const minimum=new BN(low),maximum=new BN(high);
  if(!Number.isFinite(chartX) || !minimum.isFinite() || !maximum.isFinite() || minimum.lt(0) || !maximum.gt(minimum)) throw new Error('Invalid chart bounds or coordinate.');
  const fraction=BN.minimum(1,BN.maximum(0,new BN(chartX).minus(112).div(600)));
  return minimum.plus(maximum.minus(minimum).times(fraction)).toFixed();
}

/** A labeled linear zoom; the payoff and full downside are never rescaled independently. */
export function payoffChartBounds(input:IncomeProjectionInput) {
  const calc=calculateIncome(input),spot=new BN(input.spot),short=new BN(input.shortStrike),long=new BN(input.longStrike);
  const full={low:new BN(0),high:BN.maximum(spot.times('1.4'),long.times('1.1'))};
  if(!calc.overlayBreakeven || spot.gte(long)) return {full,focus:null};
  // Start the descending spread at mid-chart and keep both kinks in view.
  const radius=BN.maximum(short.minus(spot).abs(),long.minus(short)).times('1.1');
  const focus={low:short.minus(radius),high:short.plus(radius)};
  return {full,focus:focus.low.gte(0) ? focus : null};
}

export default function StructurePayoff({input, symbol, expiry, illustrative = false, variant = 'preview', valuationNote}: {input: IncomeProjectionInput; symbol: string; expiry: number; illustrative?: boolean; variant?:'preview'|'position'; valuationNote?:string}) {
  const id = useId();
  const position = variant === 'position';
  const [view, setView] = useState<'overlay' | 'combined'>(position ? 'combined' : 'overlay');
  const [asReturn, setAsReturn] = useState(false);
  const [inspection, setInspection] = useState<string|null>(null);
  const [chartRange,setChartRange]=useState<'income'|'full'>('income');
  const calculation = calculateIncome(input);
  const risk = position ? incomeRisk(input) : null;
  const spot = new BN(input.spot), short = new BN(input.shortStrike), long = new BN(input.longStrike);
  const referenceLabel=illustrative || position ? 'Reference' : 'Current';
  const strikeMove=(strike:InstanceType<typeof BN>)=>{const change=strike.div(spot).minus(1).times(100);return `${change.gte(0) ? '+' : ''}${change.toFormat(1)}%`;};
  const bounds=payoffChartBounds(input),focused=chartRange==='income' && Boolean(bounds.focus);
  const {low,high}=focused ? bounds.focus! : bounds.full;
  const inRange=(value:InstanceType<typeof BN>)=>value.gte(low) && value.lte(high);
  const prices = [low, spot, short, long, high,...(calculation.overlayBreakeven ? [calculation.overlayBreakeven] : [])]
    .filter(inRange).sort((a,b)=>a.comparedTo(b) ?? 0).filter((value,index,all)=>!index || !value.eq(all[index-1]));
  const points = prices.map(price => ({price, ...incomePayoff(input, price.toFixed())}));
  const values = points.flatMap(point => view === 'combined' ? [point.totalPnl, point.stockPnl] : [point.overlayPnl]);
  const maximum = BN.maximum(0, ...values), minimum = BN.minimum(0, ...values);
  const range = BN.maximum(maximum.minus(minimum), '0.00000001');
  const x = (price: InstanceType<typeof BN>) => 112 + price.minus(low).div(high.minus(low)).times(600).toNumber();
  const currentLabelX=Math.max(112,Math.min(500,x(spot)-106));
  const strikeLabelX=(strike:InstanceType<typeof BN>)=>Math.max(200,Math.min(624,x(strike)));
  const y = (value: InstanceType<typeof BN>) => 40 + maximum.minus(value).div(range).times(160).toNumber();
  const path = (key: 'overlayPnl' | 'totalPnl' | 'stockPnl') => points.map((point, index) =>
    `${index ? 'L' : 'M'}${x(point.price).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
  const scenarioPrice = inspection===null ? spot : BN.maximum(low,BN.minimum(high,new BN(inspection)));
  const scenario = incomePayoff(input, scenarioPrice.toFixed());
  const currentPayoff=inspection===null ? scenario : incomePayoff(input,input.spot);
  const shown = view === 'combined' ? scenario.totalPnl : scenario.overlayPnl;
  const display = (value: InstanceType<typeof BN>) => asReturn
    ? `${value.div(calculation.stockValue).times(100).toFormat(3)}%`
    : cash(value);
  const advantage=scenario.totalPnl.minus(scenario.stockPnl);
  const advantageText=`${advantage.gt(0) ? '+' : advantage.lt(0) ? '−' : ''}${asReturn ? advantage.abs().div(calculation.stockValue).times(100).toFormat(3)+'%' : advantage.abs().toFormat(5)+' USDG'}`;
  const axisDisplay = (value: InstanceType<typeof BN>) => asReturn ? `${value.div(calculation.stockValue).times(100).toFormat(1)}%` : value.abs().gte(1000) ? `${value.div(1000).toFormat(1)}k` : value.toFormat(value.abs().lt(1) ? 3 : 1);
  const curve = path(view === 'combined' ? 'totalPnl' : 'overlayPnl');
  const area = `${curve} L${x(high)},${y(new BN(0))} L${x(low)},${y(new BN(0))} Z`;
  const breakeven = calculation.overlayBreakeven;
  const lossPercent = (loss:InstanceType<typeof BN>) => `${loss.gt(0) ? '−' : ''}${loss.times(100).toFormat(3)}%`;
  const inspectPointer=(event:PointerEvent<SVGSVGElement>)=>{
    const svg=event.currentTarget,matrix=svg.getScreenCTM();
    if(!matrix) return;
    const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    setInspection(payoffPriceAtChartX(low.toFixed(),high.toFixed(),point.matrixTransform(matrix.inverse()).x));
  };
  const inspectKey=(event:KeyboardEvent<SVGSVGElement>)=>{
    if(event.key==='Escape') {setInspection(null);event.preventDefault();return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next=event.key==='Home' ? 112 : event.key==='End' ? 712 : x(scenarioPrice)+(event.key==='ArrowLeft' ? -1 : 1)*(event.shiftKey ? 60 : 6);
    setInspection(payoffPriceAtChartX(low.toFixed(),high.toFixed(),next));
  };
  const tooltipX=Math.max(112,Math.min(452,x(scenarioPrice)+(x(scenarioPrice)>452 ? -272 : 12)));
  const tooltipY=Math.max(30,Math.min(view==='combined' ? 122 : 142,y(shown)-(view==='combined' ? 92 : 72)));
  const inspectionLabel=`Stock at expiry ${scenarioPrice.toFormat(3)} dollars; ${view==='combined' ? 'total' : 'options and loan'} profit or loss ${display(shown)} ${asReturn ? '' : 'USDG'}${view==='combined' ? `; ${advantageText} versus holding stock only` : ''}`;

  return <section className={`st-panel st-payoff${position ? ' st-position-payoff' : ''}`} aria-labelledby={`${id}-title`}>
    <div className="st-section-title"><div>{position && <span className="st-eyebrow">Filled strategy · expiry model</span>}<h2 id={`${id}-title`}>{position ? 'Position payoff & risk' : 'Payoff'}</h2></div>
      <div className="st-segment" aria-label="Payoff view"><button type="button" aria-pressed={view === 'overlay'} onClick={() => setView('overlay')}>Options + loan</button><button type="button" aria-pressed={view === 'combined'} onClick={() => setView('combined')}>Include my stock</button></div></div>
    {risk && <><div className="st-position-risk" aria-label="Maximum modeled return and loss">
      <div><span>Max premium APR</span><strong className={risk.maxPremiumApr.lt(0) ? 'st-negative' : 'st-positive'}>{risk.maxPremiumApr.times(100).toFormat(3)}%</strong><small>{cash(calculation.netIncome)} USDG net premium · below ${short.toFormat(3)} at expiry</small></div>
      <div data-selected={view==='overlay'}><span>Max drawdown · options + loan</span><strong className={risk.maxOverlayLoss.gt(0) ? 'st-negative' : ''}>{lossPercent(risk.overlayLossOnStock)}</strong><small>{risk.maxOverlayLoss.gt(0) ? '−' : ''}{cash(risk.maxOverlayLoss)} USDG · at / above ${long.toFormat(3)}</small></div>
      <div data-selected={view==='combined'}><span>Max drawdown · incl. stock</span><strong className={risk.maxCombinedLoss.gt(0) ? 'st-negative' : ''}>{lossPercent(risk.combinedLossOnStock)}</strong><small>{risk.maxCombinedLoss.gt(0) ? '−' : ''}{cash(risk.maxCombinedLoss)} USDG · stock at ${risk.worstCombinedPrice.toFormat(3)}</small></div>
    </div><p className="st-position-risk-basis">Expiry loss ÷ stock token value ({cash(calculation.stockValue)} USDG).</p>
      <p className="st-position-valuation">Expiry loss, not peak-to-trough. Liquidation may occur earlier and is excluded.</p>
    </>}
    {illustrative && <p className="st-payoff-example-note">Sample prices and rates · not a live quote. {new BN(input.durationSeconds).div(86400).toFormat(0)}-day illustration for {input.quantity} {symbol} tokens.</p>}
    {asReturn && <p className="st-muted">Return on {cash(calculation.stockValue)} USDG of stock collateral value.</p>}
    <div className="st-payoff-zoom"><div className="st-segment" aria-label="Chart range"><button type="button" aria-pressed={focused} disabled={!bounds.focus} onClick={()=>{setChartRange('income');setInspection(null);}}>Strategy range</button><button type="button" aria-pressed={!focused} onClick={()=>{setChartRange('full');setInspection(null);}}>Full range</button></div><span title="Linear axes. Select Full range to see the full price window.">{focused ? 'Zoomed' : bounds.focus ? 'Full range' : 'Range from $0'}</span></div>
    <div className="st-chart-caption"><div className="st-chart-legend"><span><i/> {view === 'combined' ? 'Stock + options + loan' : 'Options + loan'}</span>{view === 'combined' && <span><i className="st-holding-swatch"/> Hold stock only</span>}</div>
      {view==='combined' && <strong className={`st-holding-advantage ${advantage.lt(0) ? 'st-negative' : 'st-positive'}`}>vs holding {advantageText}</strong>}<span>P&amp;L ({asReturn ? '%' : 'USDG'})</span></div>
    <div className="st-payoff-chart-scroll"><svg className="st-chart st-chart-interactive" viewBox="0 0 760 264" role="img" tabIndex={0}
      aria-describedby={`${id}-chart-help`} aria-label={`${symbol} payoff chart from $${low.toFixed(2)} to $${high.toFixed(2)} at expiry. ${focused ? 'Strategy range, zoomed linear axes. ' : 'Full price window, linear axes. '}${referenceLabel} price $${spot.toFormat(3)}. Sell strike $${short.toFixed(2)}, ${strikeMove(short)}; buy strike $${long.toFixed(2)}, ${strikeMove(long)} versus ${referenceLabel.toLowerCase()} price. Green shows profit; red shows loss.${inspection!==null ? ` ${inspectionLabel}.` : ''}`}
      onPointerMove={inspectPointer} onPointerDown={inspectPointer} onPointerLeave={event=>{if(event.pointerType!=='touch') setInspection(null);}}
      onPointerCancel={()=>setInspection(null)} onFocus={()=>setInspection(value=>value ?? spot.toFixed())} onBlur={()=>setInspection(null)} onKeyDown={inspectKey}>
      <desc id={`${id}-chart-help`}>Hover or tap to inspect price and profit / loss. Use arrow keys to move, Home / End for the chart limits, and Escape to dismiss.</desc>
      <defs><clipPath id={`${id}-profit`}><rect x="112" y="24" width="600" height={Math.max(0, y(new BN(0)) - 24)}/></clipPath><clipPath id={`${id}-loss`}><rect x="112" y={y(new BN(0))} width="600" height={216 - y(new BN(0))}/></clipPath></defs>
      <path d={area} fill="var(--st-green)" fillOpacity=".13" clipPath={`url(#${id}-profit)`}/><path d={area} fill="var(--st-red)" fillOpacity=".13" clipPath={`url(#${id}-loss)`}/>
      {view==='combined' && points.slice(1).map((point,index)=>{const previous=points[index],delta=previous.overlayPnl.plus(point.overlayPnl);
        return delta.isZero() ? null : <path key={index} className="st-comparison-band" data-advantage={delta.gt(0) ? 'positive' : 'negative'} aria-hidden="true"
          d={`M${x(previous.price)},${y(previous.totalPnl)} L${x(point.price)},${y(point.totalPnl)} L${x(point.price)},${y(point.stockPnl)} L${x(previous.price)},${y(previous.stockPnl)} Z`}
          fill={delta.gt(0) ? 'var(--st-green)' : 'var(--st-red)'} fillOpacity=".24"/>;})}
      <line x1="112" x2="712" y1={y(new BN(0))} y2={y(new BN(0))} stroke="var(--st-muted)" strokeDasharray="5 5"/>
      {[short,long].filter(inRange).map((strike, index) => <line key={index} x1={x(strike)} x2={x(strike)} y1="24" y2="212" stroke="var(--st-border)" strokeDasharray="3 4"/>)}
      <text x="102" y={y(new BN(0)) + 4} textAnchor="end">{asReturn ? '0%' : '0'}</text>
      {maximum.gt(0) && <text x="102" y="26" textAnchor="end">{axisDisplay(maximum)}</text>}
      {minimum.lt(0) && <text x="102" y="218" textAnchor="end">{axisDisplay(minimum)}</text>}
      {view === 'combined' && <path d={path('stockPnl')} fill="none" stroke="var(--st-muted)" strokeWidth="2" strokeDasharray="7 5"/>}
      <path d={curve} fill="none" stroke="var(--st-green)" strokeWidth="3" clipPath={`url(#${id}-profit)`}/><path d={curve} fill="none" stroke="var(--st-red)" strokeWidth="3" clipPath={`url(#${id}-loss)`}/>
      <g className="st-current-price" pointerEvents="none">
        <line x1={x(spot)} x2={x(spot)} y1="30" y2="212" stroke="var(--st-accent)" strokeWidth="2" strokeDasharray="4 3"/>
        <circle cx={x(spot)} cy={y(view==='combined' ? currentPayoff.totalPnl : currentPayoff.overlayPnl)} r="4.5" fill="var(--st-accent)" stroke="var(--st-bg)" strokeWidth="2"/>
        <rect x={currentLabelX} y="0" width="212" height="30" rx="5"/>
        <text x={currentLabelX+106} y="21" textAnchor="middle">{referenceLabel} ${spot.toFormat(3)}</text>
      </g>
      {view === 'overlay' && breakeven && inRange(breakeven) && <circle cx={x(breakeven)} cy={y(new BN(0))} r="5" fill="var(--st-text)"><title>{`Options break-even: ${money(breakeven)}`}</title></circle>}
      {inspection!==null && <g pointerEvents="none" aria-hidden="true">
        <line x1={x(scenarioPrice)} x2={x(scenarioPrice)} y1="24" y2="212" stroke="var(--st-text)" opacity=".35"/>
        <circle cx={x(scenarioPrice)} cy={y(shown)} r="5" fill={shown.lt(0) ? 'var(--st-red)' : 'var(--st-green)'} stroke="var(--st-bg)" strokeWidth="2"/>
        <g className="st-payoff-tooltip" transform={`translate(${tooltipX},${tooltipY})`}>
          <rect width="260" height={view==='combined' ? 80 : 60} rx="6"/>
          <text x="12" y="23">Stock at expiry: ${scenarioPrice.toFormat(3)}</text>
          <text x="12" y="45" className={shown.lt(0) ? 'st-tooltip-loss' : 'st-tooltip-profit'}>{view==='combined' ? 'Total P&L' : 'Options + loan'}: {display(shown)}{!asReturn && ' USDG'}</text>
          {view==='combined' && <text x="12" y="66" className={advantage.lt(0) ? 'st-tooltip-loss' : 'st-tooltip-profit'}>vs holding: {advantageText}</text>}
        </g>
      </g>}
      {inRange(short) && <text className="st-strike-label" x={strikeLabelX(short)} y="226" textAnchor="middle">Sell ${short.toFixed(2)}<tspan className="st-strike-change"> · {strikeMove(short)}</tspan></text>}{inRange(long) && <text className="st-strike-label" x={strikeLabelX(long)} y="242" textAnchor="middle">Buy ${long.toFixed(2)}<tspan className="st-strike-change"> · {strikeMove(long)}</tspan></text>}
      <text x="112" y="260">${low.toFormat(3)}</text><text x="712" y="260" textAnchor="end">${high.toFormat(3)}</text><text x="395" y="260" textAnchor="middle">{symbol} price at expiry (USD)</text>
    </svg></div>
    <div className="st-mobile-strikes"><span>Sell ${short.toFixed(2)} · {strikeMove(short)}</span><span>Buy ${long.toFixed(2)} · {strikeMove(long)}</span></div>
    {position && <div className="st-position-stress"><button type="button" className="st-outline-btn" onClick={()=>{setChartRange('full');setInspection('0');}}>Stock falls to $0</button><button type="button" className="st-text-link" onClick={()=>setInspection(null)}>Reset scenario</button></div>}
    <details className="st-disclosure"><summary>Details</summary>
    <div className="st-live-legs"><div><span className="st-leg-sell">LEG 1 · SELL CALL</span><strong>${short.toFormat(3)}</strong><span>{symbol}</span></div><div><span className="st-leg-buy">LEG 2 · BUY CALL</span><strong>${long.toFormat(3)}</strong><span>{symbol}</span></div></div>
    {valuationNote && <p className="st-muted">{valuationNote}</p>}
    <p className="st-muted">Both legs expire {new Date(expiry * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC. The bought call limits the options loss above its strike. Stock and borrowing risks remain.</p>
    <div className="st-payoff-summary"><div><span>Potential options income</span><strong>{cash(calculation.netIncome)} <small>USDG</small></strong></div><div><span>Modeled options + loan loss</span><strong>{cash(calculation.maxOverlayLoss)} <small>USDG</small></strong></div><div><span>Options break-even</span><strong>{breakeven ? money(breakeven) : calculation.netIncome.isZero() ? `≤ ${money(short)}` : 'No break-even'}</strong></div></div>
    <div className="st-payoff-units"><span>Show returns in</span><div className="st-segment" role="group" aria-label="Return unit"><button type="button" aria-pressed={!asReturn} onClick={() => setAsReturn(false)}>USDG</button><button type="button" aria-pressed={asReturn} onClick={() => setAsReturn(true)}>Stock value (%)</button></div></div>
<p className="st-muted">Includes premium, estimated borrowing interest and any supplied opening fee and network cost estimates. {input.fee === undefined && 'The account-specific opening fee is not yet included. '}Excludes liquidation, closing and settlement costs, and early exercise. Stock downside remains. The break-even above applies to options + loan only.</p></details>
  </section>;
}
