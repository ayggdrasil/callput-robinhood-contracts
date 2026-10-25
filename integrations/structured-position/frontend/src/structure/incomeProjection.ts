import {BN} from '../utils/bn';

/** Display-only terms, in human units. USDG amounts are never transaction inputs. */
export interface IncomeProjectionInput {
  quantity: string; multiplier: string; tokenPrice: string; spot: string;
  shortStrike: string; longStrike: string; premiumPerShare: string;
  borrowApr: string; durationSeconds: string;
  loan?: string; fee?: string; gas?: string; shares?: string; premium?: string; cashPerUsd?: string;
  existingCollateralValue?: string; existingDebt?: string; lltv?: string;
}

function decimal(value: string, label: string, zero = false) {
  const n = new BN(value);
  if (!value.trim() || !n.isFinite() || (zero ? n.lt(0) : !n.gt(0))) throw new Error(`Invalid ${label}.`);
  return n;
}

/** Estimate the overlay separately from the stock and from pre-existing debt. */
export function calculateIncome(input: IncomeProjectionInput) {
  const quantity = decimal(input.quantity,'stock quantity');
  const multiplier = decimal(input.multiplier,'share multiplier');
  const tokenPrice = decimal(input.tokenPrice,'token price');
  decimal(input.spot,'stock price');
  const short = decimal(input.shortStrike,'sell strike'), long = decimal(input.longStrike,'buy strike');
  const width = long.minus(short), perShare = decimal(input.premiumPerShare,'spread premium',true);
  if (!width.gt(0) || perShare.gte(width)) throw new Error('Invalid call spread.');
  const duration = decimal(input.durationSeconds,'time to expiry');
  const borrowApr = decimal(input.borrowApr,'borrow APR',true);
  const fee = decimal(input.fee ?? '0','opening fee',true);
  const gas = decimal(input.gas ?? '0','wallet gas cost',true);
  const cashPerUsd = decimal(input.cashPerUsd ?? '1','USDG conversion');
  const stockShares = quantity.times(multiplier);
  const shares = input.shares === undefined ? stockShares : decimal(input.shares,'option shares');
  const spreadCollateral = width.times(shares).times(cashPerUsd);
  const grossPremium = input.premium === undefined ? perShare.times(shares).times(cashPerUsd) : decimal(input.premium,'quoted premium',true);
  if (grossPremium.gte(spreadCollateral)) throw new Error('Spread premium exceeds its payoff width.');
  const loan = input.loan === undefined ? spreadCollateral.plus(fee) : decimal(input.loan,'loan amount');
  const stockValue = quantity.times(tokenPrice);
  const periodRate = borrowApr.times(duration).div(31536000);
  const interest = loan.times(periodRate);
  const netIncome = grossPremium.minus(fee).minus(interest).minus(gas);
  const overlayBreakeven = netIncome.gt(0)
    ? short.plus(netIncome.div(shares.times(cashPerUsd))) : null;
  const maxOverlayLoss = BN.maximum(0,spreadCollateral.minus(netIncome));
  const roi = netIncome.div(stockValue), apr = roi.times(31536000).div(duration);
  const debtDue = loan.plus(interest);
  const existingDebt = decimal(input.existingDebt ?? '0','existing debt',true);
  const existingCollateral = decimal(input.existingCollateralValue ?? '0','existing collateral',true);
  const lltv = decimal(input.lltv ?? '0.625','liquidation LTV');
  if (lltv.gte(1)) throw new Error('Invalid liquidation LTV.');
  const totalCollateralValue = existingCollateral.plus(stockValue);
  const totalDebtDue = existingDebt.times(periodRate.plus(1)).plus(debtDue);
  const healthFactor = totalCollateralValue.times(lltv).div(totalDebtDue);
  const liquidationTokenPrice = tokenPrice.times(totalDebtDue).div(totalCollateralValue.times(lltv));
  return {shares,stockShares,width,stockValue,grossPremium,loan,fee,gas,interest,netIncome,maxOverlayLoss,roi,apr,
    healthFactor,liquidationTokenPrice,debtDue,totalDebtDue,spreadCollateral,overlayBreakeven};
}

/** Expiry scenario, excluding liquidation and any unmodeled closing/network costs. */
export function incomePayoff(input: IncomeProjectionInput, expiryPrice: string) {
  const price = decimal(expiryPrice,'expiry stock price',true), calc = calculateIncome(input);
  const cashPerUsd = decimal(input.cashPerUsd ?? '1','USDG conversion');
  const payout = BN.minimum(BN.maximum(price.minus(input.shortStrike),0),calc.width).times(calc.shares).times(cashPerUsd);
  const overlayPnl = calc.netIncome.minus(payout);
  const stockPnl = calc.stockShares.times(price.minus(input.spot)).times(cashPerUsd);
  return {overlayPnl,stockPnl,totalPnl:overlayPnl.plus(stockPnl)};
}

/** Entry-to-expiry modeled risk. These losses are not historical peak-to-trough drawdowns. */
export function incomeRisk(input: IncomeProjectionInput) {
  const calc = calculateIncome(input);
  const candidatePrices = [new BN(0), new BN(input.shortStrike), new BN(input.longStrike)];
  const worst = candidatePrices
    .map(price => ({price, totalPnl: incomePayoff(input, price.toFixed()).totalPnl}))
    .reduce((current, candidate) => candidate.totalPnl.lt(current.totalPnl) ? candidate : current);
  const maxCombinedLoss = BN.maximum(0, worst.totalPnl.negated());
  return {
    maxPremiumApr: calc.apr,
    maxOverlayLoss: calc.maxOverlayLoss,
    overlayLossOnStock: calc.maxOverlayLoss.div(calc.stockValue),
    maxCombinedLoss,
    combinedLossOnStock: maxCombinedLoss.div(calc.stockValue),
    worstCombinedPrice: worst.price,
  };
}
