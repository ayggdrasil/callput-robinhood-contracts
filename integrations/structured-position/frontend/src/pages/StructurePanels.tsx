import type {ReactNode} from 'react';
import type {IncomeProjectionInput} from '../structure/incomeProjection';
import {calculateIncome} from '../structure/incomeProjection';
import {BN} from '../utils/bn';
import StructureStockLogo from './StructureStockLogo';
import type {SpreadStyle} from '../structure/strategy';

type StockSymbol = 'NVDA' | 'TSLA' | 'AAPL';
export type StrategyChoice = {id:SpreadStyle; label?:string; target:string; protection:string; upside:string; premium:string; returnLabel?:string; apr?:string; aprNote?:string};

export function expiryDuration(expiry:number, now:number) {
  const hours=Math.max(1,Math.ceil((expiry-now)/3600));
  const days=Math.floor(hours/24), rest=hours%24;
  return days ? `${days}d${rest ? ` ${rest}h` : ''}` : `${hours}h`;
}

export function ExpiryChoices({expiries,selected,now,disabled,onSelect,savedExpiry}: {expiries:number[]; selected:number; now:number; disabled?:boolean; onSelect(value:number):void; savedExpiry?:number}) {
  const listed=[...new Set(expiries.filter(value=>Number.isSafeInteger(value) && value>now))].sort((a,b)=>a-b);
  const values=savedExpiry && Number.isSafeInteger(savedExpiry) && savedExpiry>0 && !listed.includes(savedExpiry) ? [...listed,savedExpiry].sort((a,b)=>a-b) : listed;
  const exact=(value:number)=>new Date(value*1000).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC';
  return <div className="st-expiry-picker"><div className="st-expiry-caption"><span>Expiry</span>{Number.isSafeInteger(selected) && selected>0 && <span>{exact(selected)}</span>}</div><div className="st-expiry-options" role="group" aria-label="Choose expiry">{values.map(value=>{
    const date=new Date(value*1000),saved=!listed.includes(value);
    return <button type="button" className="st-expiry-option" key={value} disabled={disabled || saved} aria-pressed={selected===value} aria-label={`${exact(value)}${saved ? ' · saved, not listed' : ` · ${expiryDuration(value,now)}`}`} title={exact(value)} onClick={()=>{if(!saved) onSelect(value);}}>
      <span>{date.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})}{!saved && ` · ${expiryDuration(value,now)}`}</span>
      {saved && <small>Saved · not listed</small>}
    </button>;
  })}</div>{!values.length && <p className="st-muted" role="status">No expiries listed.</p>}
  </div>;
}

export function HoldingsSummary({symbol, shares, value, price, illustrative, controls, unit = 'shares', note}: {symbol:StockSymbol; shares:string; value:string; price:string; illustrative:boolean; controls:ReactNode; unit?:'shares'|'tokens'; note?:ReactNode}) {
  return <section className="st-holdings" aria-label="Stock holdings">
    <div className="st-holding-stock"><StructureStockLogo symbol={symbol} className="st-holding-logo"/><div><span className="st-caption">{illustrative ? 'Sample holdings' : 'Wallet holdings'}</span><strong>{shares} {symbol}{unit === 'tokens' ? ' tokens' : '-equivalent shares'}</strong>{note && <small className="st-muted" role="status">{note}</small>}</div></div>
    <div className="st-holding-value"><span className="st-caption">{illustrative ? 'Sample value' : 'Est. value'}</span><div><strong>{value}</strong><span>{price}</span></div></div>
    <details className="st-holding-edit"><summary>Edit <span aria-hidden="true">↗</span></summary><div className="st-holding-controls">{controls}</div></details>
  </section>;
}

