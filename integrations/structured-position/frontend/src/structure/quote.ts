import type {Abi, Address, PublicClient} from 'viem';
import {zeroHash} from 'viem';
import ControllerAbi from '../_shared/abis/Controller.json';
import PositionManagerAbi from '../_shared/abis/PositionManager.json';
import VaultAbi from '../_shared/abis/Vault.json';
import VaultUtilsAbi from '../_shared/abis/VaultUtils.json';
import {CONTRACT_ADDRESSES, SupportedChains} from '../_shared';
import {STOCK_INCOME_CHAIN_ID, STOCK_INCOME_MARKETS, USDG, type StockIncomeMarket} from '../networks/stockIncome';
import {BN} from '../utils/bn';
import {assertFreshSource, type Spread} from './strategy';

const RAW_18 = 10n ** 18n;
const TOLERANCE_DENOMINATOR = 10_000n;
const TOLERANCE_BPS = 50n;
const EXPIRY_SAFETY_SECONDS = 120n;

export interface Quote {
  amount: string;
  size: string;
  minSize: string;
  fee: string;
  price: string;
  optionTokenId: string;
  quotedAt: number;
  expiry: number;
  target: string;
  /** Indicative spread premium converted with the same vault USDG conversion. */
  premiumAmount: string;
}

export type QuoteReader = Pick<PublicClient, 'getChainId' | 'readContract'>;

const ceilDiv = (a: bigint, b: bigint) => {
  if (a < 0n || b <= 0n) throw new Error('Invalid quote arithmetic.');
  return (a + b - 1n) / b;
};

function rawDecimal(value: string, decimals: number, label: string, roundDown = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}.`);
  const decimal = new BN(value);
  const raw = decimal.times(new BN(10).pow(decimals));
  const scaled = roundDown ? raw.integerValue(BN.ROUND_DOWN) : raw;
  if (!decimal.isFinite() || !decimal.gt(0) || !scaled.gt(0) || !scaled.isInteger()) throw new Error(`Invalid ${label}.`);
  return BigInt(scaled.toFixed(0));
}

function positiveUint(value: string, label: string) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${label}.`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function targetSize(quantity: string, multiplier: string) {
  const quantityValue = new BN(quantity), multiplierValue = new BN(multiplier);
  if (!quantityValue.isFinite() || !quantityValue.gt(0) || !multiplierValue.isFinite() || !multiplierValue.gt(0)) {
    throw new Error('Invalid stock quantity or share multiplier.');
  }
  const target = quantityValue.times(multiplierValue).times(new BN(10).pow(18)).integerValue(BN.ROUND_DOWN);
  if (!target.gt(0)) throw new Error('Stock quantity is too small.');
  return BigInt(target.toFixed(0));
}

function validateRoute(market: StockIncomeMarket, spread: Spread) {
  const canonical = STOCK_INCOME_MARKETS.find(item => item.symbol === market.symbol);
  if (!canonical || canonical.index !== market.index || canonical.id.toLowerCase() !== market.id.toLowerCase()
    || canonical.underlying.toLowerCase() !== market.underlying.toLowerCase()
    || market.params.loanToken.toLowerCase() !== USDG.toLowerCase()) {
    throw new Error('Unsupported or changed stock market route.');
  }
  if (spread.symbol !== market.symbol) throw new Error('Spread symbol does not match the market route.');
  if (!spread.short.isOptionAvailable || !spread.long.isOptionAvailable) throw new Error('A spread leg is unavailable.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(spread.short.optionId)
    || !/^0x[0-9a-fA-F]{64}$/.test(spread.long.optionId)) throw new Error('Invalid option listing.');
  const width = new BN(String(spread.long.strikePrice)).minus(String(spread.short.strikePrice));
  const premium = new BN(String(spread.short.markPrice)).minus(String(spread.long.markPrice));
  if (!width.isFinite() || !width.gt(0) || !width.eq(spread.width)) throw new Error('Spread width changed.');
  if (!premium.isFinite() || !premium.gt(0) || premium.gte(width) || !premium.eq(spread.premium)) {
    throw new Error('Spread premium changed.');
  }
}

async function fundTarget(target: bigint, perShare: bigint,
  read: (amount: bigint) => Promise<{size: bigint; fee: bigint}>) {
  if (target <= 0n || perShare <= 0n) throw new Error('Invalid collateral conversion.');
  let amount = ceilDiv(target * perShare, RAW_18);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await read(amount);
    if (result.size <= 0n || result.fee < 0n || result.fee >= amount) throw new Error('Invalid fee quote.');
    if (result.size >= target) return {...result, amount};
    const next = ceilDiv(amount * target, result.size);
    amount = next > amount ? next : amount + 1n;
  }
  throw new Error('Funding quote did not converge. Refresh and retry.');
}

