import type {OptionsMarketItem} from '../_shared/types/mark-iv-price';
import type {IOptionDetail} from '../interfaces/interfaces.marketSlice';
import {BN} from '../utils/bn';

export const STRUCTURE_MARKET_MAX_AGE_SECONDS = 150;

export const SPREAD_STYLES = [
  {id: 'itm', label: 'In the money', targetPercent: 95, selection: 'nearest'},
  {id: 'atm', label: 'At the money', targetPercent: 100, selection: 'nearest'},
  {id: 'near', label: 'Near the money', targetPercent: 102, selection: 'at-or-above'},
  {id: 'balanced', label: 'Balanced', targetPercent: 105, selection: 'at-or-above'},
  {id: 'conservative', label: 'Conservative', targetPercent: 110, selection: 'at-or-above'},
] as const;
export type SpreadStyle = typeof SPREAD_STYLES[number]['id'];
export const isSpreadStyle = (value: unknown): value is SpreadStyle =>
  typeof value === 'string' && SPREAD_STYLES.some(style => style.id === value);

export interface Spread {
  symbol: string;
  expiry: number;
  short: IOptionDetail;
  long: IOptionDetail;
  width: string;
  premium: string;
  sourceAt: number;
}

function finiteDecimal(value: string | number, label: string, allowZero = false) {
  const parsed = new BN(String(value));
  if (!parsed.isFinite() || (allowZero ? parsed.lt(0) : !parsed.gt(0))) {
    throw new Error(`Invalid ${label}.`);
  }
  return parsed;
}

export function assertFreshSource(sourceAt: number, now: number) {
  if (!Number.isSafeInteger(sourceAt) || sourceAt <= 0 || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Invalid market source time.');
  }
  if (sourceAt > now) throw new Error('Market source time is in the future.');
  if (now - sourceAt > STRUCTURE_MARKET_MAX_AGE_SECONDS) {
    throw new Error('Option market data is stale. Refresh and retry.');
  }
}

function validAvailableCall(option: IOptionDetail) {
  if (!option.isOptionAvailable) return false;
  const strike = finiteDecimal(option.strikePrice, 'option strike');
  finiteDecimal(option.markPrice, 'option mark', true);
  if (!/^0x[0-9a-fA-F]{64}$/.test(option.optionId) || !strike.isFinite()) {
    throw new Error('Invalid option listing.');
  }
  return true;
}

export function selectSpread(input: {
  symbol: string;
  market: OptionsMarketItem;
  price: string;
  expiry: number;
  style: SpreadStyle;
  sourceAt: number;
  now?: number;
}): Spread {
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  assertFreshSource(input.sourceAt, now);
  if (!Number.isSafeInteger(input.expiry) || input.expiry <= now) {
    throw new Error('The selected expiry has expired.');
  }
  if (!input.market.expiries.includes(input.expiry)) {
    throw new Error('The selected expiry is unavailable.');
  }
  const price = finiteDecimal(input.price, 'spot price');
  const calls = input.market.options[String(input.expiry)]?.call;
  if (!Array.isArray(calls)) throw new Error('The selected expiry is unavailable.');
  const available = calls.filter(validAvailableCall).sort((a, b) =>
    new BN(String(a.strikePrice)).comparedTo(String(b.strikePrice)) ?? 0);
  const style = SPREAD_STYLES.find(candidate => candidate.id === input.style);
  if (!style) throw new Error('Invalid spread style.');
  const threshold = price.times(style.targetPercent).div(100);
  const long = available[available.length - 1];
  const longStrike = long && new BN(String(long.strikePrice));
  const protectedCandidates = longStrike
    ? available.filter(option => new BN(String(option.strikePrice)).lt(longStrike))
    : [];
  const candidates = input.style === 'itm'
    ? protectedCandidates.filter(option => new BN(String(option.strikePrice)).lt(price))
    : protectedCandidates;
  const short = style.selection === 'nearest'
    ? candidates.reduce<IOptionDetail | undefined>((best, option) => {
      if (!best) return option;
      const strike = new BN(String(option.strikePrice));
      const bestStrike = new BN(String(best.strikePrice));
      const distance = strike.minus(threshold).abs();
      const bestDistance = bestStrike.minus(threshold).abs();
      return distance.lt(bestDistance) || distance.eq(bestDistance) && strike.gt(bestStrike) ? option : best;
    }, undefined)
    : candidates.find(option => new BN(String(option.strikePrice)).gte(threshold));
  if (!short) {
    throw new Error('Two available calls are required for this spread.');
  }
  const width = new BN(String(long.strikePrice)).minus(String(short.strikePrice));
  const premium = new BN(String(short.markPrice)).minus(String(long.markPrice));
  if (!width.gt(0)) throw new Error('The protective call must have a higher strike.');
  if (!premium.gt(0) || premium.gte(width)) throw new Error('A valid positive spread premium is unavailable.');
  return {symbol: input.symbol, expiry: input.expiry, short, long,
    width: width.toFixed(), premium: premium.toFixed(), sourceAt: input.sourceAt};
}
