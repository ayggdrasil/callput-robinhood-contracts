import {useCallback, useEffect, useRef, useState} from 'react';
import {useAccount, usePublicClient, useReadContracts} from 'wagmi';
import {getAccount, getWalletClient, watchAccount} from 'wagmi/actions';
import {BaseError, erc20Abi, formatUnits, getAddress, isAddress, zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import {NetworkQuoteAsset, SupportedChains, UnderlyingAsset} from '../_shared';
import {useSponsoredTrading} from '../components/TradingAccount/SponsoredTradingProvider';
import {useTradingOnboarding} from '../components/TradingAccount/TradingOnboardingProvider';
import {useWalletLogin} from '../hooks/useWalletLogin';
import {STOCK_INCOME_MARKETS} from '../networks/stockIncome';
import {TRADING_MODE_POLICIES} from '../networks/tradingModes';
import {CONTRACT_ADDRESSES} from '../networks/addresses';
import {config} from '../store/wagmi';
import store from '../store/store';
import {useAppSelector} from '../store/hooks';
import {requireLiveWallet} from '../utils/liveIdentity';
import {getTradeRoute} from '../utils/tradeRoute';
import {BN} from '../utils/bn';
import {sendCreateOpenPosition} from '../utils/contract/positions';
import {orderCompletion, type ObservedOrder} from '../utils/sponsoredOrderMonitor';
import {readMorpho, projectLoan, STOCK_ABI, type MorphoSnapshot} from './morpho';
import {quoteSpread} from './quote';
import {selectSpread, type SpreadStyle} from './strategy';
import {assertAccountReady, refreshSpread} from './policy';
import {activateFunding, archiveFunding, canStartNextStrategy, createFunding, FUNDING_STEPS, journalKey, loadFunding, loadPositions, runFunding, saveFunding, startNextStrategy, withIncomeLock, type IncomePlan, type FundingJournal, type FundingStep} from './workflow';
import {fundingTransactions, isSignatureRejected, makeFundingAdapter, managementTransaction, preflightTransaction, readLendingReceipt, readFundedState, stockUnits} from './wallet';
import {canArchive, canReconcileTransaction, managementPending, resumeOriginalOrder, runManagement, updateUnborrowedQuote, reviewUnborrowedStrategy, type ManagementAction} from './recovery';
import {assertWalletPlan, readPositionOrder, readWalletOrder, walletApprovalTransaction} from './walletOrder';
import {executionPlan, reviewFundedExecution, updateFundedQuote, assertFundedPosition} from './execution';

const message = (error: unknown) => error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : 'The operation could not be confirmed.';
const source = () => {
  const data = store.getState().market;
  if (data.sourceChain !== SupportedChains.Robinhood || !data.sourceTimestamp) throw new Error('Waiting for current Robinhood options data.');
  return {data, sourceAt: Math.floor(data.sourceTimestamp / 1000)};
};
const marketFor = (plan: IncomePlan) => {
  const market = STOCK_INCOME_MARKETS.find(item => item.id === plan.marketId);
  if (!market) throw new Error('Unsupported Morpho market.');
  return market;
};

/** One page consumes the app's wallet, account, market and order lifetimes. */
export function useStockIncome() {
  const {address, chainId} = useAccount();
  const publicClient = usePublicClient({chainId: 4663}) as PublicClient | undefined;
  const access = useSponsoredTrading(), onboarding = useTradingOnboarding(), login = useWalletLogin();
  const walletMode = TRADING_MODE_POLICIES.Robinhood === 'wallet-only';
  const tradingAddress = walletMode ? address : access.controller?.identity.account as Address | undefined;
  const marketData = useAppSelector(state => state.market);
  const [symbol, setSymbolState] = useState<typeof STOCK_INCOME_MARKETS[number]['symbol']>('NVDA');
  const [quantity, setQuantityState] = useState('1'), [style, setStyleState] = useState<SpreadStyle>('balanced');
  const [expiry, setExpiryState] = useState(0), [review, setReview] = useState<IncomePlan | null>(null);
  const [journal, setJournal] = useState<FundingJournal | null>(null), [positions, setPositions] = useState<FundingJournal[]>([]), [snapshot, setSnapshot] = useState<MorphoSnapshot | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const live = useRef({address, controller: access.controller, symbol}); live.current = {address, controller: access.controller, symbol};
  const busyRef = useRef(false), readGeneration = useRef(0);
  const market = STOCK_INCOME_MARKETS.find(item => item.symbol === symbol)!;
  // Public inspection never supplies the signing identity. All writes below
  // still require wagmi's connected address and its live wallet/chain guards.
  const watched = new URLSearchParams(window.location.search).get('watch');
  const watchAddress = watched && isAddress(watched, {strict: false}) ? getAddress(watched) : undefined;
  const holdingsOwner = address ?? watchAddress;
  // Holdings must remain readable when lending, pricing or relay reads fail.
  // Query keys include owner, token and chain; no previous-wallet placeholder.
  const holdingsRead = useReadContracts({
    allowFailure: true,
    contracts: [
      {address: market.params.collateralToken, abi: erc20Abi, functionName: 'balanceOf', args: [holdingsOwner ?? zeroAddress], chainId: 4663},
      {address: market.params.collateralToken, abi: STOCK_ABI, functionName: 'uiMultiplier', chainId: 4663},
    ],
    query: {enabled: Boolean(holdingsOwner && publicClient), refetchInterval: 30_000, refetchIntervalInBackground: false},
  });
  const holdingBalance = holdingsOwner && holdingsRead.data?.[0]?.status === 'success' ? holdingsRead.data[0].result : null;
  const holdingMultiplier = holdingsOwner && holdingsRead.data?.[1]?.status === 'success' ? holdingsRead.data[1].result : null;
  const holdingsError = Boolean(holdingsOwner && (holdingsRead.isError || holdingsRead.data?.[0]?.status === 'failure'));
  const holdingsLoading = Boolean(holdingsOwner && holdingBalance === null && !holdingsError);
  const expiries = (marketData.market[symbol]?.expiries ?? []).filter(value => value * 1000 > now).sort((a,b) => a-b);

  const publish = useCallback((value: FundingJournal) => {
    saveFunding(value);
    if (value.plan.owner.toLowerCase() === live.current.address?.toLowerCase()) {setJournal(structuredClone(value)); setPositions(loadPositions(value.plan.owner));}
  }, []);
  const restore = useCallback((saved: FundingJournal | null) => {
    setJournal(saved); setReview(null);
    if (saved) {const active=executionPlan(saved); setSymbolState(marketFor(saved.plan).symbol); setQuantityState(saved.plan.quantity); setExpiryState(saved.plan.spread.expiry); if (active.style) setStyleState(active.style);}
  }, []);
  useEffect(() => {
    setReview(null); setError(''); setJournal(null); setPositions([]);
    if (!address) return;
    const reload = () => {
      try {
        restore(loadFunding(address)); setPositions(loadPositions(address));
      } catch (e) {setError(message(e));}
    };
    reload();
    const changed = (event: StorageEvent) => {if (event.key === journalKey(address)) reload();};
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, [address,restore]);
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, []);
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    if (!publicClient) return;
    setReading(true);
    try {
      const result = await readMorpho(publicClient, market, holdingsOwner ?? zeroAddress);
      if (generation === readGeneration.current) setSnapshot(result);
    } catch (e) {if (generation === readGeneration.current) {setSnapshot(null); setError(message(e));}}
    finally {if (generation === readGeneration.current) setReading(false);}
  }, [holdingsOwner, market, publicClient]);
  const invalidateReads = useCallback(() => {readGeneration.current++;}, []);
  useEffect(() => {setSnapshot(null); void refresh(); return invalidateReads;}, [refresh,invalidateReads]);

  const perform = async (run: (ctx: {owner: Address; client: PublicClient; guard(plan?: IncomePlan): void}) => Promise<void>) => {
    if (busyRef.current) return;
    if (!address || !publicClient || !walletMode && !access.controller) {setError(walletMode ? 'Connect your wallet on Robinhood Chain.' : 'Log in on Robinhood Chain and set up your CallPut account.'); return;}
    const owner = address, controller = access.controller, initial = getAccount(config), expectedId = journal?.plan.id;
    let invalid = false;
    const stop = watchAccount(config, {onChange(next) {
      if (next.address !== initial.address || next.chainId !== initial.chainId || next.connector?.uid !== initial.connector?.uid || next.status !== 'connected') invalid = true;
    }});
    const guard = (plan?: IncomePlan) => {
      requireLiveWallet(owner, SupportedChains.Robinhood);
      if (invalid || !walletMode && live.current.controller !== controller) throw new Error('Your connection changed. Refresh before continuing.');
      const custody = walletMode ? owner : controller!.identity.account;
      if (plan && (plan.owner.toLowerCase() !== owner.toLowerCase() || plan.account.toLowerCase() !== custody.toLowerCase()
        || (plan.fundingMode ?? 'account') !== (walletMode ? 'wallet' : 'account') || plan.chainId !== 4663)) throw new Error('This strategy belongs to a different trading mode or account. Restore its original mode before continuing.');
      if (plan) {
        const activeId=loadFunding(owner)?.plan.id;
        if (activeId && activeId!==plan.id || !activeId && expectedId===plan.id) throw new Error('The selected strategy changed. Refresh before continuing.');
      }
      if (walletMode) {
        const route = getTradeRoute();
        if (route.kind !== 'wallet' || !route.walletOpenAllowed || route.tradeAddress?.toLowerCase() !== owner.toLowerCase()) throw new Error('Your wallet trading route changed.');
      }
    };
    busyRef.current = true; setBusy(true); setError('');
    try {guard(); await withIncomeLock(owner, () => {
      if (loadFunding(owner)?.plan.id !== expectedId) throw new Error('The strategy changed in another tab. Refresh before continuing.');
      return run({owner, client: publicClient, guard});
    });}
    catch (e) {if (live.current.address === owner) setError(message(e));}
    finally {stop(); busyRef.current = false; setBusy(false); if (live.current.address === owner) void refresh();}
  };
  const assertReady = async (plan: IncomePlan, funded: boolean, client: PublicClient) => {
    if (!walletMode) return assertAccountReady(access.controller!, plan, funded);
    const balance = funded ? await client.readContract({address: marketFor(plan).params.loanToken, abi: erc20Abi,
      functionName: 'balanceOf', args: [plan.owner]}) : undefined;
    assertWalletPlan(getTradeRoute(), plan, balance);
  };
  const requote = async (plan: IncomePlan, client: PublicClient) => {
    const {data, sourceAt} = source(), selected = marketFor(plan);
    const spread = refreshSpread(plan.spread, data.market[selected.symbol], sourceAt);
    const current = await readMorpho(client, selected, plan.owner);
    if (formatUnits(current.multiplier, 18) !== plan.multiplier) throw new Error('Stock share multiplier changed. Unwind the loan and prepare a new strategy.');
    const quote = await quoteSpread(client, {market: selected, spread, account: plan.account, quantity: plan.quantity, multiplier: plan.multiplier, fixedAmount: plan.quote.amount});
    return {quote, spread, current};
  };
  const prepare = () => perform(async ({owner, client, guard}) => {
    if (loadFunding(owner)) throw new Error('Finish the saved strategy before preparing another loan.');
    stockUnits(quantity);
    const current = await readMorpho(client, market, owner); guard();
    const {data, sourceAt} = source(), selectedExpiry = expiry || expiries[0];
    const spread = selectSpread({symbol, market: data.market[symbol], price: String(data.futuresAssetIndexMap[symbol]), expiry: selectedExpiry, style, sourceAt});
    const account = tradingAddress!, multiplier = formatUnits(current.multiplier, 18);
    const quote = await quoteSpread(client, {market, spread, account, quantity, multiplier}); guard();
    if (stockUnits(quantity) > current.balance) throw new Error('Insufficient stock tokens in the connected wallet.');
    projectLoan({collateral: current.position.collateral, debt: current.debt, addCollateral: stockUnits(quantity), borrow: BigInt(quote.amount), oraclePrice: current.oraclePrice, lltv: market.params.lltv, liquidity: current.liquidity});
    const plan: IncomePlan = {id: crypto.randomUUID(), chainId: 4663, owner, account, fundingMode: walletMode ? 'wallet' : 'account', initialBorrowShares:current.position.borrowShares.toString(), marketId: market.id, createdBlock:current.block.toString(), quantity, multiplier, quote, spread, style};
    await assertReady(plan, false, client); guard(plan);
    if (!getTradeRoute().canOpen) throw new Error('Account open access is unavailable. Refresh your trading access.');
    setSnapshot(current); setReview(plan);
  });
  const reviewFunding = (replacementStyle?: typeof style) => perform(async ({owner, client, guard}) => {
    const saved = loadFunding(owner);
    if (!saved) throw new Error('Prepare a strategy before refreshing its funding quote.');
    guard(saved.plan);
    const selected = marketFor(saved.plan), {data, sourceAt} = source();
    const current = await readMorpho(client, selected, owner); guard(saved.plan);
    // Old journals have no baseline; only a verified zero-debt state can be repriced.
    updateUnborrowedQuote(saved, saved.plan.quote, saved.plan.spread, current.position.borrowShares, current.block);
    if (formatUnits(current.multiplier,18) !== saved.plan.multiplier) throw new Error('Stock share multiplier changed. Manage the original strategy before continuing.');
    const spread = replacementStyle ? selectSpread({symbol:selected.symbol, market:data.market[selected.symbol],
      price:String(data.futuresAssetIndexMap[selected.symbol]), expiry:saved.plan.spread.expiry, style:replacementStyle, sourceAt})
      : refreshSpread(saved.plan.spread, data.market[selected.symbol], sourceAt, 'review');
    const quote = await quoteSpread(client, {market:selected, spread, account:saved.plan.account,
      quantity:saved.plan.quantity, multiplier:saved.plan.multiplier}); guard(saved.plan);
    const updated = replacementStyle ? reviewUnborrowedStrategy(saved, quote, spread, current.position.borrowShares, current.block, replacementStyle)
      : updateUnborrowedQuote(saved, quote, spread, current.position.borrowShares, current.block);
    const supplied = saved.steps.supply.status === 'confirmed';
    const quantity = stockUnits(saved.plan.quantity);
    if (supplied ? current.position.collateral < quantity : current.balance < quantity) throw new Error('The saved stock collateral changed. Reconcile the original supply.');
    projectLoan({collateral:current.position.collateral, debt:current.debt, addCollateral:supplied ? 0n : quantity,
      borrow:BigInt(quote.amount), oraclePrice:current.oraclePrice, lltv:selected.params.lltv, liquidity:current.liquidity});
    await assertReady(updated.plan, false, client); guard(updated.plan);
    if (supplied) {await preflightTransaction(client, owner, fundingTransactions(updated.plan).borrow); guard(updated.plan);}
    publish(updated); setSnapshot(current); if (replacementStyle) setStyleState(replacementStyle);
  });
  const refreshFundingQuote = () => reviewFunding();
  const reviewReplacementStrategy = (selectedStyle: typeof style) => reviewFunding(selectedStyle);
  const reviewOrder = (replacementStyle?: typeof style) => perform(async ({owner,client,guard}) => {
    const saved=loadFunding(owner);
    if (!saved || !FUNDING_STEPS.every(step=>saved.steps[step].status==='confirmed') || !saved.steps.borrow.hash) throw new Error('Confirm the original funding first.');
    if (saved.order || saved.management || managementPending(saved.walletApproval)) throw new Error('Resolve the existing order, management or approval before reviewing.');
    guard(saved.plan);
    const selected=marketFor(saved.plan), active=executionPlan(saved);
    const [current,baseline]=await Promise.all([readMorpho(client,selected,owner),saved.execution
      ? Promise.resolve({borrowShares:saved.execution.borrowShares,collateral:saved.execution.collateral,block:saved.execution.block})
      : readFundedState(client,saved.plan,saved.steps.borrow.hash)]); guard(saved.plan);
    assertFundedPosition(saved,current.position,baseline);
    if (formatUnits(current.multiplier,18)!==saved.plan.multiplier) throw new Error('Stock share multiplier changed. Manage the original loan.');
    const {data,sourceAt}=source();
    const spread=replacementStyle ? selectSpread({symbol:selected.symbol,market:data.market[selected.symbol],price:String(data.futuresAssetIndexMap[selected.symbol]),
      expiry:active.spread.expiry,style:replacementStyle,sourceAt}) : refreshSpread(active.spread,data.market[selected.symbol],sourceAt,'review');
    const quote=await quoteSpread(client,{market:selected,spread,account:active.account,quantity:active.quantity,multiplier:active.multiplier,
      ...(replacementStyle ? {} : {fixedAmount:active.quote.amount})}); guard(saved.plan);
    const updated=replacementStyle ? reviewFundedExecution(saved,quote,spread,replacementStyle,baseline,current.position)
      : updateFundedQuote(saved,quote,spread,baseline,current.position);
    projectLoan({collateral:current.position.collateral,debt:current.debt,addCollateral:0n,borrow:0n,oraclePrice:current.oraclePrice,lltv:selected.params.lltv,liquidity:current.liquidity});
    const orderPlan=executionPlan(updated);
    await assertReady(orderPlan,true,client); guard(orderPlan);
    if (walletMode) {await preflightTransaction(client,owner,walletApprovalTransaction(orderPlan)); guard(orderPlan);}
    publish(updated); setSnapshot(current); if (replacementStyle) setStyleState(replacementStyle);
  });
  const refreshOrderQuote=()=>reviewOrder();
  const reviewAvailableStrategy=(selectedStyle:typeof style)=>reviewOrder(selectedStyle);
  const fund = () => perform(async ({owner, client, guard}) => {
    let saved = loadFunding(owner);
    if (!saved) {
      if (!review || Date.now()/1000 - review.quote.quotedAt > 45) throw new Error('Review a fresh quote before borrowing.');
      guard(review); await assertReady(review, false, client); guard(review);
      saved = createFunding(review); publish(saved); setReview(null);
    }
    guard(saved.plan);
    if (saved.management || saved.order) throw new Error('Funding is closed for this strategy. Manage its existing loan below.');
    const wallet = await getWalletClient(config, {chainId: 4663}); guard(saved.plan);
    if (wallet.account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Connected wallet changed.');
    const adapter = makeFundingAdapter(client, wallet, guard, async plan => {
      const {quote,spread} = await requote(plan, client); guard(plan);
      await assertReady({...plan,quote,spread}, false, client); guard(plan);
      if (!getTradeRoute().canOpen) throw new Error('Account open access is unavailable.');
    });
    await access.action(() => runFunding(saved!, adapter, value => {if (live.current.address === owner) {setJournal(value); setPositions(loadPositions(owner));}}));
  });
  const verifyOrder = (saved: FundingJournal, result: ObservedOrder) => {
    const p = result.order.params, plan = executionPlan(saved), selected = marketFor(plan), identity = result.order.session.identity;
    if (result.order.action !== 'open' || identity.chainId !== '4663' || identity.owner !== plan.owner.toLowerCase() || identity.account !== plan.account.toLowerCase()
      || p.underlyingAssetIndex !== String(selected.index) || p.amountIn !== plan.quote.amount || p.minSize !== plan.quote.minSize || p.length !== '2'
      || (p.optionIds as string[])[0]?.toLowerCase() !== plan.spread.short.optionId.toLowerCase()
      || (p.optionIds as string[])[1]?.toLowerCase() !== plan.spread.long.optionId.toLowerCase()
      || JSON.stringify(p.isBuys) !== '[false,true,false,false]' || JSON.stringify(p.isCalls) !== '[true,true,false,false]') throw new Error('Order does not match this strategy.');
    if (saved.order?.requestId && result.order.requestId !== saved.order.requestId) throw new Error('The original order ID changed.');
  };
  const applyOrder = async (saved: FundingJournal, result: ObservedOrder, client:PublicClient, guard:(plan?:IncomePlan)=>void) => {
    verifyOrder(saved,result);
    const completion = orderCompletion(result.status);
    let fill:NonNullable<FundingJournal['order']>['fill'];
    if (completion==='success') {
      const key=result.status?.requestKey;
      if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('The filled order request key is unavailable. Check the original order again.');
      const observed=await readPositionOrder(client,executionPlan(saved),key as Hex); guard(saved.plan);
      if (observed.status!=='filled' || !observed.fill) throw new Error('The filled order amounts are not yet confirmed. Check the original order again.');
      fill=observed.fill;
    }
    publish({...saved, order: {requestId: result.order.requestId, status: completion === 'success' ? 'filled' : completion === 'error' ? 'failed' : result.status ? 'pending' : 'unknown',
      ...(fill ? {fill} : {}),
      ...(!result.status ? {notSubmitted:true as const} : {})}});
  };
  const checkWalletOrder = async (saved: FundingJournal, client: PublicClient, guard: (plan?: IncomePlan) => void, hash?: Hex) => {
    const originalHash = saved.order?.hash ?? hash;
    if (!originalHash) throw new Error('Enter the original wallet transaction hash to recover this order.');
    if (saved.order?.hash && hash && saved.order.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('The original transaction hash changed.');
    const result = await readWalletOrder(client, executionPlan(saved), originalHash, BigInt(saved.order?.createdBlock ?? saved.plan.createdBlock));
    guard(saved.plan);
    publish({...saved, error: undefined, order: {...saved.order, ...result, hash: originalHash}});
  };
  const openWallet = async (saved: FundingJournal, plan: IncomePlan, client: PublicClient, guard: (plan?: IncomePlan) => void) => {
    await assertReady(plan, true, client); guard(plan);
    const wallet = await getWalletClient(config, {chainId: 4663}); guard(plan);
    const approval = walletApprovalTransaction(plan);
    if (managementPending(saved.walletApproval)) {
      if (!saved.walletApproval?.hash) throw new Error('Reconcile the original USDG approval transaction before continuing.');
      const status = await readLendingReceipt(client, plan.owner, approval, saved.walletApproval.hash, BigInt(plan.createdBlock)); guard(plan);
      saved = {...saved, walletApproval: {...saved.walletApproval, status}}; publish(saved);
      if (status !== 'confirmed') return;
    }
    const allowance = await client.readContract({address: approval.to, abi: erc20Abi, functionName: 'allowance',
      args: [plan.owner, CONTRACT_ADDRESSES.Robinhood.CONTROLLER as Address]}); guard(plan);
    if (allowance < BigInt(plan.quote.amount)) {
      await preflightTransaction(client, plan.owner, approval); guard(plan);
      saved = {...saved, walletApproval: {status: 'sending'}, error: undefined}; publish(saved);
      try {
        guard(plan);
        if (await wallet.getChainId() !== 4663) throw new Error('Select Robinhood Chain.');
        guard(plan);
        const hash = await wallet.sendTransaction({account: plan.owner, chain: client.chain, ...approval});
        saved = {...saved, walletApproval: {status: 'pending', hash}}; publish(saved);
      } catch (e) {
        publish({...saved, walletApproval: {...saved.walletApproval, status: isSignatureRejected(e) ? 'rejected' : 'unknown'}, error: message(e)}); return;
      }
      const status = await readLendingReceipt(client, plan.owner, approval, saved.walletApproval!.hash!, BigInt(plan.createdBlock)); guard(plan);
      publish({...saved, walletApproval: {...saved.walletApproval!, status}});
      return; // Review the order again after the separate approval finishes.
    }
    const block = await client.getBlock(); guard(plan);
    let submitted: FundingJournal = {...saved, order: {status: 'sending', createdBlock: block.number.toString()}, error: undefined}; publish(submitted);
    try {
      const result = await sendCreateOpenPosition(SupportedChains.Robinhood, plan.owner, false, marketFor(plan).symbol as UnderlyingAsset,
        plan.spread.expiry, '2', plan.spread.short, plan.spread.long, true, formatUnits(BigInt(plan.quote.target),18), 0.5,
        NetworkQuoteAsset.Robinhood.USDC, formatUnits(BigInt(plan.quote.amount),6), zeroAddress,
        {source: 0, onSubmitError: e => {throw e;}, onSubmitted: hash => {
          submitted = {...submitted, order: {...submitted.order!, status: 'pending', hash}}; publish(submitted);
        }});
      if (submitted.order?.hash) await checkWalletOrder(submitted, client, guard);
      else {
        publish({...submitted, order: {...submitted.order!, status: 'unknown', ...(typeof result === 'string' ? {requestId: result} : {})}});
        throw new Error('Order submission is unconfirmed. Recover its original transaction before retrying.');
      }
    } catch (e) {
      const rejected = !submitted.order?.hash && isSignatureRejected(e);
      publish({...submitted, error: message(e), order: {...submitted.order!, status: rejected ? 'failed' : 'unknown'}});
      throw e;
    }
  };
  const open = () => perform(async ({owner, client, guard}) => {
    let saved = loadFunding(owner);
    if (!saved || !FUNDING_STEPS.every(step => saved!.steps[step].status === 'confirmed')) throw new Error('Confirm the Morpho funding steps first.');
    if (saved.management || saved.order && saved.order.status !== 'failed') throw new Error('Check the existing order or manage the loan before continuing.');
    guard(saved.plan);
    if (!saved.execution) throw new Error('Review the funded order quote before continuing.');
    const {quote, spread, current} = await requote(executionPlan(saved), client); guard(saved.plan);
    assertFundedPosition(saved,current.position);
    if (current.position.borrowShares === 0n || current.position.collateral < stockUnits(saved.plan.quantity)) throw new Error('The loan or collateral changed. Manage the existing position.');
    projectLoan({collateral: current.position.collateral, debt: current.debt, addCollateral: 0n, borrow: 0n, oraclePrice: current.oraclePrice, lltv: marketFor(saved.plan).params.lltv, liquidity: current.liquidity});
    // Keep lending calldata immutable while pinning the fresh order economics.
    saved={...saved,execution:{...saved.execution,quote,spread},incomeBasis:{
      tokenPrice:new BN(current.oraclePrice.toString()).div('1e24').toFixed(),
      borrowApr:new BN(current.borrowRate.toString()).times(31_536_000).div('1e18').toFixed(),
      startedAt:Math.floor(Date.now()/1000),
    }}; publish(saved);
    const orderPlan=executionPlan(saved);
    if (walletMode) {await openWallet(saved, orderPlan, client, guard); return;}
    await assertReady(orderPlan, true, client); guard(saved.plan);
    const route = getTradeRoute();
    if (route.kind !== 'account' || !route.canOpen || route.tradeAddress?.toLowerCase() !== saved.plan.account.toLowerCase()) throw new Error('Your Deposit Account is not ready for trading.');
    // Persist only once the canonical entry has allocated its UUID. Until
    // that synchronous callback no order can be signed; a crash needs no recovery.
    saved = {...saved, order: undefined, error: undefined};
    let submitted = saved, captured = false;
    try {
      await sendCreateOpenPosition(SupportedChains.Robinhood, owner, false, marketFor(saved.plan).symbol as UnderlyingAsset,
        spread.expiry, '2', spread.short, spread.long, true, formatUnits(BigInt(quote.target),18), 0.5,
        NetworkQuoteAsset.Robinhood.USDC, formatUnits(BigInt(quote.amount),6), zeroAddress,
        {source: 0, onSubmitError: e => {throw e;}, sponsored: async input => {
          guard(submitted.plan);
          const result = await access.submit(input, pending => {
            guard(submitted.plan);
            submitted = {...submitted,order:{status:'sending',requestId:pending.order.requestId}};
            publish(submitted);
          }); captured = true;
          if (result.rejectedUnsigned) publish({...submitted, error: result.error ?? undefined, order: {status:'failed',requestId:result.order.requestId}});
          else await applyOrder(submitted, result,client,guard);
          return result;
        }});
    } catch (e) {
      if (!captured) publish({...submitted, error: message(e), order: submitted.order?.requestId ? {...submitted.order,status:'unknown'} : undefined});
      throw e;
    }
    void access.refresh();
  });
  const checkOrder = (requestId?: string) => perform(async ({owner, client, guard}) => {
    const saved = loadFunding(owner), id = saved?.order?.requestId ?? requestId?.trim();
    if (walletMode) {
      if (!saved?.order) throw new Error('No original wallet order is available.');
      guard(saved.plan);
      const hash = requestId?.trim();
      if (hash && !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter the original transaction hash.');
      await checkWalletOrder(saved, client, guard, hash as Hex | undefined); return;
    }
    if (!saved || !id || !access.controller?.trades) throw new Error('Enter the original CallPut order ID to recover its status.');
    guard(saved.plan);
    const result = access.orderStatus(id) ?? await access.controller.trades.readOrder(id, true); guard(saved.plan);
    if (!result) {
      await access.controller.trades.discardUnsigned(id); guard(saved.plan);
      publish({...saved,order:{status:'failed',requestId:id},error:undefined}); return;
    }
    await applyOrder(saved, result,client,guard);
  });
  const resumeOrder = () => perform(async ({owner,client,guard}) => {
    const saved = loadFunding(owner), id = saved?.order?.requestId, trades = access.controller?.trades;
    if (!saved || !id || !trades) throw new Error('No original order ID is available.');
    guard(saved.plan);
    await access.action(async () => {
      const recovered = await resumeOriginalOrder(id,{
        guard: () => guard(saved.plan),verify: result => verifyOrder(saved,result),
        read: requestId => trades.readOrder(requestId,true),discardUnsigned: requestId => trades.discardUnsigned(requestId),
        blockTimestamp: async () => (await client.getBlock()).timestamp,submit: order => trades.submit(order),
      });
      if (recovered.status === 'failed') publish({...saved,order:{status:'failed',requestId:id},error:undefined});
      else await applyOrder(saved,recovered.result,client,guard);
    });
  });
  const manage = (action: ManagementAction) => perform(async ({owner, client, guard}) => {
    const saved = loadFunding(owner); if (!saved) throw new Error('No saved strategy.');
    guard(saved.plan);
    if (FUNDING_STEPS.some(step => managementPending(saved.steps[step])) || managementPending(saved.walletApproval) || saved.order && !['filled','failed'].includes(saved.order.status)) throw new Error('Resolve pending transactions and orders before changing the loan.');
    const wallet = await getWalletClient(config, {chainId:4663}); guard(saved.plan);
    await access.action(() => runManagement(saved, action, {
      guard: () => guard(saved.plan), persist: publish, isRejected: isSignatureRejected,
      prepare: async () => {
        const current = await readMorpho(client, marketFor(saved.plan), owner); guard(saved.plan);
        const operation = managementTransaction(action, current, owner);
        await preflightTransaction(client, owner, operation.tx); guard(saved.plan);
        return {action, amount: operation.amount, to: operation.tx.to, data: operation.tx.data,createdBlock:current.block.toString()};
      },
      send: async op => {guard(saved.plan); if (await wallet.getChainId() !== 4663) throw new Error('Select Robinhood Chain.'); guard(saved.plan);
        return wallet.sendTransaction({account:owner,chain:client.chain,to:op.to,data:op.data,value:0n});},
      receipt: op => readLendingReceipt(client,owner,{to:op.to,data:op.data,value:0n},op.hash!,BigInt(op.createdBlock)),
    }));
  });
  const reconcile = (step: FundingStep | 'management' | 'walletApproval', hash: string) => perform(async ({owner,client,guard}) => {
    if (!/^0x[0-9a-f]{64}$/i.test(hash.trim())) throw new Error('Enter a valid transaction hash from your wallet history.');
    const saved = loadFunding(owner); if (!saved) throw new Error('No saved strategy.'); guard(saved.plan);
    const old = step === 'management' ? saved.management : step === 'walletApproval' ? saved.walletApproval : saved.steps[step];
    if (!canReconcileTransaction(old)) throw new Error('This step does not need reconciliation.');
    const tx = step === 'management' ? {...saved.management!,value:0n} : step === 'walletApproval' ? walletApprovalTransaction(executionPlan(saved)) : fundingTransactions(saved.plan)[step];
    const status = await readLendingReceipt(client,owner,tx,hash.trim() as Hex,BigInt(step === 'management' ? saved.management!.createdBlock : saved.plan.createdBlock)); guard(saved.plan);
    publish(step === 'management' ? {...saved,management:{...saved.management!,hash:hash.trim() as Hex,status},error:undefined}
      : step === 'walletApproval' ? {...saved,walletApproval:{hash:hash.trim() as Hex,status},error:undefined}
      : {...saved,steps:{...saved.steps,[step]:{hash:hash.trim() as Hex,status}},error:undefined});
  });
  const archive = () => perform(async ({owner,client,guard}) => {
    const saved = loadFunding(owner); if (!saved) return;
    const current = await readMorpho(client,marketFor(saved.plan),owner); guard(saved.plan);
    if (!canArchive(saved,current.debt,current.position.collateral)) throw new Error('Resolve pending steps, repay the loan and withdraw collateral first.');
    archiveFunding(owner,saved.plan.id); restore(null); setPositions(loadPositions(owner));
  });
  // Caller holds the owner lock and has checked the active journal identity.
  const startDraft = ({owner,guard}:{owner:Address;guard(plan?:IncomePlan):void}) => {
    const saved=loadFunding(owner); if (!saved) return;
    guard(saved.plan); startNextStrategy(owner); restore(null); setPositions(loadPositions(owner));
  };
  const startNew = () => perform(async ctx => {
    startDraft(ctx);
    setExpiryState(0); setStyleState('balanced');
  });
  const selectPosition = (id: string) => perform(async ({owner,guard}) => {
    const candidate=loadPositions(owner).find(value=>value.plan.id===id);
    if (!candidate) throw new Error('This saved strategy is unavailable.');
    // Selection is a storage-only transition; validate its custody before changing it.
    if ((candidate.plan.fundingMode ?? 'account') !== (walletMode ? 'wallet' : 'account')
      || candidate.plan.account.toLowerCase() !== tradingAddress?.toLowerCase()) throw new Error('Restore this strategy’s original trading mode and account to manage it.');
    guard(); restore(activateFunding(owner,id)); setPositions(loadPositions(owner));
  });
  const change = (run: () => void) => {
    if (busyRef.current) return;
    if (!journal) {run();setReview(null);setError('');return;}
    if (!canStartNextStrategy(journal)) return;
    void perform(async ctx => {
      startDraft(ctx);
      run(); setReview(null); setError('');
    });
  };
  return {address,chainId,access,onboarding,login,walletMode,tradingAddress,market,marketData,quantity,style,expiry: expiry || expiries[0] || 0,expiries,review,journal,positions,snapshot,error,busy,reading,now,
    holdingsOwner,holdingBalance,holdingMultiplier,holdingsLoading,holdingsError,refreshHoldings:holdingsRead.refetch,
    setSymbol: (value: typeof symbol) => change(() => {setSymbolState(value);setExpiryState(0);setQuantityState('1');}),
    setQuantity: (value: string) => change(() => setQuantityState(value)),setStyle:(value:typeof style) => change(() => setStyleState(value)),
    setExpiry:(value:number) => change(() => setExpiryState(value)),refresh,refreshFundingQuote,reviewReplacementStrategy,refreshOrderQuote,reviewAvailableStrategy,prepare,fund,open,checkOrder,resumeOrder,manage,reconcile,archive,startNew,selectPosition};
}
