import {useCallback, useMemo, useState, type CSSProperties} from 'react';
import {Link} from 'react-router-dom';
import {formatUnits} from 'viem';
import {BN} from '../utils/bn';
import {BLOCK_EXPLORER} from '../networks/apis';
import {morphoMarketUrl, STOCK_INCOME_MARKETS} from '../networks/stockIncome';
import {calculateIncome, type IncomeProjectionInput} from '../structure/incomeProjection';
import {selectSpread, SPREAD_STYLES, type Spread, type SpreadStyle} from '../structure/strategy';
import {useStockIncome} from '../structure/useStockIncome';
import {canArchive, canReconcileTransaction} from '../structure/recovery';
import {repaymentReserve} from '../structure/wallet';
import {canStartNextStrategy, FUNDING_STEPS, type FundingJournal, type FundingStep} from '../structure/workflow';
import {executionPlan} from '../structure/execution';
import {positionIncome} from '../structure/positionIncome';
import {accountAccessFundingReady} from '../utils/accountAccessState';
import StructureExample from './StructureExample';
import StructurePayoff from './StructurePayoff';
import StructureProgress from './StructureProgress';
import StructureStockLogo from './StructureStockLogo';
import {ExpiryChoices, HoldingsSummary, StrategyChoices, StrategyReview} from './StructurePanels';
import Wallet from '../components/NavBar/Wallet';
import CallPutLogo from '../assets/img/logo-callput.png';
import MorphoLogo from '../assets/logo-morpho.svg';
import ToggleChain from '../components/NavBar/ToggleChain';
import './Structure.css';
import './StructureVault.css';

type Mode = 'live' | 'example';
type Tab = 'Overview' | 'My positions' | 'Activity' | 'Details';
type Big = InstanceType<typeof BN>;

