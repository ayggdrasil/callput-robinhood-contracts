import {encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseAbi, parseAbiParameters,
  type Abi, type Address, type Hex, type PublicClient} from 'viem';
import {MORPHO, STOCK_INCOME_CHAIN_ID, type MarketParams, type StockIncomeMarket} from '../networks/stockIncome';

const tuple = '(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)';
export const MORPHO_ABI = parseAbi([
  `function idToMarketParams(bytes32) view returns (${tuple})`,
  'function market(bytes32) view returns ((uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee))',
  'function position(bytes32,address) view returns ((uint256 supplyShares,uint128 borrowShares,uint128 collateral))',
  `function supplyCollateral(${tuple},uint256 assets,address onBehalf,bytes data)`,
  `function borrow(${tuple},uint256 assets,uint256 shares,address onBehalf,address receiver) returns (uint256,uint256)`,
  `function repay(${tuple},uint256 assets,uint256 shares,address onBehalf,bytes data) returns (uint256,uint256)`,
  `function withdrawCollateral(${tuple},uint256 assets,address onBehalf,address receiver)`,
]);
const ORACLE_ABI = parseAbi(['function price() view returns (uint256)']);
export const STOCK_ABI = parseAbi(['function uiMultiplier() view returns (uint256)']);
const IRM_ABI = parseAbi([`function borrowRateView(${tuple},(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)) view returns (uint256)`]);
const WAD = 10n ** 18n, ORACLE_SCALE = 10n ** 36n;
export const MIN_HEALTH = 1250000000000000000n;
export const MAX_BLOCK_AGE_SECONDS = 300n;
const MAX_FUTURE_BLOCK_SECONDS = 60n;
export interface MorphoMarketState {totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint}
export interface MorphoPosition {supplyShares: bigint; borrowShares: bigint; collateral: bigint}
export type LendingReader = Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBytecode' | 'readContract'>;
export interface MorphoSnapshot {
  market: StockIncomeMarket; block: bigint; checkedAt: number; oraclePrice: bigint; borrowRate: bigint;
  state: MorphoMarketState; position: MorphoPosition; debt: bigint; liquidity: bigint; balance: bigint; usdgBalance: bigint; multiplier: bigint;
}
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export function validateBlockTimestamp(timestamp: bigint, nowMs = Date.now()) {
  const now = BigInt(Math.floor(nowMs / 1000));
  if (timestamp <= 0n || timestamp + MAX_BLOCK_AGE_SECONDS < now) throw new Error('Robinhood RPC returned a stale block.');
  if (timestamp > now + MAX_FUTURE_BLOCK_SECONDS) throw new Error('Robinhood RPC returned a future block.');
}
export function validateContractCode(label: string, code: Hex | undefined) {
  if (!code || code === '0x') throw new Error(`${label} contract is not deployed on Robinhood Chain.`);
}
export function marketId(p: MarketParams): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('address,address,address,address,uint256'), [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));
}
export function validateMarket(input: {chainId: number; configured: StockIncomeMarket; actual: MarketParams; collateralDecimals: number; loanDecimals: number; oraclePrice: bigint}) {
  if (input.chainId !== STOCK_INCOME_CHAIN_ID) throw new Error('Select Robinhood Chain.');
  if (marketId(input.actual) !== input.configured.id || marketId(input.configured.params) !== input.configured.id) throw new Error('Morpho market configuration changed.');
  if (input.collateralDecimals !== input.configured.decimals || input.loanDecimals !== 6) throw new Error('Unexpected token decimals.');
  if (input.oraclePrice <= 0n) throw new Error('Morpho oracle price is unavailable.');
}
/** Morpho MathLib.wTaylorCompounded, including per-term rounding. */
export function accruedMarket(m: MorphoMarketState, rate: bigint, timestamp: bigint): MorphoMarketState {
  if (timestamp < m.lastUpdate || rate < 0n) throw new Error('Invalid Morpho interest observation.');
  const first = rate * (timestamp - m.lastUpdate), second = first * first / (2n * WAD), third = second * first / (3n * WAD);
  const interest = m.totalBorrowAssets * (first + second + third) / WAD;
  const totalSupplyAssets = m.totalSupplyAssets + interest;
  const feeAmount = interest * m.fee / WAD;
  const feeShares = feeAmount * (m.totalSupplyShares + 1000000n) / (totalSupplyAssets - feeAmount + 1n);
  return {...m, totalBorrowAssets: m.totalBorrowAssets + interest, totalSupplyAssets,
    totalSupplyShares: m.totalSupplyShares + feeShares, lastUpdate: timestamp};
}
/** Virtual assets=1, virtual shares=1e6; round borrower liability upward. */
export const borrowAssets = (shares: bigint, market: MorphoMarketState) =>
  ceilDiv(shares * (market.totalBorrowAssets + 1n), market.totalBorrowShares + 1000000n);
