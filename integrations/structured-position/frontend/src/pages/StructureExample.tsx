import {useMemo, useState} from 'react';
import {BN} from '../utils/bn';
import {exampleIncome, EXAMPLE_ASSETS as ASSETS, type ExampleStockSymbol as StockSymbol} from '../structure/exampleIncome';
import StructurePayoff from './StructurePayoff';
import StructureStockLogo from './StructureStockLogo';
import {HoldingsSummary, StrategyChoices, StrategyReview} from './StructurePanels';

type Style = 'balanced' | 'conservative';
export default function StructureExample({initialSymbol = 'NVDA', onUseLive}: {initialSymbol?: StockSymbol; onUseLive(): void}) {
  const [symbol, setSymbol] = useState<StockSymbol>(initialSymbol);
  const [quantity, setQuantity] = useState('10');
  const [days, setDays] = useState(7);
  const [style, setStyle] = useState<Style>('balanced');
  const asset = ASSETS[symbol];
  const examples = useMemo(() => {
    try {return {balanced:exampleIncome(symbol, quantity, days, 'balanced'), conservative:exampleIncome(symbol, quantity, days, 'conservative')};}
    catch {return null;}
  }, [symbol, days, quantity]);
  const projection = examples?.[style];
  const expiry = Math.floor(Date.now() / 1000) + days * 86400;
  const preview = () => document.getElementById('example-payoff')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});

  return <>
    <HoldingsSummary symbol={symbol} shares={projection?.result.stockShares.toFormat(4).replace(/\.?0+$/, '') || '—'} value={projection ? `$${projection.result.stockValue.toFormat(3)}` : '—'} price={`$${new BN(asset.price).toFormat(0)} / share`} illustrative controls={<>
      <div><label className="st-input-label" htmlFor="ex-asset">Stock</label><div className="st-asset-picker"><StructureStockLogo symbol={symbol} className="st-stock-letter"/><select id="ex-asset" value={symbol} onChange={event => setSymbol(event.target.value as StockSymbol)}>{Object.entries(ASSETS).map(([key, value]) => <option key={key} value={key}>{value.name} · {key}</option>)}</select></div></div>
      <div><label className="st-input-label" htmlFor="ex-quantity">Amount to put to work</label><div className="st-amount-input"><input id="ex-quantity" inputMode="decimal" aria-invalid={!projection} aria-describedby={!projection ? 'example-quantity-error' : undefined} value={quantity} onChange={event => setQuantity(event.target.value)}/><span>{symbol}</span></div>{!projection && <p id="example-quantity-error" className="st-field-error">Enter an amount greater than zero.</p>}</div>
    </>}/>
    <div className="st-vault-grid">
      <div className="st-vault-left">
        <StrategyChoices symbol={symbol} selected={style} onSelect={value=>{if(value==='balanced' || value==='conservative') setStyle(value);}} duration={<label className="st-duration-select"><span className="sr-only">Time until expiry</span><select aria-label="Time until expiry" value={days} onChange={event => setDays(Number(event.target.value))}>{[7,14,30].map(value => <option key={value} value={value}>{value} days</option>)}</select></label>} description="Sample prices · no funds move."
          choices={(['balanced','conservative'] as const).map(id => {const p=examples?.[id]; return {id,target:p ? `$${p.short.toFormat(0)}` : '—',protection:p ? `$${p.long.toFormat(0)}` : '—',upside:p ? `+${p.short.div(asset.price).minus(1).times(100).toFormat(1)}%` : '',premium:p ? p.result.grossPremium.toFormat(3) : '—',returnLabel:p ? `${p.result.grossPremium.div(p.result.stockValue).times(100).toFormat(3)}% / ${days} days` : 'Enter a valid amount'};})}/>
      </div>
      <StrategyReview symbol={symbol} input={projection?.input} illustrative><button type="button" className="st-primary st-wide" disabled={!projection} onClick={preview}>Preview strategy <span aria-hidden="true">→</span></button><button className="st-text-link st-live-link" type="button" onClick={onUseLive}>Use my stock →</button></StrategyReview>
    </div>
    {projection && <div className="st-vault-details" id="example-payoff"><StructurePayoff input={projection.input} symbol={symbol} expiry={expiry} illustrative/>
      <details className="st-disclosure"><summary>Details</summary><p className="st-muted">APR = net premium ÷ stock value × 365 ÷ term days. Excludes stock P&amp;L, option settlement losses, network and closing fees.</p><dl className="st-live-quote"><div><dt>Loan + estimated interest</dt><dd>{projection.result.debtDue.toFormat(3)} USDG</dd></div><div><dt>Modeled options + loan loss</dt><dd>{projection.result.maxOverlayLoss.toFormat(3)} USDG</dd></div><div><dt>Estimated liquidation token price</dt><dd>${projection.result.liquidationTokenPrice.toFormat(3)}</dd></div><div><dt>Estimated health factor</dt><dd>{projection.result.healthFactor.toFormat(3)}</dd></div></dl><p className="st-muted">Sample data · 1 USDG = $1. No transactions are sent. Live trades require a fresh quote. Repay the loan before withdrawing stock; losses may require extra USDG.</p></details>
    </div>}
  </>;
}
