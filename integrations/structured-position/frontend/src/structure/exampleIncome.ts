import {BN} from '../utils/bn';
import {calculateIncome, type IncomeProjectionInput} from './incomeProjection';

export const EXAMPLE_ASSETS = {
  NVDA: {name:'NVIDIA', price:'180'}, TSLA: {name:'Tesla', price:'420'}, AAPL: {name:'Apple', price:'240'},
} as const;
export type ExampleStockSymbol = keyof typeof EXAMPLE_ASSETS;

/** Shared illustrative terms for the simulator and the unavailable-data chart. Never executable. */
export function exampleIncome(symbol: ExampleStockSymbol, quantity: string, days: number, style: 'balanced' | 'conservative') {
  const asset = EXAMPLE_ASSETS[symbol], price = new BN(asset.price);
  const short = price.times(style === 'balanced' ? '1.05' : '1.10').div(5).integerValue(BN.ROUND_CEIL).times(5);
  const long = short.plus(price.times('.08').div(5).integerValue(BN.ROUND_CEIL).times(5));
  const premium = long.minus(short).times(style === 'balanced' ? '.16' : '.10').times(new BN(days).div(30).sqrt());
  const input: IncomeProjectionInput = {quantity, multiplier:'1', tokenPrice:asset.price, spot:asset.price,
    shortStrike:short.toFixed(), longStrike:long.toFixed(), premiumPerShare:premium.toFixed(),
    borrowApr:'0.065', durationSeconds:String(days * 86400), fee:new BN(quantity || 0).times('.12').toFixed(), gas:'0.85', lltv:'0.625'};
  return {input, result:calculateIncome(input), short, long};
}
