# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) — and to human contributors — when working with code in this repository.

## Project: playground.dot

A registry browser for `.dot` apps on Polkadot. Reads from a PVM smart contract on Paseo Asset Hub, displays published apps with infinite-scroll pagination, search, and a mod (clone) flow, and lets users publish, star, and mod each other's apps.

## Commands

```bash
pnpm install                # Install dependencies
pnpm dev                    # Vite dev server (--host for LAN access)
pnpm typecheck              # tsc -b — fast type-check, no bundle
pnpm build:frontend         # tsc -b + vite build → dist/
pnpm build:contracts        # cdm build → target/*.release.polkavm + ABI
pnpm deploy                 # cdm deploy -n paseo (build + deploy + register contracts)
pnpm deploy:frontend        # Deploy dist/ to a .dot domain via Bulletin IPFS
pnpm preview                # Preview built frontend locally
pnpm lint:license           # Verify GPL-3.0-or-later SPDX header on all source files
pnpm test                   # Vitest — unit + component tests (fast, no chain)
pnpm test:watch             # Vitest in watch mode
pnpm test:e2e               # Playwright E2E suite (needs E2E_FUNDER_SEED)
```

Rust contracts require the nightly toolchain configured in `rust-toolchain.toml`.

## Verification before committing

Contributors and AI agents should run both checks before opening a PR. CI runs the same ones; failing locally first saves a round-trip.

```bash
pnpm typecheck       # tsc -b — fails on TS errors. Faster than build:frontend (no bundle step)
pnpm lint:license    # fails if any .ts/.tsx/.rs source file is missing the SPDX header
```

If `pnpm lint:license` fails, run `pnpm lint:license --fix` to prepend the standard GPL-3.0-or-later header to any files that need it. The check requires *both* the `SPDX-License-Identifier: GPL-3.0-or-later` line *and* the Parity copyright line; a bare SPDX identifier alone won't pass. Every `.ts`, `.tsx`, or `.rs` file under `src/`, `e2e/`, `scripts/`, or `contracts/` must carry the full header — enforced by `.github/workflows/license.yml` on every PR.

There is **no `format` or general `lint` script** — no Prettier/Biome/ESLint is configured. Match the surrounding style by hand. Run `pnpm build:frontend` (instead of `pnpm typecheck`) when you also want to verify the Vite bundle succeeds — typically only relevant for changes to `vite.config.ts`, asset imports, or env-var plumbing.

The Playwright suite (`pnpm test:e2e`) is real but expensive and currently paused in CI — run it manually when changing anything that touches the publish flow, chain queries, or the registry grid.

**CDM codegen caveat.** `cdm install` regenerates `.cdm/contracts.d.ts` augmenting `"@polkadot-apps/contracts"` and `.cdm/cdm.d.ts` augmenting `"@dotdm/cdm"` — neither matches the package this app actually imports from (`@parity/product-sdk-contracts`), so the typed-method augmentations are inert and contract calls fall back to the untyped `Contract<ContractDef>` overload. The broken `FixedSizeBinary` import inside those files is masked by `skipLibCheck: true`. Until the CDM CLI is updated for the product-sdk rename, the generated `.cdm/*.d.ts` files don't add type safety and can be deleted locally without consequence. `.cdm/` is gitignored.

## Architecture

**Frontend** (`src/`): React 19 + TypeScript + Vite. No component library — pure CSS with dark theme and CSS variables (accent: `#e6007a`). Fonts: DM Sans, DM Serif Display. Routing: `react-router-dom` v7. Nav icons: `lucide-react`.

- `src/App.tsx` — Data orchestrator: CDM client setup, on-chain event subscription (legacy bare-domain events `Published`, `Unpublished`, `Rated`, `RatingRemoved`, `VisibilityChanged`, `Pinned`, `Unpinned`, plus typed SCALE events `DeployPointAwarded`, `PlaygroundPublishPointAwarded`, `ModdablePointAwarded`, `ModPointAwarded`, `StarPointAwarded`, `StarPointRefunded`), infinite-scroll pagination, `AppCard`, `MyApps` view, `PublishModal` for the publish pipeline, `InstallWidget` for the CLI install command. Hosts the 3-column shell (left rail + routed main) and renders `<Routes>`.
- `src/LeftRail.tsx`, `src/PlaygroundTab.tsx`, `src/AppsTab.tsx`, `src/Leaderboard.tsx`, `src/ProfileTab.tsx` — Layout shell + per-tab views. The Apps tab owns the local filter/search state and uses the right rail for tags + moddable toggle + search. The Leaderboard tab reads `get_top_builders(0, 20)` and highlights the connected user.
- `src/AccountPanel.tsx` — Account-in-use card shown above MyApps inside ProfileTab: wallet name + "Signed in as <username or H160>" + button that opens `SetUsernameModal`. Owns the optimistic-claim lifecycle (paints the new username instantly; toasts on post-sign failure).
- `src/SetUsernameModal.tsx` — Stateless w.r.t. tx: validates / probes availability, hands off `onConfirm(name)` to the parent and dismisses immediately so the host-app sign prompt is the visible activity.
- `src/PointsBreakdown.tsx` — Compact total + Launch/Mod/Star stat strip shown above the connected user's MyApps. Reads `get_point_breakdown` (single round-trip).
- `src/scaleDecode.ts` — Pure SCALE decoder for typed event payloads. Extracts the first `String` field (the domain whose social count just changed) from a payload that starts with `Address(20 bytes) + Compact<u32> length + utf8`. Lifted out of App.tsx per the repo's "pure logic in `.ts`, never inside `.tsx`" rule so vitest can import it without React.
- `src/utils.ts` — `useIntersectionObserver` hook (triggers "load more").
- `src/utils/username.ts` — `validateUsernameClient` (mirror of contract validation), `useRegistryUsername` (per-account hook), `useRegistryUsernamesBatch` (leaderboard batch), `displayNameForAccount` (registry → wallet → H160 precedence), `shortAddr`.
- `src/main.tsx` — React entry point; wraps `<App />` in `<BrowserRouter>`.

**Routes:**

| Path | View |
|---|---|
| `/` | Playground — full-height "Install CLI" hero |
| `/apps` | Apps — registry grid (centre) + filters/search (right rail) |
| `/leaderboard` | Leaderboard — top builders by XP, highlights the connected user |
| `/profile` | Profile — AccountPanel + your published apps (connect prompt when not connected) |

**Moddable vs play-only.** An app is "moddable" iff its Bulletin metadata has `repository` set to a public GitHub URL. The CLI sets this via `playground deploy --moddable`; without it (or without a public origin), the field is omitted. The frontend uses this single signal to render a `Moddable` badge on the card, drive a `Moddable only` filter, and conditionally show or hide the `Open in RevX` / `playground mod ...` CTAs in the App Detail Page.

**Smart Contract** (`contracts/registry/`): `#![no_std]` PVM contract registered as `@w3s/playground-registry`. A `@staging/playground-registry` variant exists for test deploys — swap the `cdm = "..."` annotation on `mod playground_registry` before deploy and revert after.

