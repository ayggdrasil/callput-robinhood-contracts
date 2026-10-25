import type {Hex} from 'viem';
import type {ObservedOrder} from '../utils/sponsoredOrderMonitor';
import type {SessionOrder, SessionTradeStatus} from '../utils/sessionTradePolicy';
import {validateBlockTimestamp} from './morpho';
import {FUNDING_STEPS, type FundingJournal} from './workflow';
import type {Quote} from './quote';
import {isSpreadStyle, type Spread, type SpreadStyle} from './strategy';
import {BN} from '../utils/bn';

export interface OriginalOrderRecoveryPort {
  guard(): void;
  /** Pure identity/legs check. It must not persist or submit. */
  verify(result: ObservedOrder): void;
  read(id: string): Promise<ObservedOrder | null>;
  discardUnsigned(id: string): Promise<void>;
  blockTimestamp(): Promise<bigint>;
  submit(order: SessionOrder): Promise<SessionTradeStatus>;
}
export type OriginalOrderRecovery =
  | {status: 'failed'; requestId: string}
  | {status: 'observed'; result: ObservedOrder};

/**
 * Recover one persisted sponsored order without ever allocating a replacement
 * UUID. A missing relay status is not failure while the signed local intent
 * still exists; after expiry it takes two canonical reads separated by the
 * five-minute evidence window to retire that exact intent.
 */
export async function resumeOriginalOrder(id: string,
  port: OriginalOrderRecoveryPort): Promise<OriginalOrderRecovery> {
  port.guard();
  const original = await port.read(id); port.guard();
  if (!original) {
    await port.discardUnsigned(id); port.guard();
    return {status: 'failed', requestId: id};
  }
  port.verify(original); port.guard();
  if (original.status) return {status: 'observed', result: original};

  const timestamp = await port.blockTimestamp(); port.guard();
  validateBlockTimestamp(timestamp);
  if (!/^(0|[1-9][0-9]*)$/.test(original.order.deadline)) throw new Error('The original order deadline is invalid.');
  const deadline = BigInt(original.order.deadline);
  if (timestamp <= deadline) {
    // `submit` reuses the IndexedDB intent for this requestId; passing the
    // original order object makes allocating a new UUID impossible here.
    port.guard();
    const status = await port.submit(original.order); port.guard();
    const observed = {order: original.order, status};
    port.verify(observed); port.guard();
    return {status: 'observed', result: observed};
  }
  if (timestamp <= deadline + 300n) {
    throw new Error('The original order expired. Check again five minutes after its deadline before unwinding.');
  }

  const checked = await port.read(id); port.guard();
  if (!checked) throw new Error('Original order evidence is unavailable.');
  port.verify(checked); port.guard();
  if (checked.status) return {status: 'observed', result: checked};
  return {status: 'failed', requestId: id};
}

export type Management = NonNullable<FundingJournal['management']>;
export type ManagementAction = Management['action'];
export const managementPending = (step?: {status: string}) => Boolean(step && ['sending', 'pending', 'unknown'].includes(step.status));
/** Provider rejection is not chain evidence. Recovery still verifies the exact
 * sender, calldata, receipt and strategy block before changing the journal. */
export const canReconcileTransaction = (step?: {status: string}) => managementPending(step) || step?.status === 'rejected';
/** Explicit quote review only. Confirmed collateral transactions stay pinned;
 * a possible/confirmed borrow or changed debt can never change its amount. */
