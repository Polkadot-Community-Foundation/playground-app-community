IN PROGRESS

# Deploying playground.dot

A three-tab quest platform for the Web3 Summit Developer Lab — on-chain registry contract on Paseo Asset Hub + frontend bundle on Bulletin under `playground.dot`.

## Prerequisites

- pnpm 10.17.1 (check: `pnpm --version`)
- Node 22.x (check: `node --version`)
- Rust nightly with `rust-src` (check: `rustup show active-toolchain` shows nightly; `rustup component list --installed | grep rust-src`)
- `cdm` CLI (check: `cdm --version`). Install:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/paritytech/contract-dependency-manager/main/install.sh | bash
  ```
- `~/.cdm/accounts.json` populated for `paseo`, mnemonic funded with PAS on Paseo Asset Hub, and account-mapped:
  ```bash
  cdm init                       # only if accounts.json doesn't exist
  cdm account map -n paseo
  cdm account bal -n paseo       # confirm balance > 5 PAS
  ```
- For frontend deploys: the same mnemonic must own `playground.dot`.

## 1. Get the code

```bash
git clone https://github.com/paritytech/playground-app.git
cd playground-app
git checkout main
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint:license
```

## 2. Configure

No configuration is required to run a default deploy against Paseo Next v2. Override the items below only when targeting a different chain, signer, or telemetry project.

### Build-time (frontend, `VITE_*`)

| Var | Default | Purpose |
|---|---|---|
| `VITE_VERSION` | `dev` | Release id (Sentry + about-screen). CI sets short SHA or tag. Local prod builds with this unset deliberately skip Sentry init. |
| `VITE_BUILD_TIME` | empty | UTC ISO timestamp; display only. CI sets it. |
| `VITE_SENTRY_DSN` | hardcoded EU project DSN in [src/sentry.ts](src/sentry.ts) | Override to route elsewhere; set empty to disable Sentry. |
| `VITE_SENTRY_ENV` | Vite `MODE` | Sentry env tag (`production`, `preview-<PR#>`, `e2e`, …). |
| `VITE_SENTRY_TAG` | unset | Synthetic-traffic label so dashboards can exclude E2E runs. Set by Playwright. |
| `VITE_REVX_URL` | `https://stg.revx.dev` | Base URL for the RevX editor deep-link. |
| `VITE_PLAYGROUND_URL` | `https://playground.dot.li` | Canonical share-link host (so links work outside the host container). |
| `VITE_PLAYGROUND_DOTNS_ID` | derived from `window.location.hostname` | DotNS id the host derives this app's product account from. Host enforces strict equality — only override if you know what id is expected. |
| `VITE_INSTALL_CMD` | `curl … playground-cli/main/install.sh \| bash` | One-line CLI install command shown in the UI. |
| `VITE_CLI_COMMAND` | `pg` | Name of the CLI binary in copyable commands. |
| `VITE_NO_CODE_APP_DOMAIN` | `hello-playground20.dot` | Bare `.dot` domain of the no-code starter app surfaced on the Playground tab + IslandPortal. Call sites append `.li` for the Bulletin gateway URL. |
| `VITE_PLAYGROUND_REGISTRY_PACKAGE` | `@w3s/playground-registry` | Set to `@staging/playground-registry` in `.env.local` to UI-test against staging. Never set on a prod build. |


### Script env vars

| Var | Default | Used by | Purpose |
|---|---|---|---|
| `MNEMONIC` | — (required) | `register-context.ts`, `import-registry-state.ts`, `publish-metadata.ts`, `bulletin-deploy` | Signer mnemonic. Role depends on the script: context owner / registry sudo / DotNS owner. |
| `ASSET_HUB_WS_URL` | `wss://paseo-asset-hub-next-rpc.polkadot.io` | every diagnostic script (`assetHubWsUrl()` in [scripts/_lib.ts](scripts/_lib.ts)) | Asset Hub WS endpoint. |

### CI secrets

| Secret | Used by | Purpose |
|---|---|---|
| `MNEMONIC` | [.github/workflows/deploy-contracts.yml](.github/workflows/deploy-contracts.yml), [.github/workflows/release.yml](.github/workflows/release.yml) | The single deploy mnemonic — contract sudo / deployer **and** DotNS owner of `playground.dot`. Signs `cdm deploy`, `register-context.ts add`, `import-registry-state.ts`, and production frontend deploys on tag push. |
| `PLAYGROUND_CLI_DISPATCH_TOKEN` | [.github/workflows/deploy-contracts.yml](.github/workflows/deploy-contracts.yml) | Cross-repo `repository_dispatch` token to trigger the CLI's contract-manifest patch release. |