- Core storage: `app_count`, `domain_at` (index→domain), `metadata_uri` (domain→IPFS CID), `info` (domain→`AppInfo { owner, visibility, publisher }`).
- Points / leaderboard storage: `account_points: Mapping<Address, u128>` (single XP total per account, evicted at score 0), `points_index: OrderedIndex<u128, Address, 3>` (descending-sorted leaderboard, keyed on `u128::MAX - score`), per-domain counters (`mod_count`, `star_count`) plus app-scoped awarded social XP (`domain_mod_points`, `domain_star_points`), per-pair dedupe maps (`mod_credited`, `star_given`), `blacklisted: Mapping<Address, bool>` (sudo/admin-managed blocklist for non-awardable recipients), `launch_awarded: Mapping<String, bool>` (set true on first successful launch award, persists through `unpublish` to close the republish-farming vector).
- `publish(domain, metadata_uri, visibility, owner: Option<Address>, modded_from: String, is_moddable: bool, is_dev_signer: bool)` — guarded/scored phone path. First publisher owns the domain; re-publishes preserve `info.owner` + `info.publisher` and only mutate `visibility` + `metadata_uri`. `owner = Some(...)` is rejected here; phone/mobile callers publish as themselves. `is_dev_signer` remains on the ABI for client compatibility but is ignored.
- `publish_dev(domain, metadata_uri, visibility, owner: Option<Address>, modded_from: String, is_moddable: bool)` — ungated dev-signer path. Only the known CLI dev signer (`0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20`) may call it. `owner = Some(user_h160)` is allowed so dev-signer deploys still appear under the user, but this method never awards deploy XP and never increments/awards source-app mod credit. It still records app metadata and on-chain lineage.
- `star(domain)` — permanently stars an app and awards star XP to the owner once per voter/domain. Self-star and double-star revert.
- Read methods: `get_app_count`, `get_apps`, `get_domain_at`, `get_metadata_uri`, `get_owner`, `get_points`, `get_top_builders(start, count)` (single sorted descending page), `get_mod_count`, `get_star_count`, `has_starred`, `get_point_breakdown` (one round-trip total + Launch/Mod/Star derivation), `is_blacklisted`, `is_pinned`, `get_pinned_apps`, `get_visibility`, `get_lineage_count`, `get_lineage(start, count)`.
- Sudo/admin: `set_blacklisted(accounts: Vec<Address>, value: bool)`, `pin`/`unpin`, `admin_set_username`, `admin_clear_username`, `admin_set_username_bonus`, `admin_set_deploy_award_count`, and `admin_set_app_social_counts`. These mutate bucket-specific state so totals and leaderboard indexes stay in sync. Sudo-only: `add_admin`/`remove_admin`, `set_frozen`, and the migration imports `import_app` / `import_apps` / `import_pinned` / `import_lineage` / `import_points` / `import_social_counts` / `import_usernames`.

### Non-obvious contract invariants

- **NEVER use `Option<T>` where `T: IS_DYNAMIC` in a `#[pvm::method]` signature.** `pvm_contract::abi::Option<T>` declares `HEAD_SIZE = 32 + T::HEAD_SIZE` (64 bytes for `Option<String>`), but viem (the TS SDK encoder) writes a Solidity dynamic tuple `(bool, string)` as a single 32-byte offset slot. The dispatcher advances `__offset` 32 bytes further than viem writes, and every parameter after the offending Option reads from misaligned bytes — silent corruption, no revert, just wrong boolean values landing in the contract. `Option<Address>` is fine (both halves static, 64 bytes inline either way). Workaround: use plain `String` / `Vec<T>` with `""` / `vec![]` as the "no value" sentinel (see `modded_from` on `publish`).
- **Launch awards fire ONCE per domain, ever.** Tracked by `launch_awarded`. `publish → +100 → unpublish → publish` rolls `app_count` forward but does NOT re-award. The marker persists through `unpublish` exactly so this farming vector stays closed; even a new owner re-claiming a previously-rewarded domain earns nothing for the launch class. Unpublish does remove the app-scoped star/mod XP recorded on that app.
- **Dev-signer mode is a separate method, not a trusted calldata flag.** `is_dev_signer` remains on `publish` for client compatibility but is ignored. Dev-signer deploys must call `publish_dev`, which derives authorization from `env::caller()` matching the known CLI dev signer. Known dev signer recipients and sudo/admin-blacklisted recipients silently no-op out of `try_award`; when `try_award` returns false, NO point event is emitted.
- **Mod-credit dedupe is keyed on `caller`, not `owner_addr`.** On the scored `publish` path, keying dedupe on `owner_addr` would let one PoP-bounded signer publish N mods of the same source with N throwaway H160s as `owner` and farm N mod credits for the same source. Caller is the actual on-chain signer (sybil-bounded by mobile PoP). `publish_dev` bypasses source-app mod count/XP entirely.
- **Point events use SCALE-encoded typed payloads, not raw domain bytes.** Six events (`DeployPointAwarded`, `PlaygroundPublishPointAwarded`, `ModdablePointAwarded`, `ModPointAwarded`, `StarPointAwarded`, `StarPointRefunded`) carry a struct (recipient + domain, or recipient + source + modder + mod_domain). Legacy events (`Published`, `Unpublished`, `VisibilityChanged`, `Pinned`, `Unpinned`) still emit raw UTF-8 domain bytes. (`Rated`/`RatingRemoved` were retired with the rating feature; the frontend keeps their decoders only so historical events from a pre-redeploy contract still resolve.) `src/App.tsx`'s dispatcher branches on the `TYPED_PAYLOAD_EVENTS` set and delegates decoding to `src/scaleDecode.ts::decodeFirstDomainAfterAddress` — the typed payloads start with a 20-byte `Address` and the first `String` field is what the UI needs to refresh.
- **`OrderedIndex::range(_, _, offset, limit)` short-circuits empty when `limit == 0`.** Don't call `get_top_builders(start, 0)` expecting "everything from start"; you'll get `[]` regardless of how many entries exist.
- **Re-publishing preserves `info.owner` + `info.publisher`.** Only `visibility` and `metadata_uri` are mutable after first publish; ownership is immutable to block hostile rewrites. Re-publish from the original `publisher` (dev signer in dev-mode flows) succeeds via `is_authorized_to_republish`, but the same caller cannot `unpublish` or flip visibility — those gate on `is_authorized`, which is owner-or-sudo/admin only.

### Smoke-testing the contract on `@staging`

`scripts/smoke-test-points.ts` predates the `publish` / `publish_dev` split. Its old setup model used one staging dev signer plus `owner: Some(...)` to simulate many users; that no longer exercises scored publishes because `publish` rejects owner override and `publish_dev` intentionally awards nothing. If you revive it, use real per-user/mobile signers for scored flows and reserve `publish_dev` assertions for lineage/no-XP behavior. To redeploy with a local source change:

1. Swap the `cdm = "..."` annotation on `mod playground_registry` to `@staging/playground-registry`.
2. `rm -f target/playground-registry.* && pnpm build:contracts` (force-rebuild).
3. `playground contract deploy --signer dev --suri "<your dev signer mnemonic>"` (use a dedicated, low-value staging key — not your production signer).
4. `playground contract install @staging/playground-registry` to refresh `cdm.json` + `.cdm/*.d.ts`.
5. Read the new `version` + `address` from `cdm.json` and update `STAGING_ADDR` in `scripts/smoke-test-points.ts`.
6. Swap the source back to `@w3s/playground-registry`.
7. `pnpm tsx scripts/smoke-test-points.ts` — 50/50 expected.

