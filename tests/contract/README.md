# Layer (b) — Contract tests against a local revive-dev-node

These tests exercise the registry contract directly via RPC against a local
[`revive-dev-node`](https://docs.polkadot.com/smart-contracts/dev-environments/local-dev-node/).
No iframe, no host shell — just contract behaviour. Catches bugs in the
contract's storage layout, cross-contract calls (`@polkadot/contexts` +
`@mock/reputation`), and auth checks faster + more granularly than the
Layer (a) E2E suite can.

## Why TypeScript here (deviation from TESTING_PLAN.md's "cargo test")

The plan's original Layer (b) decision was Rust + cargo test. That made sense
when `cargo-pvm-contract` main shipped `MockHost` for native unit tests
(<100ms per test). The `cargo-pvm-contract` revision pinned in `Cargo.toml`
does not yet have `MockHost` — all tests must run against a real
`revive-dev-node` over RPC. At wire-level, Rust subxt and TypeScript
polkadot-api are equivalent; TypeScript here means we reuse the existing
Vitest harness + polkadot-api deps already in the project, with no new
toolchain.

Migrate back to native Rust unit tests when cargo-pvm-contract's CDM
integration lands on main (Path C in the plan — post-Summit).

## Prerequisites

1. **Build the revive-dev-node binary** (one-time, ~30 min):
   ```bash
   git clone https://github.com/paritytech/polkadot-sdk.git ~/Code/polkadot-sdk
   cd ~/Code/polkadot-sdk
   cargo build -p revive-dev-node --bin revive-dev-node --release
   # → ~/Code/polkadot-sdk/target/release/revive-dev-node
   ```

2. **Build the playground-registry contract** (every change to `contracts/`):
   ```bash
   pnpm build:contracts
   # → target/playground-registry.release.polkavm + target/playground-registry.release.abi.json
   ```

3. **Run the dev-node** in a separate terminal (port 9944 by default):
   ```bash
   ~/Code/polkadot-sdk/target/release/revive-dev-node --dev
   ```

4. **Deploy the contracts to local dev-node** (per dev-node restart):
   ```bash
   cdm deploy -n local --bootstrap --suri "//Alice"
   ```
   This deploys the ContractRegistry, then registry + its dependencies
   (`@polkadot/contexts`, `@mock/reputation`) and updates `cdm.json` with
   a new "local" target hash + contract addresses.

## Running the tests

```bash
pnpm test:contract
```

Tests connect to `ws://localhost:9944` by default. Override via the
`CONTRACT_RPC_URL` env var.

Tests use the **first target hash** found in `cdm.json` — so when both
`paseo` and `local` are present, ensure the local one is at the front
(or strip the Paseo entry before running locally). For CI, only the
local target is present.

## What the tests cover

Per TESTING_PLAN.md Layer (b) — happy paths, boundary, error, and a
small set of property-style assertions. See the [TESTING_PLAN.md Layer (b)
section](../../e2e/TESTING_PLAN.md#layer-b-contract-tests--by-category)
for the full coverage matrix and the queued-but-not-yet-implemented backlog
#1 work.

## Why these aren't run by default `pnpm test`

The default Vitest run (`pnpm test`) covers Layer (c) + (d) — fast,
no chain dependencies, ~2s wall-clock. Layer (b) tests need a running
dev-node + deployed contracts, so they live in a separate Vitest
project (`contract`) and are opt-in via `pnpm test:contract`. CI runs
them in a dedicated job that handles the dev-node lifecycle.