### `cdm.json` (top-level keys)

Flat — keyed by package name, no target nesting, no endpoint URLs.

| Key | Purpose |
|---|---|
| `registry` | Address of the on-chain CDM meta-registry. Written by `cdm deploy --bootstrap`. |
| `dependencies` | `{ "@org/pkg": "latest" \| <version> }` — what `cdm install` should resolve. |
| `contracts` | `{ "@org/pkg": { version, address, abi, metadataCid } }` — snapshot the frontend builds against. |

## 3. Deploy

### First-time on an existing chain (e.g. Paseo Next v2)

```bash
# Build → instantiate on Asset Hub → publish ABI to Bulletin → register in CDM.
# Rewrites cdm.json with the new address/version/ABI.
pnpm deploy

# Authorise the new registry as an operator on the playground.dot context.
MNEMONIC="<context-owner-mnemonic>" pnpm tsx scripts/register-context.ts add

# Commit so the frontend (which reads cdm.json at build time) picks up the new address.
git add cdm.json
git commit -m "chore: deploy registry"
git push

# Build and publish the frontend bundle to Bulletin.
pnpm build:frontend
pnpm deploy:frontend
```

### Fresh chain (bootstrap from zero)

```bash
cdm init
# fund the printed account on the new chain, then:
cdm account map -n <network>
cdm deploy -n <network> --bootstrap                            # deploys the CDM meta-registry
cdm i -n <network> @polkadot/contexts @mock/reputation         # install system contracts
pnpm deploy                                                     # deploy playground-registry
MNEMONIC="<deployer-mnemonic>" pnpm tsx scripts/register-context.ts   # signer becomes owner + initial operator
```

### Publish the playground app's own metadata entry

```bash
MNEMONIC="<DotNS-owner-mnemonic>" pnpm tsx scripts/publish-metadata.ts playground.dot
```