The smoke test uses `waitFor: "finalized"` and explicit `gasLimit` / `storageDepositLimit` overrides because successive txs each read state immediately after the previous one (and a long serial sequence can outrun the auto-estimator). Production frontend reads are best-block by default — no override needed.

**Data Flow**: Frontend calls contract via `@dotdm/cdm` (reads `cdm.json` for address/ABI) → queries on-chain storage → fetches metadata JSON from Bulletin IPFS in parallel → renders list in reverse index order (newest first).

**Container-only delivery.** `@parity/product-sdk-bulletin` reads route through the Polkadot host's preimage subscription, not a public IPFS gateway — outside Polkadot Desktop / Polkadot Mobile, `BulletinClient.fetchJson` and `fetchBytes` throw `BulletinHostUnavailableError`. The registry grid degrades to placeholder icons and missing metadata in plain browsers. Discovery is expected to flow through the host — the app is designed to be opened from inside Polkadot Desktop or Polkadot Mobile.

**Key config**: `cdm.json` holds contract address, ABI, and chain endpoints (Paseo Asset Hub + Bulletin IPFS). Generated/updated by `cdm install` and `cdm deploy`.

## Sentry telemetry

- DSN: supplied at build time via `VITE_SENTRY_DSN` (CI reads it from the `SENTRY_DSN` GitHub Actions secret in `deploy-frontend.yml` / `release.yml`). Unset/empty disables Sentry, so local dev/builds run without it unless set in `.env.local`. The DSN is publish-only — public-safe, but kept out of the source tree.
- Spec: [sentry-instrumentation.md](sentry-instrumentation.md).
- Attribute prefixes: `journey.*` (page-load, authenticate, publish, rate-app), `chain.tx`/`chain.query`, `bulletin.upload`/`bulletin.fetch`, `tx.cancelled`.
- Back up any Sentry dashboard via the org API before modifying it — Sentry's API replaces the entire widget array on PUT with no undo. See `sentry-instrumentation.md` for the script template.

---

# cargo-pvm-contract Reference

A Rust framework for writing smart contracts that compile to PolkaVM on Polkadot. Contracts are `#![no_std]` / `#![no_main]` and compile to RISC-V PolkaVM bytecode. Uses nightly Rust.

## Contract Definition

```rust
#![no_main]
#![no_std]

use pvm_contract as pvm;

#[pvm::contract(cdm = "@org/contract-name")]
mod my_contract {
    use super::*;
    // constructors, methods, errors...
}
```

**`#[pvm::contract]` attributes:**
- `cdm = "@namespace/name"` — Register with CDM (enables cross-contract lookup via registry)
- `"path/to/Interface.sol"` — Optional Solidity interface file for ABI

Rust `snake_case` method names automatically convert to Solidity `camelCase` in the generated ABI.

## Constructor

```rust
#[pvm::constructor]
pub fn new(param: u32) -> Result<(), Error> {
    Storage::my_field().set(&param);
    Ok(())
}
```

Must return `Result<(), Error>`. Called once at deploy time. Parameters are ABI-encoded in calldata (no selector).

## Methods

```rust
#[pvm::method]
pub fn my_method(arg1: u32, arg2: String) -> u64 {
    // ...
}

#[pvm::method]
pub fn fallible_method() -> Result<u32, Error> {
    // Err(e) triggers revert with e.as_ref() bytes
    Ok(42)
}
```

- Return `Result<T, Error>` for methods that can revert
- Return `T` directly for infallible methods
- `#[pvm::method(rename = "customName")]` to override the Solidity name

## Fallback

```rust
#[pvm::fallback]
pub fn fallback() -> Result<(), Error> {
    Err(Error::UnknownSelector)
}
```

Called when calldata < 4 bytes or selector doesn't match any method.

## Storage

```rust
use pvm::storage::{Lazy, Mapping};

#[pvm::storage]
struct Storage {
    count: u32,                              // becomes Lazy<u32>
    owner: [u8; 20],                         // becomes Lazy<[u8; 20]>
    balances: Mapping<[u8; 20], u128>,       // stays Mapping
    approvals: Mapping<([u8; 20], [u8; 20]), bool>,  // composite tuple key
}
```

The `#[pvm::storage]` macro transforms fields into storage accessors on the struct.

**Lazy\<V\> (single values):**
```rust
Storage::count().get()        // -> Option<V>
Storage::count().set(&value)
Storage::count().exists()     // -> bool
Storage::count().clear()
```

**Mapping\<K, V\>:**
```rust
Storage::balances().get(&key)           // -> Option<V>
Storage::balances().insert(&key, &val)
Storage::balances().remove(&key)
Storage::balances().contains(&key)      // -> bool
```

**Composite keys** use tuples: `Mapping<(A, B), V>`, `Mapping<(A, B, C), V>`. Storage keys are keccak256-hashed from SCALE-encoded data.

You can define **multiple storage structs** for organization:
```rust
#[pvm::storage]
struct Workers { profiles: Mapping<Address, String> }

#[pvm::storage]
struct Tasks { items: Mapping<[u8; 32], TaskData>, count: u64 }
```

You can also store cross-contract references in storage:
```rust
#[pvm::storage]
struct Contracts {
    reputation: reputation::Reference,
    disputes: disputes::Reference,
}
```

## Supported Types

| Rust Type | Solidity Type | Notes |
|-----------|--------------|-------|
| `bool` | `bool` | |
| `u8` - `u128` | `uint8` - `uint128` | |
| `i8` - `i128` | `int8` - `int128` | |
| `U256` | `uint256` | from `alloy_primitives` |
| `I256` | `int256` | from `alloy_primitives` |
| `Address` | `address` | from `ethereum_types`, 20 bytes |
| `[u8; N]` | `bytesN` | N in {1,2,4,8,16,20,32} |
| `String` | `string` | dynamic, requires alloc |
| `Vec<u8>` | `bytes` | dynamic, requires alloc |
| `Vec<T>` | `T[]` | dynamic array |
| `[T; N]` | fixed array | |
| `(T1, T2)` | `tuple` | |
| `Option<T>` | `(bool, T)` | encoded as bool+value tuple |

## Custom Structs with SolAbi

For **return types / method parameters** (Solidity ABI encoding):
```rust
#[derive(pvm::SolAbi)]
pub struct TaskData {
    pub id: [u8; 32],
    pub owner: Address,
    pub status: u8,
    pub budget: u64,
    pub title: String,
}

#[pvm::method]
pub fn get_task(id: [u8; 32]) -> TaskData { ... }
```

For **storage values** (SCALE encoding):
```rust
use parity_scale_codec::{Encode, Decode};

#[derive(Default, Clone, Encode, Decode)]
struct Review {
    rating: u8,
    comment: String,
}
```

These serve different purposes — `SolAbi` is for the external ABI, `Encode`/`Decode` is for on-chain storage serialization.

## Error Handling

**Never use `.expect()` or `.unwrap()` in contracts.** A panic produces a generic "contract trapped" error with no useful information. Always use `revert()` with a descriptive message so callers know what went wrong.

Define a custom Error enum inside or outside the contract module:
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Unauthorized,
    InsufficientBalance,
}

