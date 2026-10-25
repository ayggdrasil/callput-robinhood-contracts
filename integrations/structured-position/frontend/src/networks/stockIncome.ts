import {getAddress, type Address, type Hex} from 'viem';
import deployment from '../_shared/latestAddress.robinhood.json';
import {UA_TICKER_TO_INDEX} from '../_shared/constants/asset-mapping';

// The shared runtime lists stocks; its legacy mapped type still lists BTC/ETH only.
const indices = UA_TICKER_TO_INDEX.Robinhood as Record<string, number>;

/** Verified against Morpho's official API and chain 4663, 2026-10-22.
 * Collateral tokens are Robinhood stock tokens, not CallPut's synthetic identifiers.
 * https://app.morpho.org/robinhood-chain/variable and https://docs.robinhood.com/chain/contracts/ */
export const STOCK_INCOME_CHAIN_ID = 4663;
export const MORPHO = getAddress('0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010');
export const USDG = getAddress(deployment.USDC);
export const STOCK_INCOME_ROUTE = '/structure';
export const stockIncomeEnabled = (chain: string) => chain === 'Robinhood';
export interface MarketParams {loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint}
export interface StockIncomeMarket {
  symbol: 'NVDA' | 'TSLA' | 'AAPL'; name: string; id: Hex; decimals: 18;
  underlying: Address; index: number; params: MarketParams;
}
const params = (collateral: string, oracle: string): MarketParams => ({loanToken: USDG,
  collateralToken: getAddress(collateral.toLowerCase()), oracle: getAddress(oracle.toLowerCase()),
  irm: getAddress('0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1'), lltv: 625000000000000000n});
export const STOCK_INCOME_MARKETS: readonly StockIncomeMarket[] = [
  {symbol: 'NVDA', name: 'NVIDIA', decimals: 18, underlying: getAddress(deployment.NVDA), index: indices.NVDA,
    id: '0xf5ff7d546af5e72f3912d2aa723088fd0bf66fddc158714995637714d9db6e4c',
    params: params('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', '0x37CF511fA79B8446f1C23D6a81Df117F28240bE0')},
  {symbol: 'TSLA', name: 'Tesla', decimals: 18, underlying: getAddress(deployment.TSLA), index: indices.TSLA,
    id: '0x22e4598e5cc16cff0056e72d61c5f1f2f8bf5bbffc22da5277ab196939c8a59e',
    params: params('0x322F0929c4625eD5bAd873c95208D54E1c003b2d', '0xe343124476849d6F161E380d682b9603e97903d3')},
  {symbol: 'AAPL', name: 'Apple', decimals: 18, underlying: getAddress(deployment.AAPL), index: indices.AAPL,
    id: '0xcaa167af7ba0422c76424fae56167b7db25bf19f4f435215e6dd7d06a943bdac',
    params: params('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', '0xA39F2c101bCc19aD5d0C7b83281F94a5ADe2a344')},
];
export const morphoMarketUrl = (market: StockIncomeMarket) =>
  `https://app.morpho.org/robinhood-chain/variable/${market.id}/usdg-${market.symbol.toLowerCase()}`;
