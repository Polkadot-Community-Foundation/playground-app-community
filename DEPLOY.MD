# Deploying playground.dot

Deploy the playground registry contract and the frontend. This is one repo in the broader Polkadot stack deployment — it assumes the earlier stack steps are complete:

- The CDM ContractRegistry is deployed on the target chain and its address is set in the installed `cdm` CLI (see `DEPLOY_DOC.md` in [contract-dependency-manager](https://github.com/paritytech/contract-dependency-manager)).
- You have a funded deployer SURI on the target chain — the same one used for the earlier stack steps. It's referred to as `$DEPLOY_SURI` below and passed directly to each command; no account setup is needed.

`<chain>` is one of the CDM presets — `paseo`, `w3s`, `local` (plus `polkadot`, `custom`). Pick the one matching your target environment and use it consistently throughout.

Requires Node 22, pnpm, Rust nightly with `rust-src`.

## 0. Ensure CDM / Rust tooling is installed.

If you haven't already, install cdm
```
curl -fsSL https://raw.githubusercontent.com/paritytech/contract-dependency-manager/main/install.sh | bash
```

CDM installs the latest stable [cargo-pvm-contract](https://github.com/paritytech/cargo-pvm-contract). This repository uses an experimental branch of cargo-pvm-contract for its rust contracts. So before building/deploying the contract, install the experimental cargo-pvm-contract:
```
HOST_TARGET="$(rustc -vV | awk '/^host:/ {print $2}')"
cargo install --force --locked \
  --target "$HOST_TARGET" \
  --git https://github.com/paritytech/cargo-pvm-contract.git \
  --branch charles/cdm-integration \
  cargo-pvm-contract
```

## 1. Get the code

```bash
git clone https://github.com/paritytech/playground-app-community.git
cd playground-app-community
git checkout main
pnpm install --frozen-lockfile
```

## 2. Deploy the registry contract

```bash
cdm deploy -n <chain> --suri "$DEPLOY_SURI"
```

Builds the contract, instantiates it on Asset Hub, publishes the ABI to Bulletin, and registers it in CDM.

> ⚠️ **Redeploys are not in-place.** `cdm deploy` always creates a new contract address with empty storage — there is no upgrade path. On a fresh chain that's fine. To replace a **live** registry without losing state (apps, pins, points, social counts, usernames, lineage), snapshot it *before* deploying and replay afterward:
> ```bash
> pnpm tsx scripts/export-registry-state.ts --out migration/snapshot.json          # BEFORE cdm deploy
> MNEMONIC="$DEPLOY_SURI" pnpm tsx scripts/import-registry-state.ts migration/snapshot.json   # AFTER deploy + cdm i
> ```

Then install the freshly deployed registry — this pulls the new address/version/ABI into the local `cdm.json`, which both the scripts below and the frontend build read from:

```bash
cdm i -n <chain> @w3s/playground-registry
```

## 3. Contract Configurations

### Blacklist

The registry keeps a points-blacklist: accounts on it silently no-op out of `award_points`, so they can never appear on the leaderboard (defense-in-depth for non-awardable recipients). On a fresh deploy you must seed it once with the well-known dev/test signers — the project deploy signer, the `DEV_PHRASE` bare root used by `bulletin-deploy`, `//Alice`, and `//Bob` (the canonical list lives in [`DEV_ACCOUNTS`](scripts/_lib.ts)). Otherwise those accounts would accrue XP from test publishes.

```bash
MNEMONIC="$DEPLOY_SURI" pnpm tsx scripts/blacklist-accounts.ts
```

Pass extra H160 or SS58 addresses as args to blacklist them too:

```bash
MNEMONIC="$DEPLOY_SURI" pnpm tsx scripts/blacklist-accounts.ts <ADDRESS> <ADDRESS>
```

The call is sudo/admin-gated and idempotent — re-running is a cheap no-op. If you populated this registry via the migration in step 2 (`import-registry-state.ts`), the same set was already seeded as that script's step 0, so you can skip this.

### Anti-spam

In order to stop users from spamming with randomly generated accounts, you have to make a PR to Parity's individuality repository. To configure anti-spam for a new environment simply update [this list in `runtimes/next-asset-hub-paseo/src/auth_required_filter.rs`](https://github.com/paritytech/individuality/blob/cd22364dbca446ac421dd02b5fb37d113a3806a0/runtimes/next-asset-hub-paseo/src/auth_required_filter.rs#L27)

```rs
pub const PLAYGROUND_REGISTRY_ADDRESSES: &[H160] = &[
	H160(hex_literal::hex!("eb814656e2466b5a8e613f8121d57c75f684a35d")),
	H160(hex_literal::hex!("0000000000000000000000000000000000000000")), // W3S Summit placeholder.
];
```

with the appropriate address for the `@w3s/playground-registry` contract, which was just deployed in the prior step. Then open a PR against the [individuality](https://github.com/paritytech/individuality/tree/main) repository.

You can grab the `@w3s/playground-registry` address by visiting `contracts.dot/#/package/@w3s/playground-registry` and copying the contract address from there.

## 4. Deploy the frontend

Frontend deploys use [polkadot-app-deploy](https://github.com/paritytech/polkadot-app-deploy):

```bash
npm install -g @parity/polkadot-app-deploy
polkadot-app-deploy --list-environments    # pick the environment matching your chain (e.g. paseo-next-v2, summit)
```

```bash
VITE_SENTRY_DSN="" pnpm build:frontend                      # Build with sentry disabled entirely
MNEMONIC="$DEPLOY_SURI" polkadot-app-deploy --publish --env <env> ./dist playground.dot
```

On a fresh environment the deploy registers `playground.dot`; on re-deploys the mnemonic must own the name. The site is served at `https://playground.dot.li`.

### Build-time configuration (`VITE_*`)

All optional — a default `pnpm build:frontend` against the standard environment needs none of these. They're read at build time only ([src/config.ts](src/config.ts), [src/sentry.ts](src/sentry.ts)), so set them inline on the build command (e.g. `VITE_REVX_URL=… pnpm build:frontend`), not on `polkadot-app-deploy`.

| Var | Default | Purpose |
|---|---|---|
| `VITE_ENVIRONMENT` | `paseo` | Network the whole build targets — Asset Hub, Bulletin, and the People chain move together ([src/config.ts](src/config.ts)). Supported: `paseo`, `summit`. Must match the chain you deployed the registry to (step 2) and the `polkadot-app-deploy --env` (step 4). An explicitly-set unknown value fails the build loudly rather than silently shipping the wrong chain. See note below. |
| `VITE_VERSION` | `dev` | Release id — Sentry release tag + about screen. CI sets the short SHA / tag. Unset in a local prod build deliberately skips Sentry init (see below). |
| `VITE_BUILD_TIME` | empty | UTC ISO build timestamp; display only. CI sets it. |
| `VITE_SENTRY_DSN` | hardcoded DE/EU DSN in [src/sentry.ts](src/sentry.ts) | Route telemetry to a different project, or set empty to disable — see Telemetry below. |
| `VITE_SENTRY_ENV` | Vite `MODE` | Sentry environment tag (`production`, `preview-<pr>`, `e2e`, …). |
| `VITE_SENTRY_TAG` | unset | Synthetic-traffic label so dashboards can exclude E2E runs. Set by Playwright. |
| `VITE_REVX_URL` | `https://stg.revx.dev` | Base URL for the RevX editor deep-link. |
| `VITE_PLAYGROUND_URL` | `https://playground.dot.li` | Canonical share-link host, so links resolve outside the host container. |
| `VITE_PLAYGROUND_DOTNS_ID` | derived from `window.location.hostname` | DotNS id the host derives the product account from. The host enforces strict equality — override only if you know the expected id. |
| `VITE_INSTALL_CMD` | `curl … playground-cli/main/install.sh \| bash` | One-line CLI install command shown in the UI. |
| `VITE_CLI_COMMAND` | `pg` | CLI binary name in copyable commands. |
| `VITE_NO_CODE_APP_DOMAIN` | `hello-playground20.dot` | Bare `.dot` domain of the no-code starter surfaced on the Playground tab; call sites append `.li` for the gateway URL. |
| `VITE_PLAYGROUND_REGISTRY_PACKAGE` | `@w3s/playground-registry` | Set to `@staging/playground-registry` in `.env.local` to UI-test against a staging deploy. Never set on a prod build. |
| `VITE_DEV_FUNDER_MNEMONIC` | unset (drip skipped) | **Dev / testnet only.** Bare mnemonic of a funded account that drips 100 PAS to each freshly-connected product account during "Collect my resources" — see Dev funder below. ⚠️ Baked verbatim into the bundle; leave unset on any public / production build. |

### Selecting the network (`VITE_ENVIRONMENT`)

`VITE_ENVIRONMENT` picks which chain descriptors (Asset Hub + Bulletin + People/individuality) the frontend bundles. The default `paseo` is the standard environment; set `summit` for a summit build:

```bash
VITE_ENVIRONMENT=summit pnpm build:frontend
```

Three naming spaces line up here — keep them consistent:

| Step | Selector | Example values |
|---|---|---|
| Contract deploy (step 2) | CDM `-n <chain>` | `paseo`, `w3s`, `summit` |
| Frontend build | `VITE_ENVIRONMENT` | `paseo`, `summit` |
| Frontend deploy (step 4) | `polkadot-app-deploy --env` | `paseo-next-v2`, `summit` |

The registry contract address is **not** pinned in the bundle — it's resolved at boot from the on-chain CDM meta-registry whose address lives in `cdm.json` ([the `registry` field](cdm.json)). That field is set by the `cdm i -n <chain> @w3s/playground-registry` in step 2, so `VITE_ENVIRONMENT` must name the **same chain** you ran `cdm i` against, or the frontend will look for the registry on the wrong network and the Apps grid will come up empty.

### Dev funder (`VITE_DEV_FUNDER_MNEMONIC`)

A temporary stand-in for the production PGAS claim path (a runtime-V5 extrinsic the Polkadot mobile app issues). On a dev / testnet build you can have the app top up each freshly-connected product account so prototype sessions can sign without a manual faucet step. It is handled in `attemptDevFunderTopUp` ([src/utils/contracts.ts](src/utils/contracts.ts)) and runs as the last step of "Collect my resources" (`provisionResources`).
Preferably use same mnemonic as in playground-cli.

```bash
VITE_DEV_FUNDER_MNEMONIC="word word … word" pnpm build:frontend   # dev/testnet only
```

- **Bare mnemonic**, derived at path `""` (so the funder is that mnemonic's root account — *not* `//Alice`). Must hold native PAS on the target chain.
- **Fallback to `//Alice`** when the configured funder is the recipient itself or is short on funds (`free < 101 PAS`). With no configured funder the drip is skipped entirely — including the Alice fallback.
- **Only the token transfer is gated** by this var; the host allowance requests (ChainSubmit / SmartContract / Bulletin / Preimage) always run regardless.
- ⚠️ **Security:** like every `VITE_*` value this is **inlined verbatim into the client JS bundle** at build time, so anyone who loads the build can extract it. Use only a **low-value, disposable testnet key**, and **never set it on a public / production build** — unset is the correct production default (real users fund via the mobile PGAS claim path). Don't wire it into the production deploy workflow; if you need it for a staging build, inject it as a CI secret on that build only.

### Telemetry (Sentry)

The frontend ships with Sentry error/performance reporting on by default — the DSN is hardcoded in [src/sentry.ts](src/sentry.ts) (publish-only, public-safe). The DSN is baked into the bundle at **build** time, so to change it, set `VITE_SENTRY_DSN` on the `pnpm build:frontend` step above — in place of the plain build command, *not* on `polkadot-app-deploy` (which only ships the already-built `./dist`):

```bash
VITE_SENTRY_DSN="" pnpm build:frontend                      # disable Sentry entirely
VITE_SENTRY_DSN="<your-project-dsn>" pnpm build:frontend    # send to a different project
```

Then run the same `polkadot-app-deploy --env <env> ./dist playground.dot` command to ship it.

(Also: a local `pnpm build:frontend` with no `VITE_VERSION` set skips Sentry init regardless, so stray local bundles never report to the production project.)

## Verify

```bash
pnpm tsx scripts/verify-contracts.ts            # every cdm.json contract is instantiated on-chain
curl -sSI https://playground.dot.li | head -1   # 200 OK
```

Open `https://playground.dot.li` — the Apps tab loads, the Leaderboard renders, Profile shows your account.

### 🛑 **STOP** 🛑
The rest of the steps assume you have already deployed sample apps to the playground

## 5. **AFTER DEPLOYING SAMPLE APPS** Registry setup

All sudo-gated — sign with the mnemonic that ran `cdm deploy`:

```bash


# Grant day-to-day admin (pin/unpin etc.) to curator accounts — add_admin itself stays sudo-only
MNEMONIC="$DEPLOY_SURI" pnpm tsx scripts/add-admin.ts <SS58_ADDRESS>

# Pin the canonical apps (tutorial, sample apps, starter). Idempotent — re-run as apps get published.
MNEMONIC="$DEPLOY_SURI" pnpm tsx scripts/pin-apps.ts \
  playground-tutorial.dot \
  rock-paper-scissors.dot \
  empty-starter.dot \
  feedback-board.dot \
  hello-playground20.dot
```

> **Check the actual domains before pinning.** The list above is illustrative — it must match (a) the `.dot` domains your sample apps were really deployed under, and (b) the frontend constants in the build you shipped. [src/config.ts](src/config.ts) hardcodes `TUTORIAL_DOMAIN` (`playground-tutorial.dot`) and `NO_CODE_APP_DOMAIN` (`hello-playground20.dot`); `TUTORIAL_DOMAIN` in particular **must** be pinned in the registry this build reads, or the tutorial CTA opens to an empty App Detail Panel. Adjust the list to whatever those values actually are for your deploy.

Domains that haven't been published yet fail with `AppNotFound` — pin them after they appear in the registry.