impl AsRef<[u8]> for Error {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Unauthorized => b"Unauthorized",
            Self::InsufficientBalance => b"InsufficientBalance",
        }
    }
}
```

Or use the `common` crate's `revert` (preferred — see Common Library below):
```rust
use common::revert;
revert(b"Unauthorized");
```

## Cross-Contract Calls

There are two ways to reference other contracts depending on whether they're in the same workspace or external.

### Same-workspace contracts (Cargo path dependency)

When contracts are in the same Cargo workspace, add a direct path dependency:

```toml
# counter-writer/Cargo.toml
[dependencies]
counter = { path = "../counter" }
```

The dependency contract's `#[pvm::contract(cdm = "...")]` annotation automatically generates a module with `cdm_reference()`:

```rust
#[pvm::method]
pub fn write_increment() {
    let counter = counter::cdm_reference();
    if let Err(_) = counter.increment() {
        revert(b"IncrementFailed");
    }
}
```

### External contracts (cdm::import!)

For contracts published to the CDM registry (not in your workspace), use `cdm::import!`:

```rust
cdm::import!("@polkadot/reputation");
cdm::import!("@polkadot/disputes");
cdm::import!("@polkadot/contexts");
```

This requires:
1. The `cdm` crate as a dependency in Cargo.toml: `cdm = { workspace = true }`
2. The contracts installed via CLI: `cdm i -n paseo @polkadot/reputation @polkadot/disputes @polkadot/contexts`
3. A `cdm.json` in the project root (created/updated by `cdm install`)

**What happens at compile time:** The `cdm::import!` macro reads `cdm.json` to find the package, resolves the ABI from `~/.cdm/<targetHash>/contracts/<package>/<version>/abi.json`, and generates a typed module with a `Reference` struct and `cdm_reference()` function — identical to what same-workspace contracts produce.

After importing, usage is the same regardless of which method was used:
```rust
let rep = reputation::cdm_reference();
if let Err(_) = rep.submit_review(context_id, reviewer, entity, rating, comment) {
    revert(b"SubmitReviewFailed");
}
```

The module name is derived from the package name: `@polkadot/reputation` → `reputation`, `@org/my-contract` → `my_contract`.

### CallError handling

Cross-contract calls return `Result<T, CallError>`. **Never use `.expect()` or `.unwrap()` on these** — a panic produces a useless "contract trapped" error. Always revert with a descriptive message:

```rust
// Preferred — concise with revert:
let count = match counter.get_count() {
    Ok(val) => val,
    Err(_) => revert(b"GetCountFailed"),
};

// Exhaustive matching when you need to distinguish error types:
match disp.open_dispute(context_id, entity_id, claimant, against, evidence, rule) {
    Ok(val) => val,
    Err(e) => match e {
        pvm::call::CallError::Reverted => revert(b"CallReverted"),
        pvm::call::CallError::Trapped => revert(b"CallTrapped"),
        pvm::call::CallError::TransferFailed => revert(b"TransferFailed"),
        pvm::call::CallError::OutOfResources => revert(b"OutOfResources"),
        pvm::call::CallError::Unknown => revert(b"UnknownCallError"),
    },
}
```

### Storing references for later use

References can be stored in storage and retrieved in methods instead of calling `cdm_reference()` each time:

```rust
#[pvm::storage]
struct Contracts {
    reputation: reputation::Reference,
    disputes: disputes::Reference,
}

// In constructor:
Contracts::reputation().set(&reputation::cdm_reference());
Contracts::disputes().set(&disputes::cdm_reference());

// In methods:
let rep = match Contracts::reputation().get() {
    Some(r) => r,
    None => revert(b"ReputationNotInitialized"),
};
if let Err(_) = rep.submit_review(...) {
    revert(b"SubmitReviewFailed");
}
```

## Low-Level API

Available via `pvm::api` (re-exported from `pallet_revive_uapi`):

```rust
pvm::caller()                              // -> Address (20 bytes)
pvm::api::value_transferred(&mut buf)      // native token sent with call (32 bytes LE)
pvm::api::now(&mut buf)                    // current block timestamp in seconds (32 bytes LE)
pvm::api::address(&mut buf)               // contract's own address (20 bytes)
pvm::api::hash_keccak_256(input, &mut out) // keccak256 hash
pvm::api::deposit_event(&topics, &data)    // emit event (manual topic construction)
pvm::api::return_value(flags, &data)       // return/revert with data
pvm::api::call(flags, addr, ref_time, proof_size, deposit, value, input, output) // low-level call
```

**Flags:** `ReturnFlags::empty()` (success), `ReturnFlags::REVERT`, `CallFlags::empty()`, `CallFlags::ALLOW_REENTRY`

## Common Patterns

**Access control:**
```rust
if pvm::caller() != Storage::owner().get().unwrap() {
    revert(b"Unauthorized");
}
```

**Counter/index pattern (simulating iterable collections):**
```rust
let idx = Storage::count().get().unwrap_or(0);
Storage::items().insert(&idx, &item);
Storage::count().set(&(idx + 1));
```

**Reading transferred value:**
```rust
let mut buf = [0u8; 32];
pvm::api::value_transferred(&mut buf);
let amount = u128::from_le_bytes(buf[..16].try_into().unwrap());
```

**Transferring native tokens:**
```rust
fn transfer(to: &Address, amount: u128) {
    let mut value = [0u8; 32];
    value[..16].copy_from_slice(&amount.to_le_bytes());
    let deposit = [0u8; 32];
    let mut out: &mut [u8] = &mut [];
    let _ = pvm::api::call(
        CallFlags::empty(), to.as_fixed_bytes(),
        0, 0, &deposit, &value, &[], Some(&mut out),
    );
}
```

**Getting current timestamp:**
```rust
let mut buf = [0u8; 32];
pvm::api::now(&mut buf);
let seconds = u64::from_le_bytes(buf[0..8].try_into().unwrap());
```

**no_std heap types (when needed):**
```rust
extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
```

## Cargo.toml Setup

Workspace root:
```toml
[workspace]
resolver = "2"
members = ["contracts/*"]

[workspace.dependencies]
cdm = { git = "https://github.com/paritytech/contract-dependency-manager", rev = "<sha>" }
pvm_contract = { git = "https://github.com/paritytech/cargo-pvm-contract", rev = "<sha>" }
polkavm-derive = "0.31"
parity-scale-codec = { version = "3.7", default-features = false, features = ["derive"] }
picoalloc = "5.2"
```

Per-contract:
```toml
[lib]
path = "lib.rs"

[[bin]]
name = "my_contract"
path = "lib.rs"

[dependencies]
pvm_contract = { workspace = true }
polkavm-derive = { workspace = true }
parity-scale-codec = { workspace = true }
picoalloc = { workspace = true }
# Add if using cdm::import! for external contracts:
cdm = { workspace = true }
# Add for same-workspace cross-contract calls:
other_contract = { path = "../other_contract" }
```

---

# Common Library (`common` crate)

Shared types and utilities used across contracts. Add as a dependency: `common = { path = "../path/to/common" }` (or via workspace).

## Core Types

```rust
pub type UUID = [u8; 32];
pub type EntityId = UUID;    // Identifier for any entity (task, agreement, user, etc.)
pub type ContextId = UUID;   // Identifier for a context (namespace owned by a contract)
```

These are all `[u8; 32]` aliases. The distinction is semantic — `ContextId` identifies a namespace, `EntityId` identifies something within one.

## Helpers

