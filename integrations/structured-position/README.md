# Structured Position

CallPut's Robinhood stock-income submenu. Hold stock tokens, review a call
spread, supply stock collateral to Morpho and borrow Paxos USDG for the option
position. This is the final reviewed UI/source snapshot; publishing this package
does not deploy the feature.

## What is included

- Robinhood-only `/structure` route, reached from the host's **Stock Income** menu;
  the page heading is **Structured Position**.
- NVDA, TSLA and AAPL holdings; actual listed expiries; ITM, ATM and OTM choices.
- Premium, borrowing cost and APR on stock-token value, with three-decimal amounts.
- Compact builder, Guide, My positions, Activity and Details.
- Interactive payoff with options/loan and stock-inclusive views, current-price
  marker, strike percentage moves, full-range inspection and saved-position risk.
- Morpho approval/supply/borrow, CallPut approval/order/fill progress and recovery.
- Repeat strategies after a confirmed fill, plus repayment/collateral controls.

`frontend/` contains new feature modules and tests. `host-integration.patch`
contains the changes to existing CallPut owners: route/menu, market provenance,
account setup, submitted-order capture and loopback-only wallet QA configuration.
[`manifest.json`](manifest.json) records input/output hashes and source provenance.
[`ARCHITECTURE.md`](ARCHITECTURE.md) describes execution and financial assumptions.

This package uses the existing CallPut app shell, wallet providers, shared
deployment data, account/session authorization, pricing, order entry and keepers.
It does not include a duplicate app, new custody contract, backend or deploy job.

## Apply to the CallPut frontend

Access to `alanxxzero/callput` is required. The exact supported base is
`1e2166bc3ff8e2aee921dbc41b46b37c4ef3dd7b`. Use a clean branch/worktree. For newer
host versions, review and port the patch rather than replacing changed owners.

From a clean CallPut checkout at that commit, set `STRUCTURE_PACKAGE` to the
absolute path of **this directory**, then run:

```sh
git switch -c feat/structured-position
git apply --check "$STRUCTURE_PACKAGE/host-integration.patch"
git apply "$STRUCTURE_PACKAGE/host-integration.patch"
cp -R "$STRUCTURE_PACKAGE/frontend/." frontend/
git diff --check
```

The patch targets existing files only; the copy adds new modules. Keep both parts
together. No shared-source or generated ABI edits are required. Install the
host's existing dependencies with its normal workspace setup; no dependency is
added by the feature.

## Configure and run locally

Copy the host `frontend/.env.example` to an ignored local environment file and
set the public Robinhood endpoints. The Robinhood build validates these keys:

```text
VITE_ROBINHOOD_RPC_URL
VITE_ROBINHOOD_LAMBDA_API_BASE
VITE_SETTLE_PRICE_DATA_API
VITE_IS_RESTRICTED_COUNTRY_API
VITE_KLINE_API
VITE_WEBSOCKET_API
VITE_MARKET_DAILY_API
```

Use the host's maintained endpoint configuration. `VITE_*` values enter the
browser bundle: they must never contain private keys, passwords or service
credentials. This package contains no local environment or test-wallet files.

From `frontend/`, using the host's installed Node tooling:

```sh
node --import tsx --test 'src/**/*.test.cts'
npx --no-install tsc --noEmit
npm run build:robinhood
npx --no-install vite --mode robinhood --host 127.0.0.1 --port 5190 --strictPort
```

Open `http://127.0.0.1:5190/structure` with Robinhood selected. **Guide** works
without a signer and uses labeled sample terms. Public live estimates still
require working market/RPC endpoints.

### Wallet QA versus production account mode

The existing production policy remains **deposit-only** for Robinhood. For the
previously tested Base-style wallet route, opt in only on localhost/127.0.0.1:

```text
VITE_DEV_ROBINHOOD_WALLET_TRADING=1
VITE_ROBINHOOD_APP_DATA_BASE=/dev-public/robinhood
VITE_DEV_RELAY_ORIGIN=https://robin.callput.app
```

The wallet override requires a Vite development build, that explicit flag and a
loopback hostname. The public-data proxy accepts GET/HEAD only. Neither exists
in a production build. A relay proxy does not change SIWE origin binding or
grant permission to authenticate a different origin. Production deposit-account
setup needs the authorized HTTPS origin/relay; otherwise use the local wallet
route for QA. Optional `CALLPUT_DEV_TLS_CERT` and `CALLPUT_DEV_TLS_KEY` stay
server-side and must be supplied together when a configured HTTPS environment
is needed.

## Validation and release acceptance

Verification on 2026-10-25 reconstructed the package against the pinned host and
confirmed all 39 new modules and 25 patched files match the final source exactly.
Using the host's installed workspace dependencies, the reconstructed frontend
passed all **591 unit tests**, TypeScript, focused ESLint (0 errors; 15 warnings)
and `npm run build:robinhood`. The build retains the host's large-chunk warnings.
Tests cover funding/resume, custody, request identity, chain isolation,
APR/payoff, repeat selection and progress. No funded transaction was submitted
during this packaging verification; the root contract build was not changed.
The host's `check-synced` script reports pre-existing rewards/asset-mapping
drift. Shared source, vendored copies and that checker are unchanged from the
pinned host; this package does not regenerate or repair them.

Prior local funded QA confirmed stock supply, USDG borrowing and an NVDA call
spread fill. **Close/settle, withdrawal, full loan repayment and collateral
release have not been verified end to end with funds.** Production deposit-mode
execution must also be accepted on its authorized origin. The localhost wallet
fill does not establish production relay readiness.

Before deployment, verify the full lifecycle with a dedicated test account,
including a second position, reload/recovery, rejection handling and final
unwind. No deployment, contract upgrade, production configuration change or
automated wallet signature is performed by this integration package.