const shortAddress = (value?: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Not connected';
const fromUnits = (value: string | bigint, scale: number) => new BN(value.toString()).div(new BN(10).pow(scale)).toFixed();
const units = (value: string | bigint, scale = 6, places = 3) => new BN(value.toString()).div(new BN(10).pow(scale)).toFormat(places, BN.ROUND_DOWN);
const money = (value?: Big | null, places = 3) => value ? `${value.isNegative() ? '−' : ''}$${value.abs().toFormat(places)}` : '—';
const percent = (value?: Big | null) => value ? `${value.times(100).toFormat(3)}%` : '—';
const date = (value: number) => new Date(value * 1000).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'}) + ' UTC';
const explorer = (hash: string) => `${BLOCK_EXPLORER.Robinhood}/tx/${hash}`;
const styleName = (style:string) => SPREAD_STYLES.find(item=>item.id===style)?.label ?? 'saved';

export default function Structure({announcementsLen = 0}: {announcementsLen?: number}) {
  const h = useStockIncome();
  const [mode, setMode] = useState<Mode>('live');
  const [tab, setTab] = useState<Tab>('Overview');
  const [acknowledged, setAcknowledged] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [recoveryStep, setRecoveryStep] = useState<FundingStep | 'management' | 'walletApproval'>('approve');
  const [orderId, setOrderId] = useState('');
  const plan = h.journal ? executionPlan(h.journal) : h.review;
  const positions = h.positions?.length ? h.positions : h.journal ? [h.journal] : [];
  const planSpread = plan?.spread;
  const frozen = h.busy || Boolean(h.journal && !canStartNextStrategy(h.journal));
  const funded = Boolean(h.journal && FUNDING_STEPS.every(step => h.journal!.steps[step].status === 'confirmed'));
  const ready = h.walletMode ? Boolean(h.address && h.chainId === 4663) : h.access.snapshot ? accountAccessFundingReady(h.access.snapshot, h.access.consent) : false;
  const debt = h.snapshot?.debt ?? 0n, collateral = h.snapshot?.position.collateral ?? 0n;
  const actionDisabled = h.busy || !h.address || h.chainId !== 4663;
  const uncertainty = h.journal && (FUNDING_STEPS.some(step => canReconcileTransaction(h.journal!.steps[step])) || canReconcileTransaction(h.journal.management) || canReconcileTransaction(h.journal.walletApproval));
  const loanHistory = Boolean(h.journal?.management);

  const reference = useMemo(() => {
    const data = h.marketData;
    const expiry = h.expiry || h.expiries[0];
    const sourceAt = data.sourceTimestamp ? Math.floor(data.sourceTimestamp / 1000) : 0;
    const spot = data.futuresAssetIndexMap[h.market.symbol];
    if (data.sourceChain !== 'Robinhood') return {spread: null as Spread | null, spot: '', error: 'Waiting for Robinhood options data.'};
    if (!expiry || !sourceAt || !spot || !data.market[h.market.symbol]) return {spread: null as Spread | null, spot: spot ? String(spot) : '', error: ''};
    try {
      return {spread: selectSpread({symbol: h.market.symbol, market: data.market[h.market.symbol], price: String(spot), expiry, style: h.style, sourceAt}), spot: String(spot), error: ''};
    } catch (error) {
      return {spread: null as Spread | null, spot: String(spot), error: error instanceof Error ? error.message : 'Market reference unavailable.'};
    }
  }, [h.expiry, h.expiries, h.market.symbol, h.marketData, h.style]);

  const projectionPlan = mode === 'live' ? plan : null;
  const displaySpread = projectionPlan?.spread ?? reference.spread;
  const snapshotFresh = Boolean(h.snapshot && h.now - h.snapshot.checkedAt <= 300_000);
  const savedIncome = useCallback((saved: FundingJournal) => {
    const entry=positionIncome(saved);
    if (entry) return {...entry,valuationNote:'Stock value and borrowing rate recorded at order entry. Interest and opening fee remain estimates.'};
    if (!h.snapshot || !snapshotFresh || saved.plan.spread.symbol!==h.market.symbol) return null;
    const estimate=positionIncome({...saved,incomeBasis:{
      tokenPrice:new BN(h.snapshot.oraclePrice.toString()).div('1e24').toFixed(),
      borrowApr:new BN(h.snapshot.borrowRate.toString()).times(31_536_000).div('1e18').toFixed(),
      startedAt:saved.order?.fill?.filledAt ?? executionPlan(saved).quote.quotedAt,
    }});
    return estimate ? {...estimate,valuationNote:'Current stock value estimate; entry valuation was not saved.'} : null;
  },[h.snapshot,h.market.symbol,snapshotFresh]);
  const projection = useMemo(() => {
    if (h.journal?.order?.status==='filled') {
      const entry=savedIncome(h.journal);
      return entry ? {...entry,accountSpecific:true} : null;
    }
    if (!displaySpread || !reference.spot || reference.error || !h.snapshot || !snapshotFresh || displaySpread.expiry <= Math.floor(h.now / 1000)) return null;
    try {
      const multiplier = projectionPlan?.multiplier ?? fromUnits(h.snapshot.multiplier, 18);
      const quantity = projectionPlan?.quantity ?? h.quantity;
      const quotedCash = projectionPlan ? new BN(projectionPlan.quote.amount).minus(projectionPlan.quote.fee).div('1e6') : null;
      const quotedShares = projectionPlan ? new BN(projectionPlan.quote.size).div('1e18') : null;
      const quotedCollateral = projectionPlan && quotedShares ? quotedShares.times(projectionPlan.spread.width) : null;
      const cashPerUsd = quotedCash && quotedCollateral?.gt(0) ? quotedCash.div(quotedCollateral).toFixed() : undefined;
      const input: IncomeProjectionInput = {
        quantity, multiplier, tokenPrice: new BN(h.snapshot.oraclePrice.toString()).div('1e24').toFixed(), spot: reference.spot,
        shortStrike: String(displaySpread.short.strikePrice), longStrike: String(displaySpread.long.strikePrice),
        premiumPerShare: displaySpread.premium,
        borrowApr: new BN(h.snapshot.borrowRate.toString()).times(31_536_000).div('1e18').toFixed(),
        durationSeconds: String(displaySpread.expiry - Math.floor(h.now / 1000)),
        existingCollateralValue: h.journal ? '0' : new BN(collateral.toString()).times(h.snapshot.oraclePrice.toString()).div('1e42').toFixed(),
        existingDebt: h.journal ? '0' : fromUnits(debt, 6),
        lltv: new BN(h.market.params.lltv.toString()).div('1e18').toFixed(),
        ...(cashPerUsd ? {cashPerUsd} : {}),
        ...(projectionPlan ? {shares: fromUnits(projectionPlan.quote.size, 18), premium: fromUnits(projectionPlan.quote.premiumAmount, 6), loan: fromUnits(h.journal?.plan.quote.amount ?? projectionPlan.quote.amount, 6), fee: fromUnits(projectionPlan.quote.fee, 6)} : {}),
      };
      return {input, result: calculateIncome(input), accountSpecific: Boolean(projectionPlan),valuationNote:undefined};
    } catch { return null; }
  }, [collateral, debt, displaySpread, h.journal, h.market.params.lltv, h.now, h.quantity, h.snapshot, projectionPlan, reference.error, reference.spot, snapshotFresh,savedIncome]);

  const displayQuantity = plan?.quantity ?? h.quantity;
  const collateralValue = h.snapshot ? new BN(collateral.toString()).times(h.snapshot.oraclePrice.toString()).div('1e42') : null;
  const currentLtv = collateralValue?.gt(0) ? new BN(debt.toString()).div('1e6').div(collateralValue) : new BN(0);
  const currentHealth = debt > 0n ? new BN(h.market.params.lltv.toString()).div('1e18').div(currentLtv) : null;
  const borrowApr = h.snapshot ? new BN(h.snapshot.borrowRate.toString()).times(31_536_000).div('1e18') : null;
  const selectMode = (next: Mode) => {setMode(next); setAcknowledged(false); if (next === 'example') setTab('Overview'); requestAnimationFrame(() => window.scrollTo({top:0}));};
  const refreshConnections = () => {void Promise.all([h.refresh(), h.refreshHoldings(), h.access.refresh()]).catch(() => undefined);};

  const localPreview = import.meta.env.DEV && typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const choices = SPREAD_STYLES.map(({id,label}) => {
    let spread: Spread | null = null;
    const selectedQuote=Boolean(plan && id===plan.style);
    try {
      if (!selectedQuote && h.marketData.sourceChain!=='Robinhood') throw new Error('Waiting for Robinhood data.');
      spread=selectedQuote ? plan!.spread : selectSpread({symbol:h.market.symbol,market:h.marketData.market[h.market.symbol],price:reference.spot,expiry:h.expiry || h.expiries[0],style:id,sourceAt:Math.floor((h.marketData.sourceTimestamp || 0)/1000)});
    } catch { /* Missing live data stays unavailable. */ }
    let estimate=selectedQuote ? projection?.result : undefined;
    if (!selectedQuote && spread && projection) {
      try {estimate=calculateIncome({...projection.input,shortStrike:String(spread.short.strikePrice),longStrike:String(spread.long.strikePrice),premiumPerShare:spread.premium,
        shares:undefined,premium:undefined,loan:undefined,fee:undefined,gas:undefined,cashPerUsd:undefined});} catch { /* Invalid estimates stay unavailable. */ }
    }
    const moneyness=spread && reference.spot ? new BN(spread.short.strikePrice).div(reference.spot).times(100) : null;
    const upside=moneyness ? `${moneyness.gte(100) ? '+' : ''}${moneyness.minus(100).toFormat(1)}%` : '';
    return {id,label,target:spread ? `$${spread.short.strikePrice}` : '—',protection:spread ? `$${spread.long.strikePrice}` : '—',upside,
      premium:estimate ? estimate.grossPremium.toFormat(3) : '—',apr:estimate ? percent(estimate.apr) : undefined,
      aprNote:selectedQuote ? 'net' : 'before fees',returnLabel:moneyness?.lt(100) ? 'Includes intrinsic value' : undefined};
  });
  return <main className={`st-root st-vault${mode === 'live' ? ' st-vault-live' : ''}`} style={{'--st-announcement-space': `${announcementsLen * 46}px`} as CSSProperties}>
    <header className="st-vault-nav"><Link to="/options" className="st-vault-brand" aria-label="CallPut home"><img src={CallPutLogo} alt="CallPut" width="128" height="40"/></Link><nav aria-label="Earn navigation"><Link to="/options">Options</Link><button type="button" className={tab === 'My positions' && mode === 'live' ? '' : 'is-active'} onClick={() => {setTab('Overview'); window.scrollTo({top:0});}}>Earn</button><button type="button" className={tab === 'My positions' && mode === 'live' ? 'is-active' : ''} onClick={() => {selectMode('live'); setTab('My positions'); requestAnimationFrame(() => document.getElementById('structure-details')?.scrollIntoView({block:'start'}));}}>Portfolio</button></nav><span className="st-prototype-badge"><i/> Founder House · Prototype</span></header>
    <header className="st-page-header"><div><h1>Structured Position</h1><p>Let your stocks earn yield.</p></div></header>
    <div className="st-vault-toolbar"><div className="st-segment st-mode-picker" aria-label="Structure mode"><button type="button" aria-pressed={mode === 'example'} onClick={() => selectMode('example')}>Guide</button><button type="button" aria-pressed={mode === 'live'} onClick={() => selectMode('live')}>Use my stock</button></div>{mode === 'live' && <div className="st-live-toolbar"><div className="st-vault-wallet"><Wallet/></div><ToggleChain/><button className="st-text-link" disabled={h.busy || h.reading} onClick={refreshConnections}>{h.reading ? 'Refreshing…' : 'Refresh prices'}</button></div>}</div>
    {mode === 'example' ? <StructureExample initialSymbol={h.market.symbol} onUseLive={() => selectMode('live')}/> : <>
    <HoldingsSummary symbol={h.market.symbol} shares={h.holdingBalance === null ? '—' : formatUnits(h.holdingBalance, 18)} unit="tokens" value={h.holdingBalance !== null && h.snapshot && snapshotFresh ? `${new BN(h.holdingBalance.toString()).times(h.snapshot.oraclePrice.toString()).div('1e42').toFormat(3)} USDG` : '—'} price={reference.spot ? `$${new BN(reference.spot).toFormat(3)} / share` : 'Awaiting price'} illustrative={false} note={h.holdingsLoading ? 'Reading balance…' : h.holdingsError ? 'Balance refresh failed' : h.holdingsOwner && !h.address ? 'Read-only' : undefined} controls={<>        <fieldset className="st-live-stock-inputs" disabled={frozen}>
          <label className="st-input-label" htmlFor="st-asset">Stock</label><div className="st-asset-picker"><StructureStockLogo symbol={h.market.symbol} className="st-stock-letter"/><select id="st-asset" value={h.market.symbol} onChange={event => {h.setSymbol(event.target.value as typeof h.market.symbol); setAcknowledged(false);}}>{STOCK_INCOME_MARKETS.map(asset => <option key={asset.symbol} value={asset.symbol}>{asset.name} · {asset.symbol}</option>)}</select></div>
          <label className="st-input-label" htmlFor="st-quantity">Amount to put to work</label><div className="st-amount-input"><input id="st-quantity" inputMode="decimal" value={h.quantity} onChange={event => {h.setQuantity(event.target.value); setAcknowledged(false);}}/><span>{h.market.symbol}</span><button type="button" disabled={h.holdingBalance === null} onClick={() => {if (h.holdingBalance !== null) h.setQuantity(formatUnits(h.holdingBalance, 18)); setAcknowledged(false);}}>Max</button></div><div className="st-balance-row"><span>{h.holdingBalance !== null ? `${formatUnits(h.holdingBalance, 18)} ${h.market.symbol} available` : h.holdingsLoading ? 'Reading wallet balance…' : h.holdingsError ? 'Balance unavailable. Refresh to retry.' : 'Connect to see your balance'}</span></div>
</fieldset></>}/>
    <div className="st-vault-grid"><div className="st-vault-left">
      <StrategyChoices symbol={h.market.symbol} selected={plan ? plan.style ?? 'saved' : h.style} choices={choices} disabled={frozen} onSelect={value => {h.setStyle(value); setAcknowledged(false);}}
        expiryControls={<ExpiryChoices expiries={h.expiries} selected={h.expiry || h.expiries[0]} savedExpiry={planSpread?.expiry} now={Math.floor(h.now/1000)} disabled={frozen} onSelect={value=>{h.setExpiry(value);setAcknowledged(false);}}/>}
        description={plan && !plan.style ? `Saved strategy · sell $${plan.spread.short.strikePrice} / buy $${plan.spread.long.strikePrice}` : undefined}/>
    </div><StrategyReview symbol={h.market.symbol} input={projection?.input} accountSpecific={projection?.accountSpecific} valuationNote={projection?.valuationNote}>
      {localPreview && !h.walletMode && <p className="st-inline-warning">Local trading setup requires the configured HTTPS app origin.</p>}
      <BuilderAction h={h} ready={ready} acknowledged={acknowledged} setAcknowledged={setAcknowledged} actionDisabled={actionDisabled}/>
      {!projection && !h.review && !h.journal && <button type="button" className="st-text-link st-live-link" onClick={() => selectMode('example')}>Open guide →</button>}
              {h.journal && <ExecutionControls h={h} funded={funded} loanHistory={loanHistory} uncertainty={Boolean(uncertainty)} orderId={orderId} setOrderId={setOrderId} recoveryHash={recoveryHash} setRecoveryHash={setRecoveryHash} recoveryStep={recoveryStep} setRecoveryStep={setRecoveryStep} actionDisabled={actionDisabled}/>}
    </StrategyReview></div>
    <div className="st-vault-details" id="structure-details">
        <nav className="st-category-tabs" role="tablist" aria-label="Strategy details">{(['Overview', 'My positions', 'Activity', 'Details'] as Tab[]).map((item, index, items) => <button type="button" role="tab" id={`structure-tab-${index}`} aria-controls={`structure-panel-${index}`} tabIndex={tab === item ? 0 : -1} aria-selected={tab === item} key={item} onClick={() => setTab(item)} onKeyDown={event => {const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1; if (next >= 0) {event.preventDefault(); setTab(items[next]); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();}}}>{item}</button>)}</nav>

        <div hidden={tab !== 'Overview'} className="st-category" role="tabpanel" id="structure-panel-0" aria-labelledby="structure-tab-0">
          {projection && displaySpread && <StructurePayoff input={projection.input} symbol={h.market.symbol} expiry={displaySpread.expiry}/>}

          {!projection && <p className="st-muted" role="status">Refresh prices to load payoff.</p>}
        </div>

        <div hidden={tab !== 'My positions'} className="st-category" role="tabpanel" id="structure-panel-1" aria-labelledby="structure-tab-1">
          {!positions.length && <section className="st-panel st-empty"><span>◎</span><h2>No stock income strategy yet</h2><p>Your strategy will appear here after funding. Any existing loan is shown below.</p><Link to={`/options?asset=${h.market.symbol}`}>View account positions ↗</Link></section>}
          {positions.map(saved=><SavedPosition key={saved.plan.id} saved={saved} income={savedIncome(saved)} selected={saved.plan.id===h.journal?.plan.id}
            disabled={actionDisabled || Boolean(h.journal && !canStartNextStrategy(h.journal))}
            onSelect={()=>void h.selectPosition(saved.plan.id)}/>) }
          {canStartNextStrategy(h.journal) && <button className="st-outline-btn" disabled={actionDisabled} onClick={()=>{void h.startNew();setAcknowledged(false);setTab('Overview');window.scrollTo({top:0});}}>New strategy →</button>}
          {(Boolean(h.journal) || debt > 0n || collateral > 0n) && <LoanPanel h={h} debt={debt} collateral={collateral} currentLtv={currentLtv} currentHealth={currentHealth} borrowApr={borrowApr} actionDisabled={actionDisabled}/>}
        </div>

        <div hidden={tab !== 'Activity'} className="st-category" role="tabpanel" id="structure-panel-2" aria-labelledby="structure-tab-2"><ActivityPanel h={h}/></div>

        <div hidden={tab !== 'Details'} className="st-category" role="tabpanel" id="structure-panel-3" aria-labelledby="structure-tab-3">
          {projection && displaySpread ? <details className="st-disclosure"><summary>Funding &amp; costs</summary>
            <section className="st-panel st-flow-section"><div className="st-section-title"><div><span className="st-eyebrow">ROBINHOOD CHAIN</span><h2>How funds move</h2></div><span className="st-chain"><i/> Morpho × CallPut</span></div><div className="st-flow"><div className="st-flow-node"><StructureStockLogo symbol={h.market.symbol} className="st-node-icon st-stock-icon"/><small>Your wallet</small><strong>{displayQuantity} {h.market.symbol}</strong><span>Stock tokens</span></div><div className="st-connector"><span>Supply</span><b>→</b><small>Stock collateral</small></div><div className="st-flow-node"><span className="st-node-icon st-protocol-icon st-morpho-icon" aria-hidden="true"><img src={MorphoLogo} alt=""/></span><small>Morpho</small><strong>{money(projection.result.loan)} USDG</strong><span>Variable-rate loan</span></div><div className="st-connector"><span>Fund</span><b>→</b><small>Defined risk</small></div><div className="st-flow-node"><span className="st-node-icon st-protocol-icon st-callput-icon" aria-hidden="true"><img src={CallPutLogo} alt=""/></span><small>CallPut</small><strong>Sell call spread</strong><span>{projection.result.shares.toFormat(5)} shares</span></div></div><div className="st-flow-return"><span className="st-return-line"/><span>↳ &nbsp; {money(projection.result.grossPremium, 5)} gross premium</span><span className="st-return-destination">Income after expiry payoff</span></div></section>
            <div className="st-stat-grid"><div><span>Stock collateral value</span><strong>{money(projection.result.stockValue)}</strong><small>{displayQuantity} {h.market.symbol} × {projection.input.multiplier} shares</small></div><div><span>USDG to borrow</span><strong>{money(projection.result.loan, 5)}</strong><small>{projection.accountSpecific ? 'Prepared account quote' : 'Assumes 1 USDG = $1'}</small></div><div><span>Projected health factor</span><strong className={projection.result.healthFactor.lt(1.25) ? 'st-negative' : 'st-positive'}>{projection.result.healthFactor.isFinite() ? projection.result.healthFactor.toFormat(3) : '∞'}</strong><small>Execution requires at least 1.25</small></div></div>
            <section className="st-panel st-cash"><div className="st-section-title"><div><span className="st-eyebrow">COST LEDGER</span><h2>Income &amp; repayment</h2></div><span className="st-mini-tag">{projection.accountSpecific ? 'Prepared quote' : 'Public estimate'}</span></div><div className="st-cash-columns"><dl><div><dt>Gross spread premium</dt><dd className="st-positive">+{money(projection.result.grossPremium, 5)}</dd></div><div><dt>Borrow interest <small>{percent(borrowApr)} variable APR</small></dt><dd>−{money(projection.result.interest, 5)}</dd></div><div><dt>Opening fee</dt><dd>{projection.accountSpecific ? `−${money(projection.result.fee, 5)}` : 'Final quote required'}</dd></div><div className="st-ledger-total"><dt>Potential net income</dt><dd className={projection.result.netIncome.lt(0) ? 'st-negative' : 'st-positive'}>{money(projection.result.netIncome, 5)}</dd></div></dl><dl><div><dt>Modeled options + loan loss</dt><dd>{money(projection.result.maxOverlayLoss, 5)}</dd></div><div><dt>Debt due at expiry</dt><dd>{money(projection.result.debtDue, 5)}</dd></div><div><dt>Term ROI on stock</dt><dd>{percent(projection.result.roi)}</dd></div><div><dt>Annualized APR</dt><dd>{percent(projection.result.apr)}</dd></div><div><dt>Estimated liquidation token price</dt><dd>{money(projection.result.liquidationTokenPrice, 5)}</dd></div></dl></div><p className="st-muted">Current marks and the variable Morpho rate can change. Stock-price movements, closing fees and network fees are excluded from ROI and APR.</p></section>
          </details> : <details className="st-disclosure"><summary>Why is my estimate unavailable?</summary><p className="st-muted">{planSpread && planSpread.expiry <= Math.floor(h.now / 1000) ? 'This saved strategy has expired. Your positions, loan and activity are still available.' : !snapshotFresh ? 'Borrowing rates need updating. Select Refresh prices to try again.' : 'Current option prices are not available. You can explore an example without connecting a wallet.'}</p></details>}
          <section className="st-panel st-apr-basis"><h2>APR basis</h2><p className="st-muted">Net premium ÷ stock value × 365 ÷ term days. Excludes stock P&amp;L and option settlement losses. {projection?.accountSpecific ? 'Opening fee included.' : 'Opening fee not yet included.'} Network and closing fees excluded.</p>{projection?.valuationNote && <p className="st-muted">{projection.valuationNote}</p>}</section>
    <footer className="st-footer"><details><summary>Connection details</summary><p>Stock wallet {shortAddress(h.address)} · {h.walletMode ? 'Wallet trading' : 'Options account'} {shortAddress(h.tradingAddress)}{h.snapshot ? ` · Morpho block ${h.snapshot.block.toString()}` : ''}</p></details></footer>
          <section className="st-panel st-risk"><div className="st-section-title"><div><h2>Protocols</h2></div><span className="st-chain"><i/> Robinhood Chain</span></div><div className="st-detail-grid"><article><StructureStockLogo symbol={h.market.symbol} className="st-detail-icon"/><div><h3>{h.market.name} stock token</h3><p>Each token currently represents {h.snapshot ? units(h.snapshot.multiplier, 18, 7) : '—'} shares. Market value follows the underlying stock and token conversion.</p><code title={h.market.params.collateralToken}>{shortAddress(h.market.params.collateralToken)}</code></div></article><article><span className="st-detail-icon st-protocol-icon st-morpho-icon" aria-hidden="true"><img src={MorphoLogo} alt=""/></span><div><h3>Morpho USDG market</h3><p>Collateral secures a variable-rate USDG loan. Liquidation LTV is 62.5%; interest accrues until repayment.</p><a href={morphoMarketUrl(h.market)} target="_blank" rel="noreferrer">Open market ↗</a></div></article><article><span className="st-detail-icon st-protocol-icon st-callput-icon" aria-hidden="true"><img src={CallPutLogo} alt=""/></span><div><h3>CallPut defined-risk spread</h3><p>The bought call caps the overlay loss. A fresh account quote is required before signing.</p><Link to={`/options?asset=${h.market.symbol}`}>Open options ↗</Link></div></article><article><span className="st-detail-icon">$</span><div><h3>USDG loan token</h3><p>Borrowed USDG funds the option spread. Repayment happens from the connected wallet.</p><code title={h.market.params.loanToken}>{shortAddress(h.market.params.loanToken)}</code></div></article></div><details><summary>Estimate boundaries</summary><p className="st-muted">Public estimates use current marks and Morpho reads. Fill price, final size, opening fee and executable loan amount are confirmed only by an account-specific quote. Premium is not guaranteed or immediately withdrawable.</p></details></section>
        </div>
    </div>
    {!h.journal && h.error && <div role="alert" className="st-global-error">{h.error}</div>}
</>}
  </main>;
}

function SavedPosition({saved,income,selected,disabled,onSelect}: {saved:FundingJournal; income:(NonNullable<ReturnType<typeof positionIncome>>&{valuationNote:string})|null; selected:boolean; disabled:boolean; onSelect():void}) {
  const plan=executionPlan(saved),symbol=plan.spread.symbol;
  const funded=FUNDING_STEPS.every(step=>saved.steps[step].status==='confirmed');
  return <section className="st-panel st-position-card"><div className="st-section-title"><div><span className="st-eyebrow">{selected ? 'SELECTED STRATEGY' : 'SAVED IN THIS BROWSER'}</span><h2>{symbol} stock income</h2></div><span className="st-status-pill">{saved.order?.status ?? (funded ? 'Funded' : 'Funding')}</span></div>
    <dl className="st-live-quote"><div><dt>Stock supplied</dt><dd>{new BN(plan.quantity).toFormat(5)} {symbol}</dd></div><div><dt>Call spread</dt><dd>Sell ${plan.spread.short.strikePrice} / Buy ${plan.spread.long.strikePrice}</dd></div><div><dt>Expiry</dt><dd>{date(plan.spread.expiry)}</dd></div>
      <div><dt>{saved.order?.fill ? 'Filled premium' : 'Quoted premium'}</dt><dd>{income ? `${income.result.grossPremium.toFormat(3)} USDG` : '—'}</dd></div>
      <div><dt>Stock token value</dt><dd>{income ? `${income.result.stockValue.toFormat(3)} USDG` : 'Select strategy & refresh prices'}</dd></div>
      <div><dt>Est. net APR on stock</dt><dd className={income?.result.apr.lt(0) ? 'st-negative' : 'st-positive'}>{income ? percent(income.result.apr) : '—'}</dd></div>
      <div><dt>CallPut order</dt><dd>{saved.order?.requestId ?? saved.order?.hash ?? 'Not submitted'}</dd></div></dl>
    <div className="st-actions">{!selected && <button className="st-outline-btn" disabled={disabled} onClick={onSelect}>View strategy</button>}<Link className="st-text-link" to={`/options?asset=${symbol}`}>All options ↗</Link></div>
    {saved.order?.status==='filled' && (income ? <details className="st-position-analysis" open={selected}><summary>Payoff &amp; risk calculator</summary><StructurePayoff key={plan.id} input={income.input} symbol={symbol} expiry={plan.spread.expiry} variant="position" valuationNote={income.valuationNote}/></details>
      : <p className="st-muted" role="status">Payoff estimate unavailable. Select this strategy and refresh prices to load its stock valuation.</p>)}
  </section>;
}

function BuilderAction({h, ready, acknowledged, setAcknowledged, actionDisabled}: {h: ReturnType<typeof useStockIncome>; ready: boolean; acknowledged: boolean; setAcknowledged(value: boolean): void; actionDisabled: boolean}) {
  if (!h.address) return <button className="st-primary st-builder-action" disabled={!h.login.ready} onClick={() => h.login.open()}>Connect to review →</button>;
  if (h.chainId !== 4663) return <p className="st-inline-warning">Switch your wallet to Robinhood Chain to continue.</p>;
  if (!ready) return <button className="st-primary st-builder-action" disabled={h.busy} onClick={() => h.onboarding.open()}>Enable trading →</button>;
  if (canStartNextStrategy(h.journal)) return <div><p className="st-muted">Saved in My positions.</p><button className="st-primary st-builder-action" disabled={actionDisabled} onClick={()=>{void h.startNew();setAcknowledged(false);}}>New strategy →</button><button className="st-text-link" disabled={actionDisabled} onClick={()=>void h.checkOrder()}>Refresh filled order</button></div>;
  if (!h.journal && !h.review) return <button className="st-primary st-builder-action" disabled={h.busy || !h.quantity || !(h.expiry || h.expiries[0])} onClick={() => void h.prepare()}>{h.busy ? 'Getting your quote…' : 'Review strategy →'}</button>;
  if (h.review && !h.journal) {
    const expired = h.now / 1000 - h.review.quote.quotedAt > 45;
    return <div className="st-review"><StructureProgress journal={null} walletMode={h.walletMode}/><label className="st-workflow-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/>I understand the loan, liquidation and options risks.</label>{expired ? <button className="st-primary st-builder-action" disabled={h.busy} onClick={() => void h.prepare()}>Refresh quote →</button> : <button className="st-primary st-builder-action" disabled={!acknowledged || actionDisabled} onClick={() => void h.fund()}>Supply stock &amp; borrow USDG →</button>}</div>;
  }
  return null;
}

function ExecutionControls({h, funded, loanHistory, uncertainty, orderId, setOrderId, recoveryHash, setRecoveryHash, recoveryStep, setRecoveryStep, actionDisabled}: {h: ReturnType<typeof useStockIncome>; funded: boolean; loanHistory: boolean; uncertainty: boolean; orderId: string; setOrderId(value: string): void; recoveryHash: string; setRecoveryHash(value: string): void; recoveryStep: FundingStep | 'management' | 'walletApproval'; setRecoveryStep(value: FundingStep | 'management' | 'walletApproval'): void; actionDisabled: boolean}) {
  const [replacementStyle,setReplacementStyle]=useState<SpreadStyle|''>('');
  if (!h.journal) return null;
  const borrowOnly = h.journal.steps.approve.status === 'confirmed' && h.journal.steps.supply.status === 'confirmed'
    && h.journal.steps.borrow.status === 'idle';
  const quoteAge = h.now / 1000 - h.journal.plan.quote.quotedAt;
  const needsReview = borrowOnly && (!Number.isSafeInteger(h.journal.plan.quote.quotedAt) || quoteAge < 0 || quoteAge > 45
    || Boolean(h.error || h.journal.error));
  const replaceUnavailable = needsReview && /(?:saved spread leg.*unavailable|saved spread legs.*no longer listed)/i.test(h.error || h.journal.error || '');
  const reviewStyle = h.journal.plan.style ?? replacementStyle;
  const reviewAction = () => replaceUnavailable ? reviewStyle && h.reviewReplacementStrategy(reviewStyle) : h.refreshFundingQuote();
  const activePlan=executionPlan(h.journal);
  const orderQuoteAge=h.now/1000-activePlan.quote.quotedAt;
  const needsOrderReview=funded && !h.journal.order && !loanHistory && (!h.journal.execution || !Number.isSafeInteger(activePlan.quote.quotedAt)
    || orderQuoteAge<0 || orderQuoteAge>45 || Boolean(h.error || h.journal.error));
  const replaceOrder=needsOrderReview && /(?:saved spread leg.*unavailable|saved spread legs.*no longer listed)/i.test(h.error || h.journal.error || '');
  const orderStyle=activePlan.style ?? replacementStyle;
  const orderReviewAction=()=>replaceOrder ? orderStyle && h.reviewAvailableStrategy(orderStyle) : h.refreshOrderQuote();
  const canReprice=h.journal.steps.borrow.status==='idle' && !h.journal.order && !loanHistory;
  const canReviewOrder=funded && !h.journal.order && !loanHistory;
  const missingOrderIdentity=Boolean(h.journal.order && (h.walletMode ? !h.journal.order.hash : !h.journal.order.requestId));
  return <section className="st-execution">
    <StructureProgress journal={h.journal} walletMode={h.walletMode} reviewRequired={Boolean(needsOrderReview)} error={h.error || h.journal.error} transactionUrl={explorer}/>
    {((replaceUnavailable && !h.journal.plan.style) || (replaceOrder && !activePlan.style)) && <label className="st-input-label">Choose replacement style<select value={replacementStyle} disabled={actionDisabled} onChange={event=>setReplacementStyle(event.target.value as SpreadStyle)}><option value="">Select a new strategy</option>{SPREAD_STYLES.map(style=><option key={style.id} value={style.id}>{style.label}</option>)}</select></label>}
    <div className="st-actions">
      {!funded && !loanHistory && !h.journal.order && <button className="st-primary st-wide" disabled={actionDisabled || Boolean(replaceUnavailable && !reviewStyle)} onClick={() => void (needsReview ? reviewAction() : h.fund())}>{h.busy ? 'In progress…' : needsReview ? replaceUnavailable ? !reviewStyle ? 'Choose replacement strategy →' : `Review current ${styleName(reviewStyle)} strategy →` : 'Review updated quote →' : borrowOnly ? `Borrow ${units(h.journal.plan.quote.amount, 6, 5)} USDG →` : 'Continue funding →'}</button>}
      {funded && !loanHistory && (!h.journal.order || h.journal.order.status==='failed') && <button className="st-primary st-wide" disabled={actionDisabled || Boolean(replaceOrder && !orderStyle) || !h.walletMode && h.access.stage!=='ready'} onClick={() => void (needsOrderReview ? orderReviewAction() : h.open())}>{h.busy ? 'In progress…' : needsOrderReview ? replaceOrder ? !orderStyle ? 'Choose replacement strategy →' : `Review available ${styleName(orderStyle)} strategy →` : 'Review order quote →' : h.walletMode ? h.journal.walletApproval?.status==='confirmed' ? 'Open call spread →' : 'Approve USDG / open spread →' : h.access.stage==='ready' ? 'Open call spread →' : 'Waiting for trading access…'}</button>}
      {h.journal.order && !['failed','filled'].includes(h.journal.order.status) && <button className="st-primary st-wide" disabled={actionDisabled} onClick={() => void h.checkOrder(orderId)}>{h.busy ? 'Checking order…' : 'Check order'}</button>}
      {h.journal.order?.notSubmitted && <button className="st-outline-btn" disabled={actionDisabled} onClick={() => void h.resumeOrder()}>Resume original order</button>}
    </div>
    {(canReprice || canReviewOrder || h.journal.execution || uncertainty || missingOrderIdentity) && <details className="st-execution-details" open={uncertainty || missingOrderIdentity || undefined}><summary>Quote &amp; recovery</summary>
      {(canReprice || canReviewOrder) && <button className="st-text-link" type="button" disabled={h.busy || h.reading} onClick={()=>void (canReprice ? h.refreshFundingQuote() : h.refreshOrderQuote())}>{canReprice ? 'Refresh funding quote' : 'Refresh order quote'}</button>}
      {h.journal.execution && <p className="st-muted">Original borrowed: {units(h.journal.plan.quote.amount,6,7)} USDG · Option funding: {units(activePlan.quote.amount,6,7)} USDG · Unused funding: {units(BigInt(h.journal.plan.quote.amount)-BigInt(activePlan.quote.amount),6,7)} USDG remains in your {h.walletMode ? 'wallet' : 'CallPut account'}. The full loan still accrues interest.</p>}
      {h.journal.order && (h.walletMode ? !h.journal.order.hash : !h.journal.order.requestId) && <label className="st-input-label">{h.walletMode ? 'Original transaction hash' : 'Original order ID'}<input className="st-recovery-input st-wide" value={orderId} onChange={event=>setOrderId(event.target.value)} placeholder={h.walletMode ? '0x…' : 'Order UUID'}/></label>}
      {uncertainty && <div className="st-recovery"><p>Recover a wallet transaction using its original hash.</p><select aria-label="Transaction to recover" value={recoveryStep} onChange={event=>setRecoveryStep(event.target.value as FundingStep | 'management' | 'walletApproval')}>{FUNDING_STEPS.map(step=><option key={step}>{step}</option>)}{h.journal.walletApproval && <option value="walletApproval">USDG trading approval</option>}{h.journal.management && <option value="management">repayment / withdrawal</option>}</select><input aria-label="Original wallet transaction hash" placeholder="0x…" value={recoveryHash} onChange={event=>setRecoveryHash(event.target.value)}/><button className="st-outline-btn" disabled={actionDisabled} onClick={()=>void h.reconcile(recoveryStep,recoveryHash)}>Verify transaction</button></div>}
    </details>}
  </section>;
}

function ActivityPanel({h}: {h:ReturnType<typeof useStockIncome>}) {
  return <section className="st-panel"><div className="st-section-title"><div><span className="st-eyebrow">Saved in this browser</span><h2>Funding &amp; order activity</h2></div><button className="st-market-refresh" disabled={h.busy || h.reading} onClick={()=>void h.refresh()}>{h.reading ? 'Reading chain…' : 'Refresh ↻'}</button></div>
    {!h.journal ? <><p className="st-muted">{h.positions.length ? 'Select a saved strategy to review its funding and order receipts.' : 'No local funding activity for this wallet. Account-wide activity is available in Options.'}</p><div className="st-actions">{h.positions.map(saved=><button key={saved.plan.id} className="st-outline-btn" disabled={h.busy} onClick={()=>void h.selectPosition(saved.plan.id)}>{saved.plan.spread.symbol} · {date(saved.plan.spread.expiry)}</button>)}</div></>
      : <><StructureProgress journal={h.journal} walletMode={h.walletMode} transactionUrl={explorer}/>
        {h.journal.management && <p className="st-muted">{h.journal.management.action}: {h.journal.management.status} {h.journal.management.hash && <a href={explorer(h.journal.management.hash)} target="_blank" rel="noreferrer">View transaction ↗</a>}</p>}
        <p className="st-muted">Progress is saved in this browser. This is not your full transaction history.</p></>}
  </section>;
}

function LoanPanel({h, debt, collateral, currentLtv, currentHealth, borrowApr, actionDisabled}: {h: ReturnType<typeof useStockIncome>; debt: bigint; collateral: bigint; currentLtv: Big; currentHealth: Big | null; borrowApr: Big | null; actionDisabled: boolean}) {
  if (!h.address || !h.snapshot) return <section className="st-panel"><div className="st-section-title"><div><span className="st-eyebrow">MORPHO POSITION</span><h2>Morpho loan</h2></div></div><p className="st-muted">{h.address ? 'The current position read is unavailable. Refresh before relying on balances.' : 'Log in to view the current Morpho position for your wallet.'}</p>{h.address && <button className="st-market-refresh" disabled={h.reading} onClick={() => void h.refresh()}>{h.reading ? 'Reading chain…' : 'Refresh Morpho position ↻'}</button>}</section>;
  return <section className="st-panel"><div className="st-section-title"><div><span className="st-eyebrow">CURRENT MORPHO READ</span><h2>Morpho loan</h2></div><span className="st-status-pill">{debt ? 'Debt active' : 'No debt'}</span></div><div className="st-health-values"><div><small>Collateral</small><strong>{units(collateral, 18, 7)} {h.market.symbol}</strong></div><div><small>Debt</small><strong>{units(debt, 6, 5)} USDG</strong></div><div><small>Current LTV / health</small><strong>{currentLtv.times(100).toFormat(3)}% / {currentHealth?.toFormat(3) ?? '∞'}</strong></div><div><small>Variable APR</small><strong>{borrowApr ? borrowApr.times(100).toFormat(3) : '—'}%</strong></div></div><p className="st-muted">Block {h.snapshot.block.toString()} · checked {new Date(h.snapshot.checkedAt).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', second:'2-digit'})}. Repayment uses USDG in your connected wallet. {debt > 0n && <>Keep at least {units(repaymentReserve(debt), 6, 7)} USDG, including the interest reserve. </>}Repay clears the entire debt in this market, including any pre-existing loan.</p>{h.journal ? <><div className="st-actions">{!h.walletMode && <button className="st-outline-btn" disabled={actionDisabled} onClick={() => h.onboarding.withdraw()}>Withdraw USDG from CallPut</button>}<button className="st-outline-btn" disabled={actionDisabled || !debt} onClick={() => void h.manage('approve-repay')}>1. Approve repayment</button><button className="st-outline-btn" disabled={actionDisabled || !debt} onClick={() => void h.manage('repay')}>2. Repay all debt</button><button className="st-outline-btn" disabled={actionDisabled || Boolean(debt) || !collateral} onClick={() => void h.manage('withdraw')}>3. Withdraw all collateral</button></div>{h.journal.management && <p className="st-muted">{h.journal.management.action}: {h.journal.management.status} {h.journal.management.hash && <a href={explorer(h.journal.management.hash)} target="_blank" rel="noreferrer">View transaction ↗</a>}</p>}{canArchive(h.journal, debt, collateral) && <button className="st-text-link" disabled={actionDisabled} onClick={() => void h.archive()}>Archive this strategy &amp; start again</button>}</> : <p className="st-muted">Management controls appear after a Stock Income strategy is prepared in this browser. The existing position is never folded into a new strategy without an account-specific quote.</p>}</section>;
}
