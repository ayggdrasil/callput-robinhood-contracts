import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData, decodeFunctionResult, encodeFunctionResult, erc20Abi} from 'viem';
import {MORPHO, STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import {MORPHO_ABI, marketId, accruedMarket, borrowAssets, projectLoan, lendingTransactions,
  validateBlockTimestamp, validateContractCode, validateMarket} from './morpho';

const owner = '0x1111111111111111111111111111111111111111' as const;
const account = '0x2222222222222222222222222222222222222222' as const;
const market = STOCK_INCOME_MARKETS[0];
const state = {totalSupplyAssets: 1000000000n, totalSupplyShares: 1000000000000000n,
  totalBorrowAssets: 100000000n, totalBorrowShares: 100000000000000n, lastUpdate: 1000n, fee: 0n};
test('pinned market params hash to the official Robinhood NVDA market', () => {
  assert.equal(marketId(market.params), market.id);
  assert.equal(market.params.loanToken.toLowerCase(), USDG.toLowerCase());
  assert.notEqual(market.params.collateralToken.toLowerCase(), market.underlying.toLowerCase());
});
test('viem decodes Morpho named tuple results into the reader object shape', () => {
  const paramsResult = encodeFunctionResult({abi: MORPHO_ABI, functionName: 'idToMarketParams', result: market.params});
  assert.deepEqual(decodeFunctionResult({abi: MORPHO_ABI, functionName: 'idToMarketParams', data: paramsResult}), market.params);
  const marketResult = encodeFunctionResult({abi: MORPHO_ABI, functionName: 'market', result: state});
  assert.deepEqual(decodeFunctionResult({abi: MORPHO_ABI, functionName: 'market', data: marketResult}), state);
  const position = {supplyShares: 7n, borrowShares: 11n, collateral: 13n};
  const positionResult = encodeFunctionResult({abi: MORPHO_ABI, functionName: 'position', result: position});
  assert.deepEqual(decodeFunctionResult({abi: MORPHO_ABI, functionName: 'position', data: positionResult}), position);
});
test('refuses wrong chain, changed market params and wrong token decimals', () => {
  const input = {chainId: 4663, configured: market, actual: market.params, collateralDecimals: 18, loanDecimals: 6, oraclePrice: 200000000000000000000000000n};
  assert.doesNotThrow(() => validateMarket(input));
  assert.throws(() => validateMarket({...input, chainId: 8453}), /Robinhood/);
  assert.throws(() => validateMarket({...input, actual: {...market.params, loanToken: owner}}), /market/i);
  assert.throws(() => validateMarket({...input, loanDecimals: 18}), /decimals/);
  assert.throws(() => validateMarket({...input, oraclePrice: 0n}), /oracle/i);
});
test('rejects stale or implausibly future blocks and missing deployment code', () => {
  assert.doesNotThrow(() => validateBlockTimestamp(1000n, 1000000));
  assert.throws(() => validateBlockTimestamp(699n, 1000000), /stale block/i);
  assert.throws(() => validateBlockTimestamp(1061n, 1000000), /future block/i);
  assert.doesNotThrow(() => validateContractCode('Morpho', '0x00'));
  assert.throws(() => validateContractCode('Morpho', '0x'), /not deployed/i);
  assert.throws(() => validateContractCode('Morpho', undefined), /not deployed/i);
});
test('accrues borrowing before valuing existing debt and rounds debt up', () => {
  const accrued = accruedMarket(state, 1000000000n, 2000n);
  assert.ok(accrued.totalBorrowAssets > state.totalBorrowAssets);
  assert.ok(borrowAssets(500000000000n, accrued) > borrowAssets(500000000000n, state));
  assert.equal(borrowAssets(1n, state), 1n);
});
test('accrual mints protocol fee shares with virtual-share rounding down', () => {
  const feeState = {totalSupplyAssets: 1000000n, totalSupplyShares: 2000003n,
    totalBorrowAssets: 500000n, totalBorrowShares: 600000n, lastUpdate: 1000n, fee: 100000000000000000n};
  const accrued = accruedMarket(feeState, 1000000000000n, 2000n);
  assert.equal(accrued.totalBorrowAssets, 500500n);
  assert.equal(accrued.totalSupplyAssets, 1000500n);
  assert.equal(accrued.totalSupplyShares, 2000152n); // 149 fee shares, rounded down.
  assert.equal(accrued.lastUpdate, 2000n);
});
test('18 decimal shares and six decimal loan use oracle scale 1e36', () => {
  const loan = projectLoan({collateral: 10n ** 19n, debt: 100000000n, addCollateral: 0n,
    borrow: 400000000n, oraclePrice: 200000000000000000000000000n, lltv: market.params.lltv, liquidity: 900000000n});
  assert.equal(loan.collateralValue, 2000000000n);
  assert.equal(loan.debt, 500000000n);
  assert.equal(loan.healthWad, 2500000000000000000n);
  assert.throws(() => projectLoan({collateral: 10n ** 19n, debt: 900000000n, addCollateral: 0n,
    borrow: 400000000n, oraclePrice: 200000000000000000000000000n, lltv: market.params.lltv, liquidity: 900000000n}), /health/i);
  assert.throws(() => projectLoan({collateral: 10n ** 19n, debt: 0n, addCollateral: 0n,
    borrow: 400000000n, oraclePrice: 200000000000000000000000000n, lltv: market.params.lltv, liquidity: 10n}), /liquidity/i);
});
test('lending calldata pins owner for debt and CallPut account for receipt of USDG', () => {
  const tx = lendingTransactions(market, owner, 10n ** 18n, 10000000n, account);
  assert.equal(tx.approve.to.toLowerCase(), market.params.collateralToken.toLowerCase());
  assert.deepEqual(decodeFunctionData({abi: erc20Abi, data: tx.approve.data}).args, [MORPHO, 10n ** 18n]);
  const borrow = decodeFunctionData({abi: MORPHO_ABI, data: tx.borrow.data});
  assert.equal(borrow.functionName, 'borrow');
  assert.deepEqual(borrow.args?.slice(1), [10000000n, 0n, owner, account]);
  assert.equal(decodeFunctionData({abi: MORPHO_ABI, data: tx.supply.data}).functionName, 'supplyCollateral');
  assert.throws(() => lendingTransactions(market, owner, 0n, 1n, account), /positive/i);
});
