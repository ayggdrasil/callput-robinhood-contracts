import {decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, parseAbi, parseUnits, type Address, type Hex, type PublicClient, type WalletClient} from 'viem';
import {MORPHO, STOCK_INCOME_MARKETS} from '../networks/stockIncome';
import {lendingTransactions, MORPHO_ABI, projectLoan, readMorpho, type LendingTransaction, type MorphoSnapshot} from './morpho';
import {loadFunding, saveFunding, type FundingAdapter, type FundingStep, type IncomePlan} from './workflow';

export function stockUnits(quantity: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(quantity)) throw new Error('Enter a positive stock-token amount with up to 18 decimals.');
  const amount = parseUnits(quantity, 18);
  if (amount <= 0n) throw new Error('Stock-token amount must be positive.');
  return amount;
}
export function checkFundingPlan(plan: IncomePlan, snapshot: MorphoSnapshot, step: FundingStep) {
  const quantity = stockUnits(plan.quantity), loan = BigInt(plan.quote.amount);
  if (plan.chainId !== 4663 || plan.marketId !== snapshot.market.id || loan <= 0n) throw new Error('Strategy market does not match.');
  if (parseUnits(plan.multiplier, 18) !== snapshot.multiplier) throw new Error('Stock share multiplier changed. Requote before continuing.');
  const baseline = plan.initialBorrowShares ?? '0';
  if (step === 'borrow' && (!/^(0|[1-9]\d*)$/.test(baseline) || snapshot.position.borrowShares !== BigInt(baseline))) throw new Error('The Morpho debt changed. Reconcile the original borrow before continuing.');
  if (step !== 'borrow' && quantity > snapshot.balance) throw new Error('Insufficient stock tokens in the connected wallet.');
  return projectLoan({collateral: snapshot.position.collateral, debt: snapshot.debt,
    addCollateral: step === 'borrow' ? 0n : quantity, borrow: loan,
    oraclePrice: snapshot.oraclePrice, lltv: snapshot.market.params.lltv, liquidity: snapshot.liquidity});
}
export function isSignatureRejected(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = error; e && typeof e === 'object' && !seen.has(e); e = (e as {cause?: unknown}).cause) {
    seen.add(e); if ((e as {code?: number}).code === 4001) return true;
  }
  return false;
}
export function verifyReceiptTransaction(tx: {from: string; to: string | null; input: string; value: bigint; chainId?: number; blockNumber?: bigint | null}, owner: Address, expected: LendingTransaction, minimumBlock?: bigint) {
  if (tx.from.toLowerCase() !== owner.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase()
    || tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.value !== expected.value
    || tx.chainId !== undefined && tx.chainId !== 4663) throw new Error('Transaction does not match this strategy.');
  if (minimumBlock !== undefined && tx.blockNumber != null && tx.blockNumber < minimumBlock) throw new Error('Transaction predates this strategy. Use the original transaction for this operation.');
}
export async function readLendingReceipt(client: PublicClient, owner: Address, tx: LendingTransaction, hash: Hex, minimumBlock?: bigint) {
  if (await client.getChainId() !== 4663) throw new Error('Select Robinhood Chain.');
  const transaction = await client.getTransaction({hash});
  verifyReceiptTransaction(transaction, owner, tx, minimumBlock);
  try {
    const receipt = await client.waitForTransactionReceipt({hash, confirmations: 2, timeout: 30_000});
    if (minimumBlock !== undefined && receipt.blockNumber < minimumBlock) throw new Error('Receipt predates this strategy.');
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Transaction was replaced. Reconcile the original operation.');
    return receipt.status === 'success' ? 'confirmed' as const : 'reverted' as const;
  } catch (error) {
    if (error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError') return 'pending' as const;
    throw error;
  }
}
export async function preflightTransaction(client: PublicClient, owner: Address, transaction: LendingTransaction) {
  if (await client.getChainId() !== 4663) throw new Error('Select Robinhood Chain.');
  await client.call({account: owner, ...transaction});
  const [gas, gasPrice, balance] = await Promise.all([
    client.estimateGas({account: owner, ...transaction}), client.getGasPrice(), client.getBalance({address: owner}),
  ]);
  // Nitro's estimate already includes parent-chain posting cost.
  if (balance < (gas * gasPrice * 125n + 99n) / 100n + transaction.value) throw new Error('Add Robinhood Chain ETH for the Morpho network fees.');
}
export function fundingTransactions(plan: IncomePlan) {
  const market = STOCK_INCOME_MARKETS.find(m => m.id === plan.marketId);
  if (!market) throw new Error('Unsupported Morpho market.');
  return lendingTransactions(market, plan.owner, stockUnits(plan.quantity), BigInt(plan.quote.amount), plan.account);
}
const MORPHO_POSITION_EVENTS = parseAbi([
  'event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)',
  'event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)',
  'event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)',
  'event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)',
  'event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)',
]);
const validHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
type PositionLog = {address?: unknown; blockNumber?: unknown; blockHash?: unknown; transactionHash?: unknown; logIndex?: unknown; removed?: unknown; args?: unknown};
function validatePositionLog(log: PositionLog, fromBlock: bigint, toBlock: bigint) {
  if (typeof log.address !== 'string' || log.address.toLowerCase() !== MORPHO.toLowerCase() || log.removed === true
    || typeof log.blockNumber !== 'bigint' || log.blockNumber < fromBlock || log.blockNumber > toBlock
    || !validHash(log.blockHash) || !validHash(log.transactionHash)
    || typeof log.logIndex !== 'number' || !Number.isInteger(log.logIndex) || log.logIndex < 0) {
    throw new Error('Morpho position history contains a non-canonical log.');
  }
}
export async function readFundedState(client: PublicClient, plan: IncomePlan, hash: Hex): Promise<{borrowShares: string; collateral: string; block: string}> {
  const createdBlock = BigInt(plan.createdBlock), baseline = plan.initialBorrowShares ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(baseline)) throw new Error('Saved Morpho borrow baseline is invalid.');
  const status = await readLendingReceipt(client,plan.owner,fundingTransactions(plan).borrow,hash,createdBlock);
  if (status !== 'confirmed') throw new Error('The original borrow transaction is not confirmed.');
  const receipt = await client.getTransactionReceipt({hash});
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Transaction was replaced. Reconcile the original operation.');
  if (receipt.status !== 'success') throw new Error('The original borrow transaction is not confirmed.');
  if (receipt.blockNumber < createdBlock) throw new Error('Receipt predates this strategy.');
  if (!validHash(receipt.blockHash)) throw new Error('The original borrow receipt block is invalid.');
  const decoded = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== MORPHO.toLowerCase()) return [];
    try {
      const event = decodeEventLog({abi:[MORPHO_POSITION_EVENTS[0]],data:log.data,topics:log.topics,strict:true});
      return event.eventName === 'Borrow' ? [{log,event}] : [];
    } catch {return [];}
  });
  const matching = decoded.filter(({event}) => {
    const args = event.args as unknown as Record<string, unknown>;
    return typeof args.id === 'string' && args.id.toLowerCase() === plan.marketId.toLowerCase()
      && typeof args.onBehalf === 'string' && args.onBehalf.toLowerCase() === plan.owner.toLowerCase()
      && typeof args.receiver === 'string' && args.receiver.toLowerCase() === plan.account.toLowerCase()
      && args.assets === BigInt(plan.quote.amount) && typeof args.shares === 'bigint' && args.shares > 0n;
  });
  if (matching.length !== 1) throw new Error('The receipt must contain exactly one matching Morpho Borrow event.');
  const original = matching[0], originalLog = original.log as PositionLog;
  validatePositionLog(originalLog,receipt.blockNumber,receipt.blockNumber);
  if (originalLog.blockHash !== receipt.blockHash || typeof originalLog.transactionHash !== 'string'
    || originalLog.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('The Borrow event does not match the canonical receipt block.');
  const originalArgs = original.event.args as unknown as Record<string, unknown>, borrowedShares = originalArgs.shares as bigint;

  const currentBlock = await client.getBlock();
  if (typeof currentBlock.number !== 'bigint' || currentBlock.number < receipt.blockNumber || !validHash(currentBlock.hash)) throw new Error('The current Robinhood block is invalid.');
  const position = await client.readContract({address:MORPHO,abi:MORPHO_ABI,functionName:'position',
    args:[plan.marketId,plan.owner],blockNumber:currentBlock.number}) as unknown;
  const tuple = position as {supplyShares?: unknown; borrowShares?: unknown; collateral?: unknown} | null;
  if (!tuple || typeof tuple.supplyShares !== 'bigint' || typeof tuple.borrowShares !== 'bigint' || typeof tuple.collateral !== 'bigint'
    || tuple.supplyShares < 0n || tuple.borrowShares < 0n || tuple.collateral < 0n) throw new Error('Morpho position at the borrow block is invalid.');
  if (tuple.borrowShares !== BigInt(baseline) + borrowedShares) throw new Error('The Morpho borrow-share baseline changed after the original borrow.');
  if (tuple.collateral < stockUnits(plan.quantity)) throw new Error('The current Morpho position does not contain the required collateral.');

  const filters = MORPHO_POSITION_EVENTS.map(event => ({event,ownerKey:event.name === 'Liquidate' ? 'borrower' : 'onBehalf'}));
  let originalSeen = 0;
  for (let fromBlock = receipt.blockNumber; fromBlock <= currentBlock.number;) {
    const toBlock = fromBlock + 9999n < currentBlock.number ? fromBlock + 9999n : currentBlock.number;
    const groups = await Promise.all(filters.map(({event,ownerKey}) => client.getLogs({address:MORPHO,event,
      args:{id:plan.marketId,[ownerKey]:plan.owner},fromBlock,toBlock} as never))) as unknown as PositionLog[][];
    groups.forEach((logs,index) => logs.forEach(log => {
      validatePositionLog(log,fromBlock,toBlock);
      const args = log.args as Record<string, unknown> | undefined, ownerKey = filters[index].ownerKey;
      if (!args || typeof args.id !== 'string' || args.id.toLowerCase() !== plan.marketId.toLowerCase()
        || typeof args[ownerKey] !== 'string' || (args[ownerKey] as string).toLowerCase() !== plan.owner.toLowerCase()) {
        throw new Error('Morpho position history does not match this strategy.');
      }
      const after = log.blockNumber as bigint > receipt.blockNumber
        || log.blockNumber === receipt.blockNumber && (log.logIndex as number) > (originalLog.logIndex as number);
      const same = log.blockNumber === receipt.blockNumber && log.logIndex === originalLog.logIndex;
      if (after) throw new Error('The Morpho position changed after the original borrow.');
      if (same) {
        if (filters[index].event.name !== 'Borrow' || typeof log.transactionHash !== 'string' || log.transactionHash.toLowerCase() !== hash.toLowerCase()
          || log.blockHash !== receipt.blockHash) throw new Error('Morpho position history conflicts with the original Borrow event.');
        originalSeen++;
      }
    }));
    fromBlock = toBlock + 1n;
  }
  if (originalSeen !== 1) throw new Error('The original Borrow event is missing from Morpho position history.');
  const pinned = await client.getBlock({blockNumber:currentBlock.number});
  if (pinned.number !== currentBlock.number || pinned.hash !== currentBlock.hash) throw new Error('The current Robinhood block changed during verification.');
  return {borrowShares:tuple.borrowShares.toString(),collateral:tuple.collateral.toString(),block:receipt.blockNumber.toString()};
}
export function makeFundingAdapter(client: PublicClient, wallet: WalletClient, guard: (plan: IncomePlan) => void,
  requote: (plan: IncomePlan) => Promise<void>): FundingAdapter {
  return {
    load: () => loadFunding(wallet.account!.address), persist: saveFunding, guard, isRejected: isSignatureRejected,
    async preflight(plan, step) {
      guard(plan);
      const market = STOCK_INCOME_MARKETS.find(m => m.id === plan.marketId)!;
      const snapshot = await readMorpho(client, market, plan.owner); guard(plan);
      checkFundingPlan(plan, snapshot, step);
      await requote(plan); guard(plan);
      await preflightTransaction(client, plan.owner, fundingTransactions(plan)[step]); guard(plan);
    },
    async submit(plan, step) {
      guard(plan);
      if (await wallet.getChainId() !== 4663) throw new Error('Wallet network changed.');
      guard(plan);
      return wallet.sendTransaction({account: plan.owner, chain: client.chain, ...fundingTransactions(plan)[step]});
    },
    receipt: (plan, step, hash) => readLendingReceipt(client, plan.owner, fundingTransactions(plan)[step], hash,BigInt(plan.createdBlock)),
  };
}
export const repaymentReserve = (debt: bigint) => (debt * 1001n + 999n) / 1000n + 1n;
export function managementTransaction(action: 'approve-repay' | 'repay' | 'withdraw', snapshot: MorphoSnapshot, owner: Address) {
  const {market, debt, position} = snapshot;
  let amount: bigint, tx: LendingTransaction;
  if (action === 'withdraw') {
    if (position.borrowShares !== 0n || debt !== 0n) throw new Error('Repay the Morpho loan before withdrawing collateral.');
    amount = position.collateral;
    if (!amount) throw new Error('No collateral is available to withdraw.');
    tx = {to: MORPHO, value: 0n, data: encodeFunctionData({abi: MORPHO_ABI, functionName: 'withdrawCollateral', args: [market.params, amount, owner, owner]})};
  } else {
    if (!position.borrowShares) throw new Error('No Morpho debt to repay.');
    const reserve = repaymentReserve(debt);
    if (snapshot.usdgBalance < reserve) throw new Error(`Keep at least ${formatUnits(reserve,6)} USDG in your wallet for repayment, including the interest reserve. Withdraw from CallPut or add USDG first.`);
    amount = action === 'approve-repay' ? reserve : position.borrowShares;
    tx = action === 'approve-repay'
      ? {to: market.params.loanToken, value: 0n, data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [MORPHO, amount]})}
      : {to: MORPHO, value: 0n, data: encodeFunctionData({abi: MORPHO_ABI, functionName: 'repay', args: [market.params, 0n, amount, owner, '0x']})};
  }
  return {tx, amount: amount.toString()};
}
