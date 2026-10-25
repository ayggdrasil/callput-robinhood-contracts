# Structured Position integration boundary

## Existing owners and new modules

The host app lazily mounts `pages/Structure.tsx` at `/structure` on Robinhood only.
`networks/configs.ts` supplies the common desktop/mobile menu entry. The structure
page reuses the existing Wallet and chain controls and provides its compact
header; the ordinary NavBar remains unchanged on other routes.

`src/structure/` owns stock-income planning, Morpho reads and exact wallet calls,
financial projections, durable recovery and the React coordinator.
`src/networks/stockIncome.ts` owns chain 4663's token/market tuples.
`StructurePanels`, `StructurePayoff`, `StructureProgress` and `StructureExample`
present that state. They do not create parallel account providers or order
pollers. Existing host account/session, market store, sponsored submission and
wallet-order utilities remain canonical.

## Custody and execution

The connected owner supplies Robinhood stock tokens as collateral to Morpho
Blue (`0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`). The loan token is six-decimal
Paxos USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`), called `USDC` in legacy
host deployment/ABI keys. It is separate from protocol accounting tokens and
from CallPut's synthetic stock identifiers.

The owner retains Morpho debt. In deposit mode, borrowed USDG goes directly to
the verified CallPut account; that account holds the options. In the explicit
loopback-only wallet QA mode, USDG and options stay in the connected wallet.
The strategy sells a lower-strike call and buys a higher-strike call through
the existing CallPut spread engine. It is not a new on-chain covered-call vault.

Funding advances stock approval → collateral supply → USDG borrow with separate
confirmed receipts and fresh checks. Order submission follows an explicit
review. Wallet mode may need USDG approval. Accepted order requests and keeper
fills are shown separately. The UI presents all stages; it does not batch them
into an assumed atomic transaction.

Lending preflight pins fresh chain reads, verifies code and market-parameter
hashes, token decimals, oracle/liquidity and interest-accrued Morpho shares.
Token `uiMultiplier()` converts collateral token units to option-share exposure;
it does not multiply oracle collateral value a second time. Existing debt and
collateral enter the health check. Configured LLTV is 62.5%; the app requires
projected health at least 1.25.

## Authorization and recovery

Wallet signing remains with the connected chain/owner. Production Robinhood
uses its existing Deposit & Trade policy; the development override requires
`DEV`, an explicit flag and a loopback hostname. HTTPS, secure-cookie and SIWE
origin checks remain intact. Relay origin rewriting is not login authority.

`callput:stock-income:v1:4663:<owner>` stores the local funding journal. Its v2
envelope retains an active run and completed runs, with v1 read compatibility.
An owner Web Lock prevents concurrent funding. Owner/account/connector/chain
changes invalidate asynchronous work, including switching away and back.

Before a wallet prompt, the intended operation is saved. A known transaction
hash resumes receipt inspection; an unknown outcome is never silently resent.
Receipt recovery validates sender, chain, destination, calldata, value and the
review anchor. Sponsored submission synchronously captures and persists the
original request UUID before signing. Lost replies retain that identity.

The original lending plan is immutable. A separately reviewed execution quote
may replace available legs only within the same funded symbol/expiry/size and
loan budget, before an unresolved approval/order exists. Refreshing an option
quote does not resupply collateral or borrow again. Both full original loan
interest and unused funding remain visible.

After a verified fill, New strategy (or a safe changed selection) parks the run
and opens another builder. Pending/ambiguous operations keep inputs locked.
My positions preserves each run; only a fully unwound run can be archived.

## Income, APR and payoff

Financial calculations reuse the host BigNumber helper. Three-decimal display
does not round transaction inputs. APR is annualized net premium divided by
stock-token value:

```text
(premium − estimated opening fee − estimated loan interest)
÷ stock-token value × 365 ÷ term days
```

Public strategy rows exclude unquoted opening fees and say `before fees`.
Reviewed account quotes use their quoted premium/fee. Saved fills authenticate
share size, premium and fill time against PositionManager; the fill-to-expiry
term stays fixed. Saved entry valuation/rate is preferred; legacy records label
current-value estimates rather than inventing entry values.

APR excludes stock P&L, call settlement losses and network/closing costs. An ITM
premium can contain intrinsic value; it is not guaranteed yield. Borrowing is
variable-rate and can trigger liquidation before expiry.

`StructurePayoff` reuses the same piecewise expiry calculation in both views.
Options + loan includes the spread and modeled costs. Include my stock adds
stock P&L and compares it with holding stock alone. Both axes stay linear.
Strategy range puts the short strike at the midpoint and retains both strikes,
the reference/current price and capped spread loss; Full range includes zero.
Hover/tap/keyboard inspection replaces the old gauge.

Saved-position metrics are max premium APR, maximum options/loan loss and maximum
stock-inclusive loss divided by stock value. The UI's modeled max drawdown is
reference-to-expiry loss, not observed historical peak-to-trough drawdown.
Liquidation and execution costs outside the supplied model are excluded.
Guide/fallback samples are labeled and never feed transaction inputs.

## Unwind and remaining acceptance

Options close/settle through the host Options page. Account USDG must be
withdrawn to the owner for Morpho repayment. Repayment clears all debt in the
owner's selected market, including other strategies; it requires the displayed
interest reserve. Only zero borrow shares permits collateral withdrawal.
Option failure does not cancel the loan.

Local funded supply, borrow and one wallet call-spread fill were previously
confirmed. Full funded close/settle → withdrawal → repayment → collateral release
and production deposit-mode acceptance remain release checks. No new contracts,
contract permissions, relayer configuration or deployment is included here.