export function StrategyChoices({symbol, selected, choices, onSelect, disabled, duration, description, expiryControls}: {symbol:StockSymbol; selected:string; choices:StrategyChoice[]; onSelect(value:StrategyChoice['id']):void; disabled?:boolean; duration?:ReactNode; description?:string; expiryControls?:ReactNode}) {
  return <section className="st-panel st-strategies" aria-labelledby="st-strategies-title"><div className="st-section-title"><h2 id="st-strategies-title">Choose a strategy</h2>{duration}</div>{description && <p className="st-panel-description">{description}</p>}
    {expiryControls}
    <div className="st-strategy-head" aria-hidden="true"><span>Call spread</span><span>Sell strike · vs spot</span><span>{choices.some(choice=>choice.apr) ? 'Premium (USDG) / APR' : 'Premium (USDG)'}</span></div>
    <div className="st-strategy-choices" role="group" aria-label="Choose a call spread">{choices.map(choice => <button type="button" className="st-strategy-row" key={choice.id} aria-pressed={selected === choice.id} disabled={disabled} onClick={() => onSelect(choice.id)}>
      <span className="st-strategy-name"><i className="st-radio" aria-hidden="true"/><span>{choice.label ?? `${symbol} · Sell call spread`}<small>Buy {choice.protection}</small></span></span>
      <span className="st-strategy-target"><span className="st-mobile-label">Target</span>{choice.target}<small>{choice.upside}</small></span>
      <span className="st-strategy-premium"><span className="st-mobile-label">Premium (USDG)</span><strong aria-label={`${choice.premium} USDG`}>{choice.premium}</strong>{choice.apr && <small className="st-choice-apr" aria-label={`${choice.apr} APR ${choice.aprNote ?? ''} on stock value`}><span className="st-mobile-label">APR </span>{choice.apr} <span>{choice.aprNote}</span></small>}{choice.returnLabel && <small>{choice.returnLabel}</small>}</span>
    </button>)}</div>
    {choices.some(choice=>choice.apr) && <p className="st-choice-note">APR on stock · excludes settlement losses.</p>}
  </section>;
}

export function StrategyReview({symbol, input, illustrative, accountSpecific, valuationNote, children}: {symbol:StockSymbol; input?:IncomeProjectionInput; illustrative?:boolean; accountSpecific?:boolean; valuationNote?:string; children:ReactNode}) {
  const result = input ? calculateIncome(input) : null;
  const days = input ? new BN(input.durationSeconds).div(86400).toFormat(1).replace(/\.0$/, '') : '—';
  const amount = (v?:InstanceType<typeof BN>) => v ? `${v.toFormat(3)} USDG` : '—';
  const quoted=Boolean(illustrative || accountSpecific);
  return <aside className="st-panel st-strategy-review" aria-labelledby="st-review-title"><h2 id="st-review-title">Your strategy</h2><p className="st-review-subtitle">{symbol} · {input ? `Sell $${new BN(input.shortStrike).toFormat(0)} / Buy $${new BN(input.longStrike).toFormat(0)} · ${days}d` : 'Select a strategy'}</p>
    {input && result && <p className="st-review-loan">Loan {result.loan.toFormat(3)} USDG · {new BN(input.borrowApr).times(100).toFormat(3)}% variable APR</p>}
    <details className="st-review-costs"><summary>{result && quoted ? `Costs · ${result.interest.plus(result.fee).plus(result.gas).toFormat(3)} USDG` : 'Costs · quote needed'}</summary>
      <dl className="st-review-ledger"><div><dt>Premium</dt><dd className="st-positive">{result ? '+' : ''}{amount(result?.grossPremium)}</dd></div><div><dt>Borrow interest</dt><dd>{result ? '−' : ''}{amount(result?.interest)}</dd></div><div><dt>{illustrative ? 'Est. fees' : 'Opening fee'}</dt><dd>{result && quoted ? `−${amount(result.fee.plus(result.gas))}` : 'Quote required'}</dd></div></dl>
      {valuationNote && <p className="st-muted">{valuationNote}</p>}
    </details>
    <div className="st-review-net"><span className="st-caption">Est. net premium</span><strong className={result?.netIncome.lt(0) ? 'st-negative' : 'st-positive'}>{result ? result.netIncome.toFormat(3) : '—'}<small>USDG</small></strong><p>{result ? `${result.roi.times(100).toFormat(3)}% of ${result.stockValue.toFormat(3)} USDG stock` : 'Refresh prices for an estimate.'}</p>
      {result && <div className="st-review-apr"><span>APR on stock</span><strong className={result.apr.lt(0) ? 'st-negative' : 'st-positive'}>{result.apr.times(100).toFormat(3)}%</strong></div>}
    </div><div className="st-review-risk"><p>Stock/option losses · loan liquidation risk.</p></div>
    <div className="st-review-action">{children}</div><p className="st-review-footnote">{illustrative ? 'Sample · no transactions' : accountSpecific ? 'Quoted' : 'Before opening fees'}</p>
  </aside>;
}
