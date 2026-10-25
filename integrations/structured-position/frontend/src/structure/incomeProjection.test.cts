import assert from 'node:assert/strict';
import {test} from 'node:test';
import {calculateIncome, incomePayoff, incomeRisk} from './incomeProjection';

const input = {quantity:'10', multiplier:'0.5', tokenPrice:'50', spot:'100', shortStrike:'105', longStrike:'120',
  premiumPerShare:'3', borrowApr:'0.1', durationSeconds:'3153600', fee:'1', lltv:'0.625'};

test('uses actual share conversion, fee-inclusive loan, interest and stock-value returns', () => {
  const v = calculateIncome(input);
  assert.equal(v.shares.toFixed(),'5');
  assert.equal(v.stockValue.toFixed(),'500');
  assert.equal(v.loan.toFixed(),'76');
  assert.equal(v.grossPremium.toFixed(),'15');
  assert.equal(v.interest.toFixed(),'0.76');
  assert.equal(v.netIncome.toFixed(),'13.24');
  assert.equal(v.roi.toFixed(),'0.02648');
  assert.equal(v.apr.toFixed(),'0.2648');
  assert.equal(v.maxOverlayLoss.toFixed(),'61.76');
  assert.equal(v.debtDue.toFixed(),'76.76');
});

test('execution quote overrides public mark amounts without assuming USDG parity', () => {
  const v = calculateIncome({...input,loan:'81',fee:'1',shares:'5.01',premium:'17',cashPerUsd:'1.01'});
  assert.equal(v.loan.toFixed(),'81');
  assert.equal(v.grossPremium.toFixed(),'17');
  assert.equal(v.shares.toFixed(),'5.01');
  assert.equal(v.stockShares.toFixed(),'5');
  assert.equal(v.netIncome.toFixed(),'15.19');
  assert.equal(v.maxOverlayLoss.toFixed(),'60.7115');
});
test('wallet gas reduces income without increasing the USDG loan or its interest', () => {
  const v = calculateIncome({...input,gas:'0.85'});
  assert.equal(v.loan.toFixed(),'76');
  assert.equal(v.interest.toFixed(),'0.76');
  assert.equal(v.netIncome.toFixed(),'12.39');
  assert.equal(v.maxOverlayLoss.toFixed(),'62.61');
});

test('existing Morpho loan changes health and liquidation level, not new strategy ROI', () => {
  const base = calculateIncome(input);
  const total = calculateIncome({...input,existingCollateralValue:'200',existingDebt:'100'});
  assert.equal(total.totalDebtDue.toFixed(),'177.76');
  assert.equal(total.netIncome.toFixed(),base.netIncome.toFixed());
  assert.equal(total.liquidationTokenPrice.toFixed(6),'20.315429');
  assert.equal(total.healthFactor.toFixed(6),'2.461184');
});

test('payoff caps spread loss and keeps actual stock exposure independent from option fill size', () => {
  assert.equal(incomePayoff(input,'100').overlayPnl.toFixed(),'13.24');
  assert.equal(incomePayoff(input,'110').overlayPnl.toFixed(),'-11.76');
  assert.equal(incomePayoff(input,'200').overlayPnl.toFixed(),'-61.76');
  assert.equal(incomePayoff(input,'70').stockPnl.toFixed(),'-150');
  assert.equal(incomePayoff({...input,shares:'5.01',cashPerUsd:'1.01'},'110').stockPnl.toFixed(),'50.5');
});

test('overlay breakeven includes fees, interest and the quoted USDG conversion', () => {
  const base = calculateIncome(input);
  assert.equal(base.overlayBreakeven?.toFixed(), '107.648');
  assert.equal(incomePayoff(input, base.overlayBreakeven!.toFixed()).overlayPnl.toFixed(), '0');
  const quoted = {...input, shares:'4', cashPerUsd:'1.25', premium:'15', loan:'76'};
  assert.equal(calculateIncome(quoted).overlayBreakeven?.toFixed(), '107.648');
});

test('no unique overlay breakeven is reported for an all-loss or zero-income plateau', () => {
  assert.equal(calculateIncome({...input, fee:'20'}).overlayBreakeven, null);
  assert.equal(calculateIncome({...input, fee:'15', borrowApr:'0'}).overlayBreakeven, null);
});