```rust
use common::{revert, generate_id, EntityId, ContextId, UUID};

// Revert with message (cleanly reverts all state changes)
revert(b"Unauthorized");

// Generate deterministic ID from a counter nonce
let id: UUID = generate_id(count);  // nonce stored in bytes 24..32
```

## Math: RunningAverage

For computing incremental averages (used by reputation and disputes for vote tallying):

```rust
use common::math::RunningAverage;

let mut avg = RunningAverage::new();
avg.update(None, Some(200));        // Add new rating of 200
avg.update(None, Some(100));        // Add another
avg.update(Some(200), Some(150));   // Replace 200 with 150
avg.val()        // -> current average as u8
avg.n_entries()  // -> count of entries
avg.sum()        // -> sum of all values
```

`RunningAverage` derives `Encode + Decode + Clone + Default` so it can be stored in contract storage directly.

---

# Context-Aware System Contracts

The ecosystem includes shared "system contracts" that any app contract can integrate with. These are generic, context-scoped services deployed once and used by many apps.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 contexts contract                │
│          (@polkadot/contexts)                    │
│   Maps ContextId -> owner Address               │
│   "First registration wins"                     │
└──────────────┬──────────────────┬───────────────┘
               │                  │
       ┌───────┴───────┐  ┌──────┴────────┐
       │  reputation   │  │   disputes    │
       │(@polkadot/    │  │(@polkadot/    │
       │  reputation)  │  │  disputes)    │
       │               │  │               │
       │ Scoped by     │  │ Scoped by     │
       │ (ContextId,   │  │ (ContextId,   │
       │  EntityId)    │  │  EntityId)    │
       └───────────────┘  └───────────────┘
               ▲                  ▲
               │                  │
       ┌───────┴──────────────────┴───────┐
       │         Your App Contract        │
       │      (e.g. @yourorg/gigs)        │
       │                                  │
       │  1. Registers a ContextId        │
       │  2. Delegates to reputation/     │
       │     disputes as context owner    │
       └──────────────────────────────────┘
```

**Key concept:** An app contract registers a `ContextId` with the contexts contract, becoming its owner. It then calls reputation/disputes as the context owner, which those contracts verify via `contexts.is_owner(context_id, caller())`. All data is scoped by `(ContextId, EntityId)` so multiple apps share the same system contracts without data collision.

## Contexts Contract (@polkadot/contexts)

The base registry. A context is simply a `ContextId -> owner Address` mapping.

**Methods:**
- `register_context(context_id: ContextId)` — Claim a context ID (first-come-first-served, caller becomes owner)
- `get_owner(context_id: ContextId) -> Address` — Query owner
- `is_owner(context_id: ContextId, address: Address) -> bool` — Verify ownership

**Typical pattern:** An app contract derives its context ID from its own address in the constructor:
```rust
#[pvm::constructor]
pub fn new() -> Result<(), Error> {
    let mut addr = [0u8; 20];
    pvm::api::address(&mut addr);
    let mut context_id: ContextId = [0u8; 32];
    context_id[..20].copy_from_slice(&addr);

    if let Err(_) = contexts::cdm_reference().register_context(context_id) {
        revert(b"RegisterContextFailed");
    }
    Storage::context_id().set(&context_id);
    Ok(())
}
```

## Reputation Contract (@polkadot/reputation)

Manages reviews and ratings scoped by `(ContextId, EntityId)`.

**Methods (context owner only):**
- `submit_review(context_id, reviewer: Address, entity: EntityId, rating: u8, comment_uri: String)` — Add or update a review.
- `delete_review(context_id, reviewer: Address, entity: EntityId)` — Remove a review (swap-and-pop)

**Query methods (anyone):**
- `get_rating(context_id, reviewer: Address, entity: EntityId) -> u8`
- `get_review_at(context_id, entity: EntityId, index: u64) -> Review`
- `get_metrics(context_id, entity: EntityId) -> Metrics` — `{ average: u8, count: u64 }`

Ratings use the full `u8` range (0-255). Frontend maps to stars via factor of 51 (1 star = 51, 5 stars = 255).

## Disputes Contract (@polkadot/disputes)

Manages the full lifecycle of disputes scoped by `(ContextId, EntityId)`.

**Dispute lifecycle:** `OPEN → EVIDENCE_SUBMITTED → VOTING → RESOLVED` (auto-resolves after 4 votes).

**Instructions** are per-context templates defining dispute types: `RULE_BINARY` (0/1 vote, decision by majority) or `RULE_RANGE` (0-255 vote, decision by average).

**Methods (context owner only):** `add_instruction`, `open_dispute`, `submit_counter_evidence`, `begin_voting`, `provide_judgment`, `delete_dispute`.
**Methods (anyone):** `cast_vote(context_id, dispute_id, value: u8)`.
**Query methods (anyone):** `get_dispute_status`, `get_decision`, `get_vote_count`, `get_dispute_info`, `get_instruction_count`, `get_instruction`, `get_total_dispute_count`, `get_dispute_at`.

---

# CDM (Contract Dependency Manager) Reference

CDM handles building, deploying, versioning, and interacting with PVM smart contracts on Polkadot.

## CLI Commands

```bash
cdm build                              # Build all contracts
cdm build --contracts counter writer   # Build specific contracts
cdm deploy -n <chain>                  # Build + deploy + register on chain
cdm deploy -n <chain> --bootstrap      # Also deploy the ContractRegistry first
cdm deploy -n <chain> --suri "//Bob"   # Custom signer
cdm i -n <chain> @org/contract         # Install contract (latest version)
cdm i -n <chain> @org/contract:3       # Install specific version
cdm template shared-counter            # Scaffold from template
cdm init                               # Generate keypair, save to ~/.cdm/accounts.json
cdm account map -n <chain>             # Map account for Revive pallet (required before first deploy)
cdm account bal -n <chain>             # Show balances
```

**Chain presets:** `paseo`, `preview-net`, `polkadot`, `local`, `custom`

## Workflow

### Building

`cdm build` detects PVM contracts via Cargo metadata, builds them in dependency order, and outputs to `target/`:
- `{name}.release.polkavm` — bytecode
- `{name}.release.abi.json` — Solidity-compatible ABI
- `{name}.release.cdm.json` — CDM package metadata

### Deploying

`cdm deploy -n <chain>` does build → deploy → publish metadata → register:

1. **Build** all contracts in topological dependency order
2. **Deploy** to Asset Hub via `Revive.instantiate_with_code` (dry-runs for gas estimation first)
3. **Publish metadata** to Bulletin chain → gets an IPFS CID
4. **Register** in on-chain ContractRegistry: maps `@org/name:version → (address, CID)`

Use `--bootstrap` on first deploy to a chain to deploy the ContractRegistry itself.

### Installing (for consumers)

`cdm install` (alias `cdm i`) fetches published contract ABIs for use from Rust or TypeScript:

```bash
cdm i -n paseo @polkadot/reputation @polkadot/disputes @polkadot/contexts
```

This:
1. Queries the on-chain registry for version, address, and metadata CID
2. Fetches ABI from IPFS
3. Saves to `~/.cdm/<targetHash>/contracts/<library>/<version>/abi.json`
4. Updates `cdm.json` with contract address, ABI, version, and CID
5. Generates `.cdm/cdm.d.ts` TypeScript type augmentations
6. Ensures `tsconfig.json` includes `"./.cdm/**/*"`

After installing, contracts are available via:
- **Rust:** `cdm::import!("@polkadot/reputation")` → gives `reputation::cdm_reference()`
- **TypeScript:** `cdm.getContract("@polkadot/reputation")` → gives typed `.query()` / `.tx()` handle

## TypeScript Client (@dotdm/cdm)

```typescript
import { createCdm } from "@dotdm/cdm";
import cdmJson from "../cdm.json";