Uploads the icon + `AppMetadata` JSON to Bulletin and calls `registry.publish(...)` with `is_dev_signer=true`. Currently manual — disabled in CI pending [product-sdk#102](https://github.com/paritytech/product-sdk/issues/102).

### Set up admins and pin the canonical apps

By default, every owner-restricted operation (`pin`/`unpin`, `add_admin`/`remove_admin`, `set_blacklisted`, `import_*`, `set_frozen`) is gated on the **sudo account that signed `cdm deploy`** — that's the same mnemonic stored in `~/.cdm/accounts.json` under the active chain preset (e.g. `paseo`). For day-to-day registry curation, grant admin to one or more additional accounts and pin the apps that should appear at the top of the Apps grid.

Both scripts read the signer from the `MNEMONIC` env var. The same one-liner unpacks the deploy mnemonic from your cdm config — reuse it for both calls below, or substitute your own mnemonic string:

```bash
SUDO_MNEMONIC="$(node -e "process.stdout.write(require(require('os').homedir()+'/.cdm/accounts.json').paseo.mnemonic)")"
```

**Promote admins.** Admin promotion requires **sudo only**. Admins gained this way can call `pin`/`unpin` and similar operational methods but cannot themselves `add_admin`/`remove_admin` — those stay sudo-only:

```bash
MNEMONIC="$SUDO_MNEMONIC" pnpm tsx scripts/add-admin.ts <SS58_ADDRESS>
```

**Pin the canonical apps.** The frontend renders pinned apps at the top of the Apps grid. The canonical set is the structured tutorial, the sample apps, and the empty/starter template. Either sudo or any account you've added as admin can sign this — using `$SUDO_MNEMONIC` is fine for the first-pin pass. The script is idempotent — already-pinned domains are skipped:

```bash
MNEMONIC="$SUDO_MNEMONIC" pnpm tsx scripts/pin-apps.ts \
  rock-paper-scissors.dot \
  empty-starter.dot \
  feedback-board.dot
  # ... add each sample app's .dot domain as it's deployed
```

Domains that haven't been `publish`'d yet fail with `AppNotFound` — pin them after they appear in the registry.

The script is mostly for the initial bulk-pin pass after a fresh deploy. Once admins are set up, they can also pin or unpin individual apps from the App Detail Page in the playground-app UI.

## 4. Redeploy: transferring apps to a new registry

`cdm deploy` always produces a **new contract address with empty storage** — there is no in-place upgrade path. When redeploying a live chain, snapshot the old registry first and replay the state into the new one. The export and import scripts are idempotent; partial failures are safe to re-run.

```bash
# 1. Snapshot the live registry BEFORE redeploying.
pnpm tsx scripts/export-registry-state.ts --out migration/snapshot.json

# 2. Run the deploy from § 3 above.

# 3. Replay state into the new registry. Sudo = whoever ran `cdm deploy`.
MNEMONIC="<deployer-mnemonic>" pnpm tsx scripts/import-registry-state.ts migration/snapshot.json
```

What gets carried: apps, pinned entries, points, social counts, usernames, and lineage. The import script auto-blacklists dev accounts and reconciles phantom leaderboard entries — internals are in [scripts/import-registry-state.ts](scripts/import-registry-state.ts).

In CI, the **Deploy Contracts** workflow (`workflow_dispatch`) chains export + deploy + register-context-add + import + commit `cdm.json`, then triggers **Deploy Frontend** via `workflow_run`. Production goes via `v*.*.*` tag push → [.github/workflows/release.yml](.github/workflows/release.yml).

## 5. Verify

Pre-flight (before pulling the trigger):

```bash
pnpm tsx scripts/measure-deploy-cost.ts          # dry-run: gas + storage deposit; confirms deployer balance covers it
pnpm tsx scripts/check-revive-mapping.ts <ss58>  # confirms the deployer is account-mapped on Revive
```

Contracts (after `pnpm deploy`):

```bash
pnpm tsx scripts/verify-contracts.ts             # every cdm.json contract + the CDM meta-registry is instantiated
git diff cdm.json                                # new address + bumped version present
pnpm tsx scripts/smoke-test-points.ts            # end-to-end points/blacklist/lineage (45/45 expected; staging)
pnpm tsx scripts/smoke-test-usernames.ts         # username set / clear / rename / availability
pnpm tsx scripts/check-migration.ts              # sudo guards on every import method (CRITICAL)
```

Migration parity (after `import-registry-state.ts`):

```bash
# Re-export from the new registry, then diff against the pre-deploy snapshot.
# Exits 0 on parity, 1 on hard diff.
pnpm tsx scripts/export-registry-state.ts --out migration/after.json
pnpm tsx scripts/diff-registry-state.ts migration/snapshot.json migration/after.json
```

Frontend (after `pnpm deploy:frontend`):

```bash
curl -sSI https://playground.dot.li | head -1    # 200 OK
```

- Open `https://playground.dot.li` — Apps tab loads with the expected count, Leaderboard renders, Profile shows your account.
- Open `https://playground.dot.li/?test-sentry=1` and click through — events should appear in Sentry under the new release within ~1 min, tagged with the right `VITE_VERSION` and `VITE_SENTRY_ENV`.
- Spot-check the playground app's own entry on `/apps` — confirms `publish-metadata.ts` ran (the entry won't appear if it was skipped).

## Troubleshooting

| You see | Fix |
|---|---|
| `MNEMONIC env var required` | Export the mnemonic before running the script — see the role table under Configure → Script env vars to pick the right one. |
| `Caller 0x… is not sudo.` (during `import-registry-state.ts`) | The `MNEMONIC` you used isn't the new registry's sudo. Sudo = whoever ran `cdm deploy`. Re-run from that mnemonic. |
| `Cannot read properties of undefined (reading 'tx')` in the frontend | The deployed contract doesn't expose a method the frontend calls. Either `cdm.json` is stale (re-pull `main` after a deploy) or you're pointing the UI at `@staging` without setting `VITE_PLAYGROUND_REGISTRY_PACKAGE=@staging/playground-registry` in `.env.local`. |
| `bulletin-deploy` exits with "domain not owned by signer" | Your `MNEMONIC` doesn't own `playground.dot`. Set the deploy mnemonic correctly or have the domain owner run the deploy. |
| `Revive.OutOfGas` mid-migration | An auto-estimator undershoot on fresh storage. The script already pins gas at 1.5T ref_time; re-run — it's idempotent and resumes at the failed entry. |
| `[contracts] No origin configured` warning spam | Diagnostic scripts dry-run as `origin` of the signer. Make sure the mnemonic derives correctly (`seedToAccount(MNEMONIC, "")` — no path). |
| Sentry dashboard shows `playground-app@dev` events from a deploy | A local `pnpm build:frontend` shipped without `VITE_VERSION` set. Always set `VITE_VERSION` in CI; local prod builds are deliberately blocked from emitting. |