export function projectLoan(input: {collateral: bigint; debt: bigint; addCollateral: bigint; borrow: bigint; oraclePrice: bigint; lltv: bigint; liquidity: bigint}) {
  if ([input.collateral, input.debt, input.addCollateral, input.borrow].some(n => n < 0n) || input.oraclePrice <= 0n || input.lltv <= 0n || input.lltv >= WAD) throw new Error('Invalid loan inputs.');
  if (input.borrow > input.liquidity) throw new Error('Insufficient USDG market liquidity.');
  const collateralValue = (input.collateral + input.addCollateral) * input.oraclePrice / ORACLE_SCALE;
  const maxDebt = collateralValue * input.lltv / WAD, debt = input.debt + input.borrow;
  const healthWad = debt ? maxDebt * WAD / debt : null;
  if (healthWad !== null && healthWad < MIN_HEALTH) throw new Error('Projected loan health is below 1.25. Reduce the strategy size.');
  return {collateralValue, debt, maxDebt, healthWad, ltvWad: collateralValue ? debt * WAD / collateralValue : 0n};
}
export interface LendingTransaction {to: Address; data: Hex; value: bigint}
export function lendingTransactions(market: StockIncomeMarket, owner: Address, collateral: bigint, loan: bigint, account: Address) {
  if (collateral <= 0n || loan <= 0n) throw new Error('Collateral and borrowing must be positive.');
  return {
    approve: {to: market.params.collateralToken, data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [MORPHO, collateral]}), value: 0n},
    supply: {to: MORPHO, data: encodeFunctionData({abi: MORPHO_ABI, functionName: 'supplyCollateral', args: [market.params, collateral, owner, '0x']}), value: 0n},
    borrow: {to: MORPHO, data: encodeFunctionData({abi: MORPHO_ABI, functionName: 'borrow', args: [market.params, loan, 0n, owner, account]}), value: 0n},
  } satisfies Record<string, LendingTransaction>;
}
/** One block for parameters, position, oracle, balances and interest. No API-derived execution amounts. */
export async function readMorpho(client: LendingReader, market: StockIncomeMarket, owner: Address): Promise<MorphoSnapshot> {
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  if (chainId !== STOCK_INCOME_CHAIN_ID) throw new Error('Select Robinhood Chain.');
  validateBlockTimestamp(block.timestamp);
  const contracts = [
    {label: 'Morpho', address: MORPHO},
    {label: 'collateral token', address: market.params.collateralToken},
    {label: 'loan token', address: market.params.loanToken},
    {label: 'oracle', address: market.params.oracle},
    {label: 'IRM', address: market.params.irm},
  ].filter((entry, index, all) => all.findIndex(other => other.address.toLowerCase() === entry.address.toLowerCase()) === index);
  const codes = await Promise.all(contracts.map(({address}) => client.getBytecode({address, blockNumber: block.number})));
  contracts.forEach(({label}, index) => validateContractCode(label, codes[index]));
  const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    client.readContract({address, abi, functionName, args, blockNumber: block.number} as never) as Promise<unknown>;
  const [actual, state, position, price, collateralDecimals, loanDecimals, balance, usdgBalance, multiplier] = await Promise.all([
    read(MORPHO, MORPHO_ABI, 'idToMarketParams', [market.id]), read(MORPHO, MORPHO_ABI, 'market', [market.id]),
    read(MORPHO, MORPHO_ABI, 'position', [market.id, owner]), read(market.params.oracle, ORACLE_ABI, 'price'),
    read(market.params.collateralToken, erc20Abi, 'decimals'), read(market.params.loanToken, erc20Abi, 'decimals'),
    read(market.params.collateralToken, erc20Abi, 'balanceOf', [owner]), read(market.params.loanToken, erc20Abi, 'balanceOf', [owner]),
    read(market.params.collateralToken, STOCK_ABI, 'uiMultiplier'),
  ]) as [MarketParams, MorphoMarketState, MorphoPosition, bigint, number, number, bigint, bigint, bigint];
  validateMarket({chainId, configured: market, actual, collateralDecimals, loanDecimals, oraclePrice: price});
  if (!state.lastUpdate) throw new Error('Morpho market is not initialized.');
  if (multiplier <= 0n) throw new Error('Stock share multiplier is unavailable.');
  const rate = await read(market.params.irm, IRM_ABI, 'borrowRateView', [actual, state]) as bigint;
  const accrued = accruedMarket(state, rate, block.timestamp);
  return {market, block: block.number, checkedAt: Date.now(), oraclePrice: price, borrowRate: rate, state: accrued,
    position, debt: borrowAssets(position.borrowShares, accrued), liquidity: accrued.totalSupplyAssets - accrued.totalBorrowAssets, balance, usdgBalance, multiplier};
}