const cdm = createCdm(cdmJson);
const counter = cdm.getContract("@example/counter");

// Read-only:
const result = await counter.getCount.query();   // { success, value, gasRequired? }

// State-changing:
await counter.increment.tx();                    // { txHash, blockHash, ok, events[] }

// With overrides:
await counter.increment.tx({
  signer: customSigner,
  origin: "5GrwvaEF...",
  value: 1000n,
  gasLimit: { refTime: 500000n, proofSize: 100000n },
  storageDepositLimit: 1000n,
});

cdm.destroy();
```

**ABI → TypeScript type mapping:** `uint8/16/32` → `number`, `uint64+` → `bigint`, `address` → `HexString`, `string` → `string`, `bool` → `boolean`, `bytes` → `Binary`, `bytesN` → `FixedSizeBinary<N>`, `tuple` → `{ field: type }`.

---

# Product context: playground.dot

The summary below captures the product mechanics that affect frontend / contract decisions. Some of this is fixed by the contract; the rest is product-defined UX behaviour that the registry contract assumes.

## What playground.dot does

playground.dot is a mobile-first quest platform: a developer opens it, picks a tutorial or sample app, mods it (with or without AI assistance), and deploys their own version live on Polkadot via the CLI or RevX browser IDE. Time-to-first-deploy from a cold start is targeted at about thirty minutes, with no prior Polkadot experience.

## App structure: three tabs

| Tab | Purpose |
|---|---|
| **Playground** | Quest-forward onboarding. Tutorial hero, sample apps, how it works, ideas to try |
| **Apps** | Registry browser. All deployed apps, search, category filters, sort options, featured section |
| **Profile** | Personal hub. Deployed apps, starred apps, rank, storage info, name |

**Tab naming:** the registry tab is **"Apps"** — **not** "dAppStore", "store", or "dApp store". Pinning badge is **"Pinned"** — **not** "Staff pick".

## How the pieces fit together

This repo is one of several. The frontend in `src/` is the three-tab app; the contract in `contracts/registry/` is the on-chain index. The user-visible flow stitches together other components:

| Component | Role in the flow |
|---|---|
| **playground-app** (this repo) | Three tabs (Playground / Apps / Profile), App Detail Page, publish pipeline |
| **playground CLI** (`playground`, alias `pg`) | Local IDE path: `playground login`, `playground mod`, `playground build`, `playground deploy --playground`, `playground decentralise`, `playground logout`, `playground update` |
| **RevX** | Browser IDE; opens via deep-link `revx.dev/editor?mod=<domain>` |
| **`@parity/product-sdk-*` (Product SDK)** | All chain interactions go through these packages. Depends at runtime on Nova Spektr's `@novasamatech/host-api` + `@novasamatech/product-sdk` (TrUAPI — the low-level host transport, a separate project from the Product SDK) |
| **Bulletin Chain** | Decentralised storage for app metadata, icons, frontend assets |
| **DotNS** | `.dot` domain reservation during publish |
| **Polkadot app + PoP** | Sign-in via QR scan; provisions session keys; PoUD/PoP enable PGAS claims |

## Network

The contract address in `cdm.json` targets Paseo Asset Hub. Bulletin Chain is the parallel storage layer. The contract address will change as networks migrate; if a code/config change pins the network, treat that as a deliberate choice rather than an inference from the current default.

Bulletin storage is time-limited and requires renewal — time-bound deployments encourage active curation. The Profile storage widget reflects this for developers who deploy on real Polkadot.

## The registry contract: methods, events, scope

The frontend reads the registry via `@dotdm/cdm`. Key on-chain features: cumulative stars, on-chain XP balance, `mod_count` counter, top-builders index, dev-signer blacklist, claimed usernames, anti-farming sentinels, and lineage tracking via `get_lineage` / `get_lineage_count`.

**Events emitted** (the frontend subscribes to all of these — see `EVENT_NAMES` in `src/App.tsx`):
- Legacy bare-domain payloads: `Published`, `Unpublished`, `VisibilityChanged`, `Pinned`, `Unpinned`. (`Rated`/`RatingRemoved` are retired — no longer emitted; the frontend retains their decoders for historical events.)
- Typed SCALE payloads: `DeployPointAwarded`, `PlaygroundPublishPointAwarded`, `ModdablePointAwarded`, `ModPointAwarded`, `StarPointAwarded`, `StarPointRefunded`.

**The frontend should be event-driven** — re-render the grid when these events arrive rather than polling.

**Stars are binary, one-way, permanent.** `star_count` is cumulative per app, never an average. Self-starring is forbidden at the contract level. Each star transfers a fixed amount of XP from the system to the app owner.

**Modded-from is BOTH off-chain Bulletin metadata AND an on-chain lineage edge.** The CLI/UI passes `modded_from` as a transient publish parameter. On the scored `publish()` path, the contract uses it to award the "your app is modded" XP to the source owner and update `mod_credited`; on the dev-signer `publish_dev()` path, it records lineage only. In both cases the contract records each `(child, source)` edge in `lineage_at` with per-domain dedupe. Read methods `get_lineage_count()` and `get_lineage(start, count)` page the edge list oldest-first.

**`mod_count` counter** per app — incremented when a new app is published with `modded_from` pointing to it. Per-`(modder, source_domain)` dedupe via `mod_credited` prevents farming.

All point/star award functions are **internal-only** — no externally callable path adds to a user's balance outside the prescribed flows.

**Pinning** is managed via code/CLI — no admin UI. `Pinned`/`Unpinned` events drive frontend ordering. Badge says **"Pinned"**.

**Admin hard delete** is via sudo/admin only, not exposed to owners. Owners get a visibility toggle (hide/show) instead — hidden apps disappear from the Apps grid but remain in Profile and reachable at their `.dot` URL.

## PoP auth + session key model

Sign-in is **never** described as "wallet" in the product — it's an **account**. The flow:

1. User taps sign-in → desktop shows a QR; mobile triggers the Polkadot app directly.
2. Scanning authenticates via PoP (Proof of Personhood) and creates a **session key** locally.
3. The session key is pre-loaded via a single `host_request_resource_allocation([BulletinAllowance, StatementStoreAllowance, SmartContractAllowance])` call: one authorisation dialog, then the session flows without interruption.
4. From that point until logout, the publish flow + on-chain interactions are signed by the session key. The user is never asked to top up, fund, or manually acquire tokens.

A brief QR scan explanation is shown before sign-in: "You'll need the Polkadot App on your phone — this is how you prove you're a real person."

`playground logout` (CLI) signs out, notifies the mobile app, and cleans up the local session.

The frontend should not present fee-acquisition UX — the session key model means fees are invisible to the user. If you find yourself designing a "buy tokens" or "top up" flow, something has gone wrong upstream.

## PGAS and fees

**PGAS (People Gas)** is a burnable sufficient asset on Asset Hub that covers all on-chain actions — DotNS registration, registry calls, contract deploys, stars, visibility toggle. Claimed via a ZK ring-VRF proof of personhood — privacy-preserving, sybil-resistant, no prior token ownership required.

**PoUD → PGAS flow:** downloading the Polkadot App automatically grants PoUD → can claim PGAS via the mobile app. `host_request_resource_allocation([SmartContractAllowance])` at session start → phone submits claim → PGAS in product account → all transactions paid automatically.

**Claim path vs spend path:** PGAS claiming uses a runtime-V5 extrinsic and is handled by the mobile app, not the CLI/Product SDK. Spending PGAS is V4 and works everywhere. **Batching transactions breaks PGAS fee payment** — the publish flow must remain as sequential individual transactions.

## The publish flow (5 steps, all paid by the session key)

| # | Step | UI message | Package |
|---|---|---|---|
| 1 | Upload frontend assets + metadata to Bulletin | "Uploading to Bulletin..." | `@parity/product-sdk-bulletin` |
| 2 | Reserve `.dot` domain on Polkadot Hub | "Registering your .dot domain..." | DotNS via `@parity/product-sdk-contracts` |
| 3 | Register on the playground registry | "Publishing to playground registry..." | `@parity/product-sdk-contracts` (this repo's contract) |
| 4 | Live URL ready | "Your app is live at `yourapp.dot.li`." | Local |
| 5 | Share link ready | "Share: `playground.dot/app/yourapp.dot`" (copyable) | Local |

Internally Bulletin upload and registry publish run in parallel; the user-facing pipeline preserves the 5-tick mental model. Per-step plain English error messages — never hex revert codes. Retries are safe: Bulletin uploads deduplicate by content, DotNS skips if already owned, registry updates existing entry. Re-deploys show "Updating myapp.dot" not "Publishing myapp.dot".

**Account switch during publish:** if the user switches accounts mid-publish, abort with `Account changed mid-publish — please re-run from the new account`.

**Publish validation:** domain uniqueness (enforced at the DotNS contract level — first on-chain transaction wins) and required fields (domain, metadata).

**PublishModal:** admin-only. Used by staff for adding test/dummy apps. Not shown to regular users — the CLI is the primary publish path for developers.

## Content tiers in the registry

Three tiers all live in the same contract; the frontend differentiates them via pinning + App Detail Page variant.

**Tier 1 — Structured tutorial.** A single multi-level tutorial (currently "Decentralised Rock Paper Scissors"), pinned, with a step-by-step level list on its App Detail Page.

**Tier 2 — Sample apps.** Each is its own repo, pinned. Each sample app must be moddable (public GitHub repo required). Naming convention: `sample-[appname]-app`. Sample app READMEs include open-ended **quest ideas** (no formal `quests.json` — quest ideas are README prose).

**Tier 3 — Participant apps.** Everything modded and deployed by users. Shown below pinned items.

An **empty/starter template** is pinned alongside the tutorial and sample apps for blank-canvas builds.

## XP and stars

Two separate concepts that are easy to conflate. Points are referred to as **XP** throughout.

**XP = leaderboard score (Top Builders).** Stored on-chain as a per-account running balance. XP only ever goes up.

| Action | XP | Notes |
|---|---|---|
| Each of the first three deploys | 100 | Each of the owner's first three AWARDED public deploys earns `DEPLOY_XP = 100`; gated by `deploy_award_count < DEPLOY_REWARD_COUNT` (3). Deploys that award nothing (dev-signer, private, or an already-launched domain) don't consume a slot. |
| Fourth+ deploy | 0 | Reward shifts entirely to social signal (stars + mods received). |
| Star received | 10 | `STAR_RECEIVED_XP`. Per star awarded to your app. |
| Someone mods your app | 50 | `MOD_RECEIVED_XP`. Strongest single-signal award. Dedupe per `(modder, source_domain)` so the same modder can't credit the same source twice. |
| Username claimed | 25 | `USERNAME_BONUS_XP`. One-time, on first `set_username`. |

**First-N-deploys, not a tutorial flag.** Earlier scoring rewarded "tutorial completion" with 100 XP via a per-deploy `is_tutorial: bool` flag — gameable (any caller could set it `true` and farm 100 XP per deploy). The current approach: a per-account `deploy_award_count` on the registry contract that counts deploy AWARDS actually granted (hard-capped at `DEPLOY_REWARD_COUNT = 3`), paired with a per-domain `launch_awarded` sentinel so any given domain can mint launch XP only once, ever. Ungameable on the contract side (a counter is a counter), and PoP gating bounds the remaining alt-account risk.

**Contract vs displayed values:** there is no display multiplier. The contract stores XP at face value (`DEPLOY_XP = 100`, `MOD_RECEIVED_XP = 50`, `STAR_RECEIVED_XP = 10`, `USERNAME_BONUS_XP = 25` — all in `contracts/registry/lib.rs`), and `Leaderboard.tsx` renders the on-chain `score` / `account_points` directly. The earlier 10×-smaller raw scale was removed in the #286 absolute-value refactor. `get_point_breakdown` returns the star/mod buckets as COUNTS (not XP); `PointsBreakdown.tsx` multiplies those counts by `XP_VALUES.starReceived` / `XP_VALUES.modReceived` for display, reads the total straight from chain, and no longer uses `launch_points` (always 0 — `get_owner_app_count` gates the deploy achievement). `src/xpValues.ts` is the single source of truth for these amounts.

**Stars = what users award to other apps.** Binary, one-way, permanent. GitHub-style model — one star per app, cumulative count displayed, never average. Self-starring is forbidden. Unlimited per user — no allocation cap. Each star earns the app owner 10 XP. Stars also serve as personal favourites.

**Leaderboard:** `Leaderboard.tsx` reads `get_top_builders(0, 20)`, renders the on-chain `score` directly (no multiplier), and highlights the connected user's own rank.

## Profile tab

The Profile tab is the personal hub:
- Deployed apps (My Apps view)
- Starred apps
- Rank (Leaderboard tab); My Profile shows total XP via `PointsBreakdown.tsx`
- Storage info
- Display name — see precedence below

## Display names

**Precedence** (implemented in `src/utils/username.ts::displayNameForAccount`):

1. **Registry username** — claimed by the user via the in-app `SetUsernameModal`. Stored on the registry contract via `set_username`. Lowercase-normalised, case-insensitive uniqueness enforced by the reverse-index `username_to_owner`.
2. **Wallet name from host** — the OS-level account label the user set in their Polkadot mobile app. Read via Host API at runtime. No on-chain footprint.
3. **Truncated H160** — fallback, e.g. `0x4a3b…f2d1`.

`SetUsernameModal` is wired into `AccountPanel.tsx` and owns the optimistic-claim lifecycle. The modal is stateless w.r.t. the tx — validates / probes availability, hands off `onConfirm(name)` to the parent, dismisses immediately so the host-app sign prompt is the visible activity.

**Prompts to upgrade:**
- **First star** — auto-open `SetUsernameModal` on first star action when no registry username is claimed (pre-fills with current display name; dismissible — star proceeds either way).
- **Leaderboard banner** — "Listed as [current name] — change?" — when the logged-in user appears on the leaderboard without a registry username.

## RevX deep-link contract

`revx.dev/editor?mod=<domain>&quest=<level>`

- `mod=<domain>` — required. The `.dot` domain of the source app to clone.
- `quest=<level>` — only for the tutorial. RevX reads `quests.json`, checks out the right branch, loads the per-level AI skill.
- **Single "Open in RevX" button per app** — applies to tutorial, sample apps, and participant apps alike.

RevX downloads the source as an HTTPS tarball — same as the CLI — so no git or `gh` is required to start. After load: PoP auth, AI chat pre-loaded with the template's `CLAUDE.md` + Product SDK skills, and a CLI bridge that maps RevX UI actions to `playground build`, `playground deploy --playground`.

RevX also accepts `?prompt=<url-encoded-text>` (clears project, loads starter Rust template, opens `src/starter.rs`, activates `polkavm` skill, auto-submits the prompt) and companion params `?import=<cid>`, `?example=<name>`, `?fresh=1`.

## CLI deep-link contract (`playground mod`)

The CLI's `playground mod` command downloads the source as an **HTTPS tarball** via `codeload.github.com` — no git, no `gh`, no clone. Forms:

- Interactive picker: `playground mod` (lists moddable apps only)
- Direct: `playground mod <domain>`

After download, `setup.sh` runs and its output is kept visible/logged. `playground mod` writes the source domain into deploy metadata; at publish time the CLI passes it as the transient `modded_from` parameter. Mobile/scored publishes call `publish()` and award the source owner the "your app is modded" XP; dev-signer publishes call `publish_dev()` and record lineage without source-app mod XP/count. The "Modded from: domain" lineage rendered on the App Detail Page reads from the off-chain Bulletin metadata blob; on-chain lineage edges are queryable via `get_lineage`.

Subsequent commands: `playground build` (auto-detects Rust/Solidity/EVM contracts + frontend, picks the package manager, installs if missing), `playground deploy --playground` (full 5-step pipeline).

`playground login` covers first-time setup: QR auth, session key, dependency install, funding, account mapping, Bulletin allowance.

`playground decentralise <url>` lets users point at any live static site and get back a `.dot` URL on Bulletin.

CLI binary is `playground` with short alias `pg`. Both are interchangeable.

## Moddable default flow

`playground deploy --playground` defaults to moddable. An app is moddable iff its Bulletin metadata has `repository` set to a public GitHub URL. Non-moddable apps still get DotNS + Bulletin links; they just can't be cloned by others.

**Spelling note:** the product term is **moddable** (two d's). Watch for legacy "modable" (one d).

## quests.json shape (tutorial only)

Only the tutorial ships a `quests.json` — it's the manifest RevX reads to check out per-level branches and load per-level AI skill files (`.claude/skills/level-N-*.md`). Sample apps do NOT have a `quests.json` — quest ideas in their README are plain text inspiration.

**Schema:**

```json
{
  "schema_version": 1,
  "track_id": "unique-track-id",
  "title": "App Name",
  "description": "Brief description",
  "quests": [
    {
      "id": "quest-id",
      "title": "Quest Title",
      "difficulty": 1,
      "estimated_minutes": 15,
      "branch": "quest/branch-name",
      "required_tools": ["playground-cli"],
      "ai_skill_hints": [".claude/skills/skill-file.md"],
      "teaches": ["concept 1", "concept 2"],
      "summary": "What the developer will do and mod",
      "acceptance": ["Specific, testable criterion 1", "..."]
    }
  ]
}
```

## Product SDK packages

Treat these as Polkadot's equivalent of viem + wagmi. All chain interactions in this app should go through them. **Two distinct upstream projects to keep straight:**

- **`@parity/product-sdk-*`** — the Product SDK. Dapp-facing, supersedes `@polkadot-apps/*`. The umbrella package is `@parity/product-sdk`.
- **`@novasamatech/host-api` + `@novasamatech/product-sdk`** — TrUAPI, the low-level host transport that the Product SDK consumes as a runtime dep. **Not** a rebrand of the Product SDK — a separate Nova Spektr project.

| Package | Used for | Eth equivalent |
|---|---|---|
| `@parity/product-sdk-chain-client` | Typed multi-chain API client (PAPI 2.0) | viem / ethers.js |
| `@parity/product-sdk-contracts` | Typed contract interactions (Solidity + ink!/PVM) | ethers.js Contract / viem getContract |
| `@parity/product-sdk-signer` | Multi-provider signer manager | wagmi connectors / web3-onboard |
| `@parity/product-sdk-bulletin` | Bulletin upload/retrieve | web3.storage / nft.storage |
| `@parity/product-sdk-statement-store` | Pub/sub on Statement Store | XMTP / Waku |
| `@parity/product-sdk-host` | Host container detection (Polkadot Desktop/Mobile) | — |
| `@parity/product-sdk-keys` | Hierarchical key derivation, session keys | ethers.js HDNode / Safe session keys |
| `@parity/product-sdk-storage` | KV storage with host/browser backend detection | localStorage abstraction |
| `@parity/product-sdk-tx` | Tx submission + lifecycle watching | ethers.js signer / viem walletClient |
| `@parity/product-sdk-address` | SS58/H160 encoding, validation, conversion | ethers.js utils |
| `@parity/product-sdk-crypto` | Symmetric encryption, key derivation, NaCl ops | ethers.js crypto utils |

The SDK ships with `skills/` AI context files compatible with Claude Code, Cursor, Windsurf, Copilot, and Gemini. These are copied into all templates and sample apps via `playground-app-template`.

## Out of scope

- Building from scratch (entry is always tutorial / sample app / empty starter — not precluded but not promoted)
- Multiple structured tutorials (one is the canonical structured tutorial)
- DeFi quests (regulatory)
- Comments / reviews on apps
- Permanent deletion by owners (visibility toggle only; admin hard delete is admin-only)
- Account creation outside the Polkadot app / PoP flow
- Contract-modding on mobile (mobile is intended for UI-only quests)
- Embedded AI chatbot (external link only — desktop host sandbox restriction)
- Display name generation (no adjective-noun generator, no Bulletin storage for names). Precedence is registry username → wallet name → truncated H160.

## Vocabulary the product uses

The product is consistent about its language. UI copy, error messages, docs, and command names use:

| Concept | Term used | Avoided |
|---|---|---|
| Taking on a challenge | accept a quest / join a quest | "try", "attempt", "do" |
| Modifying an app | mod (verb and noun) | "remix", "fork", "clone" |
| The modified version | your mod / your app | "your fork", "your remix" |
| Full deploy + publish | `playground deploy --playground` | "ship" |
| Publishing to the registry | deploy / publish | "submit", "upload", "release" |
| Open-ended modding challenge | quest idea | "hackathon", "challenge" |
| Working apps with quest ideas | sample apps | "templates", "starter apps" |
| Completing a quest | complete / ship | "finish", "hand in" |
| User identity | account | "wallet" |
| Deployment network | Polkadot Hub | "mainnet" (sparingly); never "Paseo" in user-facing copy |
| Host ↔ product transport layer | TrUAPI | "TruAPI", "Host API", "triangle-js-sdk", "host-api" |
| App others can mod | **moddable** (two d's) | "modable" (one d) |
| Leaderboard score | **XP** | "points" (legacy term) |
| The registry browser tab | **Apps** | "dAppStore", "store", "dApp store" |
| Pinned-app badge | **Pinned** | "Staff pick" |
| Stars display | **cumulative count** | average X.X / 5 (never) |
