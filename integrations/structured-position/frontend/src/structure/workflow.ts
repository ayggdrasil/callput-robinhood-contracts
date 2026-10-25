import type {Address, Hex} from 'viem';
import type {Quote} from './quote';
import {isSpreadStyle, type Spread, type SpreadStyle} from './strategy';
import {executionPlan, type FundedExecution} from './execution';

export const FUNDING_STEPS = ['approve', 'supply', 'borrow'] as const;
export type FundingStep = typeof FUNDING_STEPS[number];
export type StepState = {status: 'idle' | 'sending' | 'pending' | 'confirmed' | 'reverted' | 'rejected' | 'unknown'; hash?: Hex};
export interface IncomePlan {
  id: string; chainId: 4663; owner: Address; account: Address; marketId: Hex; createdBlock: string;
  quantity: string; multiplier: string; quote: Quote; spread: Spread;
  /** Missing on existing journals, which always use the deposit account. */
  fundingMode?: 'wallet' | 'account';
  /** Baseline used to prove an explicit reprice happens before this loan. */
  initialBorrowShares?: string;
  /** Retained when an unfunded strategy needs an explicit replacement review. */
  style?: SpreadStyle;
}
export interface FundingJournal {
  version: 1; plan: IncomePlan; steps: Record<FundingStep, StepState>; error?: string;
  incomeBasis?: {tokenPrice: string; borrowApr: string; startedAt: number};
  order?: {status: 'sending' | 'pending' | 'filled' | 'failed' | 'unknown'; requestId?: string; notSubmitted?: true; hash?: Hex; createdBlock?: string;
    fill?: {size: string; premium: string; filledAt: number}};
  walletApproval?: StepState;
  /** Order-only amendment; the original loan plan and receipts stay immutable. */
  execution?: FundedExecution;
  management?: StepState & {action: 'approve-repay' | 'repay' | 'withdraw'; amount: string; to: Address; data: Hex; createdBlock: string};
}
export interface FundingEnvelope {version: 2; active: FundingJournal | null; completed: FundingJournal[]}
export interface FundingAdapter {
  load(): FundingJournal | null; persist(state: FundingJournal): void;
  guard(plan: IncomePlan): void;
  preflight(plan: IncomePlan, step: FundingStep): Promise<void>;
  submit(plan: IncomePlan, step: FundingStep): Promise<Hex>;
  receipt(plan: IncomePlan, step: FundingStep, hash: Hex): Promise<'confirmed' | 'reverted' | 'pending'>;
  isRejected(error: unknown): boolean;
}
export const journalKey = (owner: string) => `callput:stock-income:v1:4663:${owner.toLowerCase()}`;
export function createFunding(plan: IncomePlan): FundingJournal {
  if (plan.chainId !== 4663 || !plan.id || !/^[1-9]\d*$/.test(plan.createdBlock) || ![plan.owner, plan.account].every(x => /^0x[0-9a-f]{40}$/i.test(x))
    || plan.style !== undefined && !isSpreadStyle(plan.style)) throw new Error('Invalid strategy identity or style.');
  return {version: 1, plan: structuredClone(plan), steps: {approve: {status: 'idle'}, supply: {status: 'idle'}, borrow: {status: 'idle'}}};
}
const stepStatuses = ['idle', 'sending', 'pending', 'confirmed', 'reverted', 'rejected', 'unknown'];
const pending = (step?: StepState) => Boolean(step && ['sending','pending','unknown'].includes(step.status));
function verifyJournal(value: unknown, owner: string): FundingJournal {
  const state = value as FundingJournal;
  if (!state || state.version !== 1 || state.plan?.chainId !== 4663 || state.plan.owner?.toLowerCase() !== owner.toLowerCase()
    || !state.plan.id || !state.plan.account || !state.plan.marketId || !state.plan.quote || !state.plan.spread
    || !FUNDING_STEPS.every(step => stepStatuses.includes(state.steps?.[step]?.status))) {
    throw new Error('Saved strategy cannot be verified. Check Morpho and your account before starting another loan.');
  }
  createFunding(state.plan);
  executionPlan(state);
  if (state.incomeBasis && (typeof state.incomeBasis.tokenPrice !== 'string' || typeof state.incomeBasis.borrowApr !== 'string'
    || !Number.isFinite(state.incomeBasis.startedAt) || state.incomeBasis.startedAt <= 0)) throw new Error('Saved strategy income basis cannot be verified.');
  if (state.order?.fill && (typeof state.order.fill.size !== 'string' || typeof state.order.fill.premium !== 'string'
    || !Number.isFinite(state.order.fill.filledAt) || state.order.fill.filledAt <= 0)) throw new Error('Saved order fill cannot be verified.');
  return state;
}
function readEnvelope(owner: string): FundingEnvelope {
  const raw = localStorage.getItem(journalKey(owner));
  if (!raw) return {version:2,active:null,completed:[]};
  const value = JSON.parse(raw) as FundingJournal | FundingEnvelope;
  if ((value as FundingJournal)?.version === 1) return {version:2,active:verifyJournal(value,owner),completed:[]};
  const envelope = value as FundingEnvelope;
  if (envelope?.version !== 2 || !Array.isArray(envelope.completed) || envelope.active === undefined) throw new Error('Saved strategies cannot be verified.');
  const active = envelope.active === null ? null : verifyJournal(envelope.active,owner);
  const completed = envelope.completed.map(item => verifyJournal(item,owner));
  if (completed.some(item=>!canStartNextStrategy(item))) throw new Error('Resolve the unverified completed strategy before starting another loan.');
  const ids = [...completed.map(item => item.plan.id),...(active ? [active.plan.id] : [])];
  if (new Set(ids).size !== ids.length) throw new Error('Saved strategy IDs must be unique.');
  return {version:2,active,completed};
}
function writeEnvelope(owner: string, envelope: FundingEnvelope) {
  const key = journalKey(owner), raw = JSON.stringify(envelope);
  localStorage.setItem(key,raw);
  if (localStorage.getItem(key) !== raw) throw new Error('Strategy progress could not be saved. No new transaction will be sent.');
}
export function loadFunding(owner: string): FundingJournal | null {return readEnvelope(owner).active;}
export function loadPositions(owner: string): FundingJournal[] {
  const state = readEnvelope(owner);
  return [...state.completed,...(state.active ? [state.active] : [])];
}
export const saveFunding = (state: FundingJournal) => {
  const owner = state.plan.owner, envelope = readEnvelope(owner);
  verifyJournal(state,owner);
  if (envelope.active && envelope.active.plan.id !== state.plan.id) throw new Error('Resolve the existing active strategy before saving another one.');
  if (envelope.completed.some(item => item.plan.id === state.plan.id)) throw new Error('A completed strategy cannot be revived by a late write.');
  writeEnvelope(owner,{...envelope,active:structuredClone(state)});
};
export function canStartNextStrategy(journal: FundingJournal | null) {
  return Boolean(journal && FUNDING_STEPS.every(step => journal.steps[step].status === 'confirmed')
    && journal.order?.status === 'filled' && (!journal.incomeBasis || journal.order.fill)
    && !pending(journal.management) && !pending(journal.walletApproval));
}
export function startNextStrategy(owner: string): void {
  const envelope = readEnvelope(owner), active = envelope.active;
  if (!active || !canStartNextStrategy(active)) throw new Error('Complete the filled strategy and resolve pending wallet operations first.');
  writeEnvelope(owner,{version:2,active:null,completed:[...envelope.completed.filter(item => item.plan.id !== active.plan.id),structuredClone(active)]});
}
export function activateFunding(owner: string, id: string): FundingJournal {
  const envelope = readEnvelope(owner);
  if (envelope.active?.plan.id === id) return envelope.active;
  if (envelope.active && !canStartNextStrategy(envelope.active)) throw new Error('Resolve the active strategy before selecting another position.');
  const selected = envelope.completed.find(item => item.plan.id === id);
  if (!selected) throw new Error('Saved position was not found.');
  const completed = envelope.completed.filter(item => item.plan.id !== id);
  if (envelope.active) completed.push(structuredClone(envelope.active));
  writeEnvelope(owner,{version:2,active:structuredClone(selected),completed});
  return structuredClone(selected);
}
export function archiveFunding(owner: string, id: string): void {
  const envelope = readEnvelope(owner), active = envelope.active;
  if (!active || active.plan.id !== id) throw new Error('Only the active strategy can be archived.');
  const archiveKey = `${journalKey(owner)}:archive:${id}`, raw = JSON.stringify(active);
  localStorage.setItem(archiveKey,raw);
  if (localStorage.getItem(archiveKey) !== raw) throw new Error('The strategy archive could not be verified.');
  writeEnvelope(owner,{...envelope,active:null});
}
/** Required across tabs. Unsupported storage/coordination fails before the first signature. */
export async function withIncomeLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate lending. Use a supported browser.');
  return navigator.locks.request(journalKey(owner), {ifAvailable: true}, lock => {
    if (!lock) throw new Error('This strategy is already being processed in another tab.');
    return run();
  });
}
const running = new Set<string>();
/** Caller holds the cross-tab lock. Every send is journaled before reaching a wallet. */
export async function runFunding(input: FundingJournal, adapter: FundingAdapter, changed?: (state: FundingJournal) => void): Promise<FundingJournal> {
  const key = journalKey(input.plan.owner);
  if (running.has(key)) throw new Error('This strategy is already running.');
  running.add(key);
  try {
    const saved = adapter.load();
    if (saved && saved.plan.id !== input.plan.id) throw new Error('Resolve the existing strategy before starting another loan.');
    let current = structuredClone(saved ?? input);
    const publish = () => {adapter.persist(current); changed?.(structuredClone(current));};
    const update = (step: FundingStep, value: StepState) => {current = {...current, steps: {...current.steps, [step]: value}}; publish();};
    publish();
    for (const step of FUNDING_STEPS) {
      const old = current.steps[step];
      if (old.status === 'confirmed') continue;
      if (old.status === 'unknown' || old.status === 'sending' && !old.hash) {
        current.error = 'A wallet submission is unconfirmed. Reconcile its transaction hash before continuing.';
        update(step, {...old, status: 'unknown'}); return current;
      }
      try {
        adapter.guard(current.plan);
        if (old.hash && (old.status === 'pending' || old.status === 'sending')) {
          const status = await adapter.receipt(current.plan, step, old.hash);
          update(step, {status, hash: old.hash});
          if (status !== 'confirmed') return current;
          adapter.guard(current.plan); continue;
        }
        await adapter.preflight(current.plan, step); adapter.guard(current.plan);
        current.error = undefined;
        update(step, {status: 'sending'});
        // Storage callbacks and wallet providers can yield to a connection change.
        adapter.guard(current.plan);
        let hash: Hex;
        try {hash = await adapter.submit(current.plan, step);}
        catch (error) {
          current.error = error instanceof Error ? error.message : 'Wallet submission could not be confirmed.';
          update(step, {status: adapter.isRejected(error) ? 'rejected' : 'unknown'}); return current;
        }
        if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Wallet returned an invalid transaction hash.');
        update(step, {status: 'pending', hash});
        const status = await adapter.receipt(current.plan, step, hash);
        update(step, {status, hash});
        if (status !== 'confirmed') return current;
        adapter.guard(current.plan);
      } catch (error) {
        current.error = error instanceof Error ? error.message : 'Strategy check failed.'; publish(); return current;
      }
    }
    current.error = undefined; publish(); return current;
  } finally {running.delete(key);}
}