export async function quoteSpread(client: QuoteReader, input: {
  market: StockIncomeMarket;
  spread: Spread;
  account: Address;
  quantity: string;
  multiplier: string;
  fixedAmount?: string;
}): Promise<Quote> {
  const now = Math.floor(Date.now() / 1_000);
  assertFreshSource(input.spread.sourceAt, now);
  validateRoute(input.market, input.spread);
  if ((await client.getChainId()) !== STOCK_INCOME_CHAIN_ID) throw new Error('Select Robinhood Chain.');

  const addresses = CONTRACT_ADDRESSES[SupportedChains.Robinhood];
  const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    client.readContract({address, abi, functionName, args} as never) as Promise<unknown>;
  const optionIds = [input.spread.short.optionId, input.spread.long.optionId, zeroHash, zeroHash] as const;
  const [validated, deadlineBuffer, queue] = await Promise.all([
    read(addresses.CONTROLLER as Address, ControllerAbi as Abi, 'validateOpenPosition', [input.market.index, 2,
      [false, true, false, false], optionIds, [true, true, false, false]]),
    read(addresses.POSITION_MANAGER as Address, PositionManagerAbi as Abi, 'positionDeadlineBuffer'),
    read(addresses.POSITION_MANAGER as Address, PositionManagerAbi as Abi, 'getRequestQueueLengths'),
  ]) as [[bigint, bigint, readonly string[]], bigint | number, readonly [bigint, bigint, bigint]];
  const expiry = Number(validated[0]), optionTokenId = validated[1];
  const buffer = BigInt(deadlineBuffer);
  if (buffer < 0n) throw new Error('Invalid order deadline buffer.');
  if (!Number.isSafeInteger(expiry) || expiry !== input.spread.expiry) throw new Error('Validated expiry changed.');
  if (BigInt(expiry) <= BigInt(now) + buffer + EXPIRY_SAFETY_SECONDS) {
    throw new Error('Too close to expiry. Select a later expiry.');
  }
  if (optionTokenId <= 0n) throw new Error('Controller returned an invalid option token.');

  const vault = await read(addresses.CONTROLLER as Address, ControllerAbi as Abi,
    'getVaultAddressByOptionTokenId', [optionTokenId]) as Address;
  const width = rawDecimal(input.spread.width, 30, 'spread width');
  // Feed marks can use scientific notation; sub-wei precision is floored.
  const price = rawDecimal(input.spread.premium, 30, 'spread premium', true);
  const [perShare, vaultUtils] = await Promise.all([
    read(vault, VaultAbi as Abi, 'usdToToken', [USDG, width, true]),
    read(vault, VaultAbi as Abi, 'vaultUtils'),
  ]) as [bigint, Address];
  if (perShare <= 0n) throw new Error('Collateral conversion is unavailable.');

  const target = targetSize(input.quantity, input.multiplier);
  const minSize = target * (TOLERANCE_DENOMINATOR - TOLERANCE_BPS) / TOLERANCE_DENOMINATOR;
  if (minSize <= 0n) throw new Error('Stock quantity is too small.');
  const maxSize = target * (TOLERANCE_DENOMINATOR + TOLERANCE_BPS) / TOLERANCE_DENOMINATOR;
  const readFee = async (amount: bigint) => {
    const result = await read(vaultUtils, VaultUtilsAbi as Abi, 'getPositionFeeInfo', [input.account, 6, USDG,
      amount, input.market.underlying, amount * RAW_18 / perShare, price, true, false, queue[1]]) as
      readonly [bigint, bigint, bigint, bigint, Address, bigint, boolean];
    return {size: result[1], fee: result[3]};
  };
  const funded = input.fixedAmount === undefined
    ? await fundTarget(target, perShare, readFee)
    : await (async () => {
        const amount = positiveUint(input.fixedAmount!, 'fixed funding amount');
        return {...await readFee(amount), amount};
      })();
  // New loans must cover the target. A frozen principal uses the same 0.5%
  // lower bound already enforced by minSize at order submission/execution.
  const minimumSize = input.fixedAmount === undefined ? target : minSize;
  if (funded.size < minimumSize || funded.size > maxSize) {
    throw new Error('Expected size is outside the 0.5% tolerance. Refresh the quote; do not borrow again.');
  }
  if (funded.fee < 0n || funded.fee >= funded.amount) throw new Error('Invalid fee quote.');
  return {amount: funded.amount.toString(), size: funded.size.toString(), minSize: minSize.toString(),
    fee: funded.fee.toString(), price: price.toString(), optionTokenId: optionTokenId.toString(),
    quotedAt: now, expiry, target: target.toString(),
    premiumAmount: (price * funded.size * perShare / width / RAW_18).toString()};
}
