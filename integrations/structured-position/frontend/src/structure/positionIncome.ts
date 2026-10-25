import {BN} from '../utils/bn';
import {executionPlan} from './execution';
import {calculateIncome, type IncomeProjectionInput} from './incomeProjection';
import type {FundingJournal} from './workflow';

function decimal(value: string, label: string, allowZero = false) {
  const parsed = new BN(value);
  if (typeof value !== 'string' || !value.trim() || !parsed.isFinite()
    || (allowZero ? parsed.lt(0) : !parsed.gt(0))) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function units(value: string, decimals: number, label: string, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)
    || (!allowZero && BigInt(value) === 0n)) throw new Error(`Invalid ${label}.`);
  return new BN(value).div(new BN(10).pow(decimals)).toFixed();
}

/**
 * Expected entry-term net APR for a Stock Income position. It excludes settlement
 * losses and wallet gas, and must not be presented as an actual realized return.
 */
export function positionIncome(journal: FundingJournal): {
  input: IncomeProjectionInput; result: ReturnType<typeof calculateIncome>;
} | null {
  try {
    const basis = journal.incomeBasis;
    if (!basis || !Number.isSafeInteger(basis.startedAt) || basis.startedAt <= 0) return null;
    const tokenPrice = decimal(basis.tokenPrice, 'income token price');
    decimal(basis.borrowApr, 'income borrow APR', true);

    const plan = executionPlan(journal);
    const duration = plan.spread.expiry - (journal.order?.status === 'filled' && journal.order.fill
      ? journal.order.fill.filledAt : basis.startedAt);
    if (!Number.isSafeInteger(duration) || duration <= 0) return null;

    const width = decimal(plan.spread.width, 'spread width');
    const quotedShares = decimal(units(plan.quote.size, 18, 'quoted shares'), 'quoted shares');
    const quotedCash = new BN(units(plan.quote.amount, 6, 'quoted funding'))
      .minus(units(plan.quote.fee, 6, 'opening fee', true));
    if (!quotedCash.gt(0)) return null;
    const fill = journal.order?.status === 'filled' ? journal.order.fill : undefined;
    const shares = fill ? units(fill.size, 18, 'filled shares') : quotedShares.toFixed();
    const premium = fill ? units(fill.premium, 6, 'filled premium', true)
      : units(plan.quote.premiumAmount, 6, 'quoted premium', true);
    const cashPerUsd = quotedCash.div(width.times(quotedShares)).toFixed();
    const multiplier = decimal(journal.plan.multiplier, 'share multiplier');
    const input: IncomeProjectionInput = {
      quantity: journal.plan.quantity,
      multiplier: journal.plan.multiplier,
      tokenPrice: tokenPrice.toFixed(),
      spot: tokenPrice.div(multiplier).div(cashPerUsd).toFixed(),
      shortStrike: String(plan.spread.short.strikePrice),
      longStrike: String(plan.spread.long.strikePrice),
      premiumPerShare: plan.spread.premium,
      borrowApr: basis.borrowApr,
      durationSeconds: String(duration),
      loan: units(journal.plan.quote.amount, 6, 'original loan'),
      fee: units(plan.quote.fee, 6, 'opening fee', true),
      shares,
      premium,
      cashPerUsd,
    };
    return {input, result: calculateIncome(input)};
  } catch {
    return null;
  }
}