export function updateUnborrowedQuote(journal: FundingJournal, quote: Quote, spread: Spread,
  borrowShares: bigint, block: bigint): FundingJournal {
  assertUnborrowed(journal, quote, spread, borrowShares, block);
  const plan = journal.plan;
  if (spread.short.optionId.toLowerCase() !== plan.spread.short.optionId.toLowerCase()
    || spread.long.optionId.toLowerCase() !== plan.spread.long.optionId.toLowerCase()
    || String(spread.short.strikePrice) !== String(plan.spread.short.strikePrice)
    || String(spread.long.strikePrice) !== String(plan.spread.long.strikePrice)) throw new Error('The saved spread legs or route changed.');
  if (quote.optionTokenId !== plan.quote.optionTokenId) throw new Error('The reviewed option identity changed.');
  return reviewedJournal(journal, quote, spread);
}
function assertUnborrowed(journal: FundingJournal, quote: Quote, spread: Spread, borrowShares: bigint, block: bigint) {
  const plan = journal.plan;
  if (journal.steps.borrow.status !== 'idle') throw new Error('The borrow step already started. Reconcile it before changing the quote.');
  if (journal.order || journal.management || journal.walletApproval) throw new Error('Manage the existing strategy before changing its order quote.');
  if (FUNDING_STEPS.some(step => managementPending(journal.steps[step]))) throw new Error('Reconcile pending funding before updating the quote.');
  const baseline = plan.initialBorrowShares ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(baseline) || borrowShares !== BigInt(baseline)) throw new Error('The Morpho debt changed. Do not borrow again.');
  if (block < BigInt(plan.createdBlock)) throw new Error('The current block predates this strategy.');
  if (spread.symbol !== plan.spread.symbol || spread.expiry !== plan.spread.expiry) throw new Error('The saved spread route changed.');
  if (quote.expiry !== plan.quote.expiry || quote.expiry !== spread.expiry
    || quote.target !== plan.quote.target || quote.minSize !== plan.quote.minSize) throw new Error('The reviewed quote size or option identity changed.');
  if (!/^[1-9]\d*$/.test(quote.amount) || !/^(0|[1-9]\d*)$/.test(quote.fee)
    || BigInt(quote.fee) >= BigInt(quote.amount)) throw new Error('The refreshed funding quote is invalid.');
}
function reviewedJournal(journal: FundingJournal, quote: Quote, spread: Spread): FundingJournal {
  const next = structuredClone(journal);
  next.plan = {...next.plan, quote: structuredClone(quote), spread: structuredClone(spread)};
  next.error = undefined;
  return next;
}
/** Explicit replacement review, never an automatic requote or a funded order change. */
export function reviewUnborrowedStrategy(journal: FundingJournal, quote: Quote, spread: Spread,
  borrowShares: bigint, block: bigint, style: SpreadStyle): FundingJournal {
  assertUnborrowed(journal, quote, spread, borrowShares, block);
  const width = new BN(String(spread.long.strikePrice)).minus(String(spread.short.strikePrice));
  const premium = new BN(spread.premium);
  if (!isSpreadStyle(style) || !spread.short.isOptionAvailable || !spread.long.isOptionAvailable
    || spread.short.optionId.toLowerCase() === spread.long.optionId.toLowerCase()
    || !width.isFinite() || !width.gt(0) || !width.eq(spread.width)
    || !premium.isFinite() || !premium.gt(0) || !premium.lt(width)) throw new Error('The replacement strategy is unavailable.');
  const next = reviewedJournal(journal, quote, spread);
  next.plan.style = style;
  return next;
}
export function canArchive(journal: FundingJournal, debt: bigint, collateral: bigint) {
  return debt === 0n && collateral === 0n && !FUNDING_STEPS.some(step => managementPending(journal.steps[step]))
    && !managementPending(journal.management) && !managementPending(journal.walletApproval)
    && (!journal.order || ['filled', 'failed'].includes(journal.order.status));
}
export async function runManagement(input: FundingJournal, action: ManagementAction, port: {
  guard(): void; persist(value: FundingJournal): void;
  prepare(): Promise<Omit<Management, 'status' | 'hash'>>;
  send(op: Management): Promise<Hex>;
  receipt(op: Management): Promise<'confirmed' | 'pending' | 'reverted'>;
  isRejected(error: unknown): boolean;
}): Promise<FundingJournal> {
  const current = structuredClone(input);
  const publish = () => port.persist(structuredClone(current));
  if (managementPending(current.management)) {
    const op = current.management!;
    if (op.action !== action) throw new Error('Finish the previous repayment or withdrawal first.');
    if (!op.hash) throw new Error('Reconcile the previous wallet submission before continuing.');
    port.guard();
    current.management = {...op, status: await port.receipt(op)}; publish(); return current;
  }
  port.guard();
  const op = await port.prepare(); port.guard();
  current.management = {...op, status: 'sending'}; current.error = undefined; publish();
  try {
    port.guard();
    const hash = await port.send(current.management);
    current.management = {...current.management, status: 'pending', hash}; publish();
  } catch (error) {
    current.error = error instanceof Error ? error.message : 'Wallet submission could not be confirmed.';
    current.management = {...current.management, status: port.isRejected(error) ? 'rejected' : 'unknown'}; publish(); return current;
  }
  current.management = {...current.management, status: await port.receipt(current.management)}; publish(); return current;
}