test('tiny decimal quantities retain precision and negative net returns stay visible', () => {
  const v = calculateIncome({...input,quantity:'0.00000001',fee:'0',borrowApr:'0'});
  assert.equal(v.grossPremium.toFixed(),'0.000000015');
  assert.equal(v.loan.toFixed(),'0.000000075');
  assert.ok(calculateIncome({...input,fee:'20'}).netIncome.isNegative());
});

test('reports net premium APR and the stock-zero combined loss without capping upside', () => {
  const risk = incomeRisk(input);
  assert.equal(risk.maxPremiumApr.toFixed(), '0.2648');
  assert.equal(risk.maxOverlayLoss.toFixed(), '61.76');
  assert.equal(risk.overlayLossOnStock.toFixed(), '0.12352');
  assert.equal(risk.maxCombinedLoss.toFixed(), '486.76');
  assert.equal(risk.combinedLossOnStock.toFixed(), '0.97352');
  assert.equal(risk.worstCombinedPrice.toFixed(), '0');
  assert.ok(incomePayoff(input, '1000').totalPnl.gt(incomePayoff(input, '200').totalPnl));
  assert.equal(Object.hasOwn(risk, 'maxCombinedApr'), false);
});

test('keeps a negative net premium APR and includes it in modeled losses', () => {
  const risk = incomeRisk({...input, fee:'20'});
  assert.equal(risk.maxPremiumApr.toFixed(), '-0.119');
  assert.equal(risk.maxOverlayLoss.toFixed(), '80.95');
  assert.equal(risk.overlayLossOnStock.toFixed(), '0.1619');
  assert.equal(risk.maxCombinedLoss.toFixed(), '505.95');
  assert.equal(risk.combinedLossOnStock.toFixed(), '1.0119');
  assert.equal(risk.worstCombinedPrice.toFixed(), '0');
});

test('applies quoted cash conversion to payoff losses but keeps the stock-value denominator', () => {
  const risk = incomeRisk({...input, cashPerUsd:'1.25'});
  assert.equal(risk.maxPremiumApr.toFixed(), '0.33605');
  assert.equal(risk.maxOverlayLoss.toFixed(), '76.9475');
  assert.equal(risk.overlayLossOnStock.toFixed(), '0.153895');
  assert.equal(risk.maxCombinedLoss.toFixed(), '608.1975');
  assert.equal(risk.combinedLossOnStock.toFixed(), '1.216395');
});

test('finds the long-strike minimum when option exposure exceeds stock exposure', () => {
  const risk = incomeRisk({...input, shares:'50'});
  assert.equal(risk.maxCombinedLoss.toFixed(), '508.51');
  assert.equal(risk.combinedLossOnStock.toFixed(), '1.01702');
  assert.equal(risk.worstCombinedPrice.toFixed(), '120');
});

test('retains BN precision for tiny risk amounts and ratios', () => {
  const risk = incomeRisk({...input, quantity:'0.00000001', fee:'0', borrowApr:'0'});
  assert.equal(risk.maxPremiumApr.toFixed(), '0.3');
  assert.equal(risk.maxOverlayLoss.toFixed(), '0.00000006');
  assert.equal(risk.overlayLossOnStock.toFixed(), '0.12');
  assert.equal(risk.maxCombinedLoss.toFixed(), '0.000000485');
  assert.equal(risk.combinedLossOnStock.toFixed(), '0.97');
  assert.equal(risk.worstCombinedPrice.toFixed(), '0');
});

test('rejects expired durations, nonfinite or invalid economic inputs', () => {
  for (const values of [{durationSeconds:'0'},{quantity:'NaN'},{multiplier:'0'},{longStrike:'104'},{premiumPerShare:'16'},
    {borrowApr:'-1'},{fee:'-1'},{lltv:'1'},{cashPerUsd:'0'},{loan:'0'},{existingDebt:'-1'}]) {
    assert.throws(() => calculateIncome({...input,...values}));
  }
  assert.throws(() => incomePayoff(input,'-1'));
});
