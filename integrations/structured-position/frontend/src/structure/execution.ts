import {BN} from '../utils/bn';
import type {Quote} from './quote';
import {isSpreadStyle, type Spread, type SpreadStyle} from './strategy';
import type {FundingJournal, IncomePlan} from './workflow';

export interface FundedState {borrowShares: string; collateral: string; block: string}
export interface FundedExecution extends FundedState {quote: Quote; spread: Spread; style?: SpreadStyle}
type Position = {borrowShares: bigint; collateral: bigint};
const uint = (v: string) => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);
const pending = (status?: string) => ['sending','pending','unknown'].includes(status ?? '');
const sameLegs = (a: Spread,b: Spread) => a.short.optionId.toLowerCase() === b.short.optionId.toLowerCase()
  && a.long.optionId.toLowerCase() === b.long.optionId.toLowerCase()
  && String(a.short.strikePrice) === String(b.short.strikePrice) && String(a.long.strikePrice) === String(b.long.strikePrice);

/** The lending plan remains immutable. This view is exclusively for the order. */
export function executionPlan(journal: FundingJournal): IncomePlan {
  const e=journal.execution, original=journal.plan;
  if (!e) return original;
  if (!Object.values(journal.steps).every(s=>s.status==='confirmed') || !journal.steps.borrow.hash) throw new Error('The funded position is not confirmed.');
  const q=e.quote,s=e.spread;
  if (s.symbol !== original.spread.symbol || s.expiry !== original.spread.expiry
    || q.expiry !== original.quote.expiry || q.expiry !== s.expiry) throw new Error('The order route or expiry changed.');
  if (q.target !== original.quote.target || q.minSize !== original.quote.minSize) throw new Error('The reviewed order size changed.');
  if (![q.amount,q.fee,q.size,q.target,q.minSize,q.optionTokenId,e.borrowShares,e.collateral,e.block].every(uint)
    || BigInt(q.amount) <= 0n || BigInt(q.amount) > BigInt(original.quote.amount) || BigInt(q.fee) >= BigInt(q.amount)) throw new Error('Option funding exceeds the original borrowed amount or is invalid.');
  if (BigInt(q.optionTokenId)<=0n || BigInt(q.target)<=0n || BigInt(q.minSize)<=0n
    || BigInt(q.size)<BigInt(q.minSize) || BigInt(q.size)>BigInt(q.target)*10050n/10000n
    || BigInt(e.borrowShares)<=0n || BigInt(e.collateral)<=0n || BigInt(e.block)<BigInt(original.createdBlock)) throw new Error('The funded position or option size is invalid.');
  const width=new BN(String(s.long.strikePrice)).minus(String(s.short.strikePrice));
  const premium=new BN(s.premium);
  if (e.style !== undefined && !isSpreadStyle(e.style) || !s.short.isOptionAvailable || !s.long.isOptionAvailable
    || ![s.short.optionId,s.long.optionId].every(v=>/^0x[0-9a-f]{64}$/i.test(v))
    || s.short.optionId.toLowerCase()===s.long.optionId.toLowerCase()
    || !width.isFinite() || !width.gt(0) || !width.eq(s.width)
    || !premium.isFinite() || !premium.gt(0) || !premium.lt(width)
    || !premium.eq(new BN(String(s.short.markPrice)).minus(String(s.long.markPrice)))) throw new Error('The reviewed spread is unavailable or invalid.');
  return {...original,quote:q,spread:s,style:e.style};
}

export function assertFundedPosition(journal: FundingJournal, position: Position, baseline: FundedState | undefined=journal.execution) {
  if (!baseline || !uint(baseline.borrowShares) || !uint(baseline.collateral)
    || position.borrowShares!==BigInt(baseline.borrowShares) || position.collateral!==BigInt(baseline.collateral)) {
    throw new Error('The funded debt or collateral position changed. Manage the existing loan before continuing.');
  }
}
function assertReview(journal: FundingJournal, baseline: FundedState, position: Position) {
  if (!Object.values(journal.steps).every(s=>s.status==='confirmed') || !journal.steps.borrow.hash) throw new Error('Confirm the original funding first.');
  if (journal.order) throw new Error('Resolve the existing order before reviewing another strategy.');
  if (journal.management) throw new Error('Manage the existing loan before reviewing an order.');
  if (pending(journal.walletApproval?.status)) throw new Error('Reconcile the pending USDG approval first.');
  assertFundedPosition(journal,position,baseline);
  if (journal.execution) assertFundedPosition(journal,position);
}

export function reviewFundedExecution(journal: FundingJournal, quote: Quote, spread: Spread,
  style: SpreadStyle, baseline: FundedState, position: Position): FundingJournal {
  assertReview(journal,baseline,position);
  if (journal.walletApproval?.hash || journal.walletApproval?.status==='confirmed') throw new Error('The original approval was submitted. Keep its reviewed strategy or manage the loan.');
  const next=structuredClone(journal);
  next.execution={...baseline,quote:structuredClone(quote),spread:structuredClone(spread),style};
  executionPlan(next);
  next.walletApproval=undefined; next.error=undefined;
  return next;
}
/** Explicit price review of the same funded order, retaining its exact approval. */
export function updateFundedQuote(journal: FundingJournal, quote: Quote, spread: Spread,
  baseline: FundedState, position: Position): FundingJournal {
  assertReview(journal,baseline,position);
  const previous=executionPlan(journal);
  if (!sameLegs(previous.spread,spread) || quote.optionTokenId!==previous.quote.optionTokenId) throw new Error('The saved order legs changed. Review an available strategy first.');
  if (quote.amount!==previous.quote.amount) throw new Error('The funded order amount changed.');
  const next=structuredClone(journal);
  next.execution={...baseline,quote:structuredClone(quote),spread:structuredClone(spread),style:previous.style};
  executionPlan(next); next.error=undefined;
  return next;
}
