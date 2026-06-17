# playground.dot

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

A registry browser for .dot apps on Polkadot. Lists apps published to the `@example/playground-registry` contract on Paseo, with infinite scroll and a mod (clone) flow.

## Development

```bash
pnpm install
pnpm dev
```

## Build & Deploy

```bash
pnpm build:frontend      # TypeScript compile + Vite build → dist/
pnpm build:contracts     # Build PVM contracts via CDM
pnpm deploy              # Deploy contracts to Paseo
pnpm deploy:frontend     # Deploy dist/ to a Bulletin-hosted .dot domain
                         # (the bundled command targets `playgroundtest.dot` —
                         # edit it in package.json to point at your own .dot)
```

Rust contracts require nightly toolchain (configured in `rust-toolchain.toml`).

For the full deployment walk-through — prerequisites, account mapping, env vars, and verification steps — see [DEPLOY.MD](DEPLOY.MD).

## Security status

This is experimental, proof-of-concept code developed and published by
Parity. It is not a Parity product or service — Parity does not operate,
host, or endorse downstream deployments of it, and downstream operators
adopt updates at their own discretion. It has not undergone external
security audit. Treat it as a starting point for your own builds rather
than as production-ready infrastructure, and do **not** depend on it
from another codebase as a security-bearing dependency.

For vulnerability disclosure, see the
[paritytech org SECURITY policy](https://github.com/paritytech/.github/blob/main/SECURITY.md).

## License & verification

This project is licensed under the [GNU General Public License v3.0 or later](LICENSE). Every `.ts`, `.tsx`, and `.rs` file must carry the standard Parity GPL-3.0-or-later SPDX header — this is enforced by the `License Headers` GitHub Actions workflow on every PR.

```bash
pnpm typecheck             # tsc -b — fast type-check
pnpm lint:license          # check headers (CI runs the same)
pnpm lint:license --fix    # prepend the header to any source file missing it
pnpm test:e2e              # Playwright suite (currently paused in CI; run locally)
```

Run `pnpm typecheck` and `pnpm lint:license` before committing. If you add a new source file under `src/`, `e2e/`, `scripts/`, or `contracts/`, run `pnpm lint:license --fix` to add the header automatically.

## Contract

The app reads from the `@example/playground-registry` contract, which stores:

- `.dot` domain names
- Metadata URIs (IPFS CIDs on Bulletin containing `{ repository }`)
- Owner addresses

## Stack

- React 19 + TypeScript + Vite
- `@parity/product-sdk-contracts` for contract queries
- `@parity/product-sdk-address` for address display
- Rust / PolkaVM smart contract (built with `cargo-pvm-contract`)

## Telemetry

Sentry is configured in [`src/sentry.ts`](src/sentry.ts) and enabled only when a DSN is supplied via `VITE_SENTRY_DSN` (DSN is public-safe; it only allows sending events). CI reads it from the `SENTRY_DSN` GitHub Actions secret and passes it into the frontend build. Local `pnpm dev` / `pnpm build:frontend` runs with Sentry disabled unless you set `VITE_SENTRY_DSN` in `.env.local`.

Wired up:

- Four user journeys (`page-load`, `authenticate`, `publish`, `rate-app`) with milestones, visible under `op:journey.*` in Sentry → Performance
- Spans on chain queries / transactions and Bulletin uploads
- Breadcrumbs on UI / user / admin actions
- Sectional `Sentry.ErrorBoundary` (`root`, `app-detail`, `my-apps`, `publish-modal`) — a crash in one section doesn't blank the whole app
- Hashed H160 as `user.id` so errors group per account
- Rate-limited capture (1/min/source) for chain WebSocket decode and subscription errors

Visit `?test-sentry=1` for an in-app diagnostic page that emits sample errors, breadcrumbs, and journeys on demand — useful for first-deploy verification.

Not yet configured: source maps upload (`@sentry/vite-plugin`) and a `release` identifier. Both are needed before prod debugging is meaningful — minified stack traces and uncorrelated deploys make the dashboard hard to use otherwise. Session Replay is intentionally disabled (mobile-first 4G + pending privacy review).
