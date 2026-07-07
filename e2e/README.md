# Playground-app E2E tests

Playwright + [`@parity/host-api-test-sdk`](https://github.com/paritytech/host-api-test-sdk) end-to-end tests for the playground-app web UI.

## How it works

The SDK embeds the dev-server build of playground-app inside a host iframe, injects a signer account via the Spektr protocol, and auto-signs every transaction. Tests interact with the iframe via Playwright, then verify outcomes against the on-chain registry on Paseo Asset Hub.

## Run locally

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test:e2e             # headless
pnpm test:e2e:ui          # Playwright UI
pnpm test:e2e:headed      # visible browser
```

The `webServer` block in `playwright.config.ts` boots `pnpm dev --port 5173` automatically.

## Signing identity

The signer is selected once at module load by `e2e/accounts.ts`:

| `E2E_FUNDER_SEED` env var | Signer used                | Notes                                                                                |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| set                       | dedicated E2E funder       | The CI mode. Funder must be funded on Paseo Asset Hub. (One balance — substrate ss58 and Ethereum h160 forms point at the same account once `Revive.map_account()` has linked them; `setup.ts` handles mapping.) |
| unset                     | `//Alice` (local fallback) | Read-only tests work *if the fixture is already registered*. Write tests are skipped. |

CI sets the env var from a GitHub Actions secret. Locally it is unset by default.

**Why a dedicated funder rather than //Alice as canonical**: Alice is shared with every other suite + script in the Polkadot ecosystem, so her balance is perpetually at risk of unrelated drains, and Paseo's faucet refuses to refill well-known dev accounts. The funder is a fresh, isolated address — faucet-friendly. //Alice still works as a local-dev fallback because read tests don't sign anything.

The choice is env-based, **not** balance-based — there is no auto-fallback to Alice if the funder runs dry. The canary in `funder.ts` opens a GitHub issue when balance dips, prompting a human to top up rather than silently switching identities mid-suite (which would muddle test results).

The funder needs a single balance on Paseo Asset Hub. Substrate ss58 and Ethereum h160 addressing forms point at the same account once `Revive.map_account()` has linked them, so funding the account once covers both Revive contract calls (publish / rate / unpublish) and the underlying tx fee / storage deposit on `Revive::call`. `setup.ts` calls `ensureSignerMapped()` idempotently on first run.

Faucet at https://faucet.polkadot.io/?network=pah.

## Fixture data

The read-only fixture domain is **`playground-e2e-app.dot`** — a domain *we* publish ourselves via `setup.ts` on first run, signed by the funder. Subsequent runs find it already registered and skip the publish.

The metadata template lives at `e2e/fixture-metadata.json`. Detail tests assert on the exact strings from this file — if you edit the metadata, also update the assertions, *or* re-publish the domain so on-chain matches the file again. `setup.ts` will throw with a clear message if the on-chain CID has drifted from the local file.

Caveat: the first publish requires the SIGNER to be a funded, h160-mapped account. Locally (with the //Alice fallback), this can't succeed — Alice's balance is too unreliable. Rely on CI to do the initial publish; once it's on-chain, local runs find it and read tests work.

Write tests (`rate.spec.ts`, `my-apps.spec.ts`, `events.spec.ts`, `unpublish.spec.ts`, `mobile-signer.spec.ts`) require the funded SIGNER — see "Write tests — preconditions" below.

## What's covered

Desktop project (`chromium`):

| Spec                    | Status              | Coverage                                                                                                                                       |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `browse.spec.ts`        | active (6)          | Cards render, fixture domain visible, all-pill default-active, tag pill switches active state, all-pill restores default, tag filter hides every card with a different tag |
| `detail.spec.ts`        | active (8)          | Opens via card click, closes via close button, closes via backdrop, exact name + description + repo (visible text + data-href), readme renders to HTML (asserts `<h1>` and rejects raw markdown), exact `dot mod` command, exact `https://` href + `target="_blank"` + `rel="noopener noreferrer"`, exact tag |
| `a11y.spec.ts`          | active (1) + skip (1) | Home grid passes axe-core (no serious/critical violations). Detail panel skipped — surfaces a known colour-contrast issue on `--color-text-tertiary` (#57534e on #161412 = 2.4:1, WCAG AA needs 4.5:1) |
| `events.spec.ts`        | active (1)          | Server-side publish surfaces in the recents grid via the iframe's event subscription, no reload — catches regressions in `Published` event wiring that the my-apps reload-then-assert flow would mask |
| `rate.spec.ts`          | active (1)          | Submitting 5 stars records the SIGNER's per-rater rating as 5 (deterministic regardless of prior raters). Covers the current `@mock/reputation` mechanic — superseded by stars when backlog #1 ships. |
| `mobile-signer.spec.ts` | active (6)          | Mobile signer flow via the test SDK's RFC-0009 helpers: login success, login reject, post-login signing (rates fixture, asserts signing log), permission rejection during signing, mid-session disconnect, reconnect after disconnect. Mocks login outcomes; the actual QR/PoP attestation is not exercised (needs a real phone). |
| `my-apps.spec.ts`       | active (4)          | Connected account text is a registry username or deterministic generated fallback, never the raw wallet label/H160; publish button is hidden for non-admins (admin gate from PR #163); freshly published domain appears in My Apps grid; visibility toggle to Private removes from recents + keeps in My Apps with "Private" badge; toggle back to Public restores. The visibility-toggle tests were previously `test.fixme`'d under a "descriptors out of sync" diagnosis (PR #142, closed) — re-enabled here after fixing the productAccounts wiring root cause. |
| `unpublish.spec.ts`     | active (1)          | Contract-level publish → unpublish → re-publish cycle on a throwaway domain. Verifies the entry is gone after `unpublish` and that re-publishing surfaces fresh metadata — catches regressions in `Mapping::remove` storage clearing (the bug fixed in `cargo-pvm-contract` PR #64). |

Mobile project (`mobile-chrome`, Pixel 7 viewport):

| Spec                       | Status      | Coverage                                                                          |
| -------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `mobile-smoke.spec.ts`     | active (2)  | Home grid renders the fixture card; detail panel opens. Tripwire for mobile-first layout regressions without doubling the desktop chain query load. |

Total: 32 active, 1 skipped (the second a11y test, pending fixture wiring).

## Signing modes

The suite exercises two distinct host signing paths the playground app supports:

| Mode | Surface | Covered by |
|---|---|---|
| **Dev signer** | Account pre-injected into the test host via the `accounts:` + `productAccounts:` config in `e2e/fixtures.ts`. Skips the RFC-0009 login flow; every tx is signed directly by the funder. Matches the CLI's `--suri //Alice` developer path. | All specs except `mobile-signer.spec.ts` |
| **Mobile signer** | No account pre-injected. The product issues an RFC-0009 login request on auto-connect; the test host's `setLoginBehavior` resolves it; after login, signing uses the post-login (session-key style) path. Mirrors the Polkadot mobile-app PoP flow. | `mobile-signer.spec.ts` |

The QR-scan + on-phone PoP attestation step is **not** exercised — that requires a real phone and is the one piece the test SDK can't simulate (it mocks the outcome, not the cryptography). Everything from the login-result delivery onward IS exercised.

## productAccounts wiring (read this before debugging "tx never resolves")

The playground app signs every action via `getProductAccount(PLAYGROUND_DOTNS_ID)` — an app-scoped derived keypair, not the user's primary account. The test fixtures MUST map that dotNsId to a funded account via `productAccounts:`, otherwise the test host derives `//Bob//<dotNsId>/<index>` as a fallback and write tests silently hang at `signSubmitAndWatch` (unfunded account → tx dropped → promise never settles).

If a write test hangs and you can't tell why, check `e2e/fixtures.ts` — the `productAccounts` map must contain a `${PRODUCT_DOTNS_ID}/0` entry pointing at the SIGNER. PR #142 spent a day debugging this as a "descriptors out of sync" issue before it was correctly diagnosed as a `productAccounts` wiring bug.

## What's spec'd but not yet built in the app

The reference spec describes features that don't exist in the current app. We deliberately skip tests for them; track each as an issue and add a spec when it ships:

- [ ] Permanent star flow
- [ ] Admin pin/unpin
- [ ] Leaderboard view
- [ ] Per-app tutorial quest levels
- [ ] "Open in RevX" deep links
- [ ] Multi-step publish progress indicators (current flow uses a single status message)
- [ ] Domain-uniqueness pre-flight in the publish modal
- [ ] Search box that filters the recents grid by domain/name (input is rendered by `App.tsx` but no spec exercises it yet; add when the search UX is finalised)

## Out of scope

- **Admin Publish modal** — the in-app publish modal is admin-only since PR #163 (sudo-granted role; `registry.isAdmin` gates the button). This suite covers the **non-admin** developer experience only; the CLI is the real publish path for developers. Modal coverage will land at Layer (d) component tests when those are written — see #122.

## Write tests — preconditions

Write tests (`rate.spec.ts`, `my-apps.spec.ts`, `events.spec.ts`, `unpublish.spec.ts`, `mobile-signer.spec.ts`) need:

1. `E2E_FUNDER_SEED` set — CI uses the GitHub Actions secret of the same name; locally, `export E2E_FUNDER_SEED=<seed>` in your shell before running.
2. A funded funder account on Paseo Asset Hub — balance ≥ 10 PAS comfortably covers tx fees + storage deposits across the suite.
3. The funder mapped on Revive (`setup.ts` calls `ensureSignerMapped()` idempotently on first run).

Without these, write tests fail loudly — there is no auto-fallback to `//Alice` for write tests because Alice's balance is too unreliable.

## CI

`.github/workflows/e2e.yml` runs the suite daily at 06:00 UTC, on PRs, and on `workflow_dispatch`. The workflow:

- Reads `secrets.E2E_FUNDER_SEED` for the signer.
- Reads `secrets.GITHUB_TOKEN` and the workflow's `issues: write` permission to file low-balance issues.
- Uses a `concurrency: e2e-funder` group so two runs never sign with the funder at the same time (would collide on nonces).

## Troubleshooting

**"Out of gas" / `Invalid: Payment` on a write test** — the funder has drained. Faucet via https://faucet.polkadot.io/?network=pah.

**Detail-page assertions fail with stale strings** — `fixture-metadata.json` was edited but the on-chain entry has the old metadata. `setup.ts` will throw with the expected vs on-chain CID. Either revert the JSON or republish via a script (the registry contract allows the original publisher to overwrite by unpublish + republish).

**Tests hang after passing** — chain WebSocket leak. Verify `globalSetup`'s teardown calls `destroyTestClient()`.

**`AccountUnmapped` on the first run with a fresh funder** — `setup.ts` calls `ensureSignerMapped()` to handle this. If it fails, inspect setup logs for the underlying revive error.
