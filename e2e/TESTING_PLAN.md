# playground-app E2E testing plan

Reference document for the playground-app test suite. Captures **what** to test (4 layers × 7 categories), **when** in CI each layer runs, **patterns** to follow (especially the `paritytech/host-api-test-sdk` reference suite), and the **fixture-hygiene** requirements.

Read this when adding tests.

## Layers

| Layer | What it covers | Tooling | Roughly |
|---|---|---|---|
| **(a) E2E in Host** | playground.dot user flows running inside a Triangle Host | Playwright + `@parity/host-api-test-sdk` | ~30–40 tests |
| **(b) Contract** | `registry/lib.rs` directly (current methods + planned points/leaderboard work) | Rust unit tests + integration via revive-dev-node | ~25 tests existing surface, ~20 more once the points/leaderboard work lands |
| **(c) Util libs / hooks** | `src/utils/*` (small, pure-ish) | Vitest | ~10 tests |
| **(d) React component** | `AppDetailPanel.tsx`, lifted logic from `App.tsx` (PublishModal state machine, pagination/event reducer if lifted) | Vitest + Testing Library | ~10 tests |

Layer (a) hands off to the `host-api-test-sdk` reference suite for fixture-pattern code. Layer (b)'s queued tests sit pending until the corresponding contract work ships.

---

## Guiding principles

Four principles that determine which tests belong at which layer and how they're built:

1. **Iframe-first for anything users actually do.** Publish, rate, login, visibility-toggle UX — all driven through the iframe with `@parity/host-api-test-sdk` as the host. Test what users do, the way they do it. The product's container-only SDK is intentional; the test harness respects that by exercising it via the iframe, not by reaching past it from Node.
2. **Two signing modes are first-class.** Dev signer (pre-injected accounts, login bypassed — what the CLI does) AND mobile signer (no pre-injected accounts; login via `setLoginBehavior`; allowance via `setPermissionBehavior`). Each spec lives in one mode or the other; the suite covers both.
3. **Fixtures (and test data owned by entities the test signer isn't) come from operator-driven out-of-band setup** using the real production deploy path. Tests assert against pre-existing fixtures; they don't fake-publish them from Node. If a fixture is missing, setup fails loudly with a runbook pointer.
4. **Tests at the wrong layer move out of `e2e/`.** Contract-roundtrip tests belong at Layer (b) (revive-dev-node), event-reducer logic belongs at Layer (d). Don't let "this is sort of about the chain" justify keeping a contract test inside Playwright.

**On Node-side helpers specifically (the nuance):** Node-side code reading chain state to verify what the UI claimed is fine — it's an independent oracle, not pretending to be a user. Node-side state mutations done by the legitimate "owner" of the affected entity as test infrastructure (e.g. flipping the fixture's visibility between runs — the test signer owns the fixture) are also fine. The line that matters is **not "no writes from Node"**; it's **"don't fake user-facing flows from outside the iframe"**. Publishing throwaway domains from Node to drive UI events the iframe is supposed to observe is on the wrong side of that line; toggling visibility on a domain the test signer owns isn't.

**Don't build workarounds for upstream SDK gaps.** When `@parity/product-sdk-*`, `@parity/bulletin-sdk`, `bulletin-deploy`, or any Parity-owned tooling has a gap that breaks our tests, default to surfacing the gap to its owning team — not to building a Node-side / direct-WS / mocked alternative. A workaround makes the suite *appear* green while silently no longer exercising the path real users hit. SDK regressions become invisible.

---

## Network + auth context (post-RFC-0010)

Tests mirror the current production allowance model, not legacy directly-funded-Alice patterns. The concrete differences:

| Legacy (pre-RFC-0010) | Current model |
|---|---|
| Test account directly funded on the target chain | No direct test funding — accounts derived from PoP |
| Manual `Revive.map_account()` from test setup | **Still required temporarily** — called *after* the allowance request. Auto-mapping is a future improvement, not a current feature |
| App calls `host_request_resource_allocation` directly | SBI (service provider interface) makes the call; app consumes the allowance |
| Direct sudo authorization on Bulletin for the test signer | Slot keys allocated via People chain's `Resources.claim_long_term_storage`; host owns the slot key |

**What this means for tests:**

- The test SDK's `productAccounts` map routes `getProductAccount(dotNsId)` to the funded test account. This is *correct test SDK config*, not a workaround — the production product uses the same product-account derivation path.
- Mobile-signer tests assert allowance via `getPermissionLog()`. Bulletin allowance + PGAS balance are queryable on-chain for additional verification; Statement Store allowance is **not yet queryable** (the product uses a localStorage workaround; if cleared, the allowance is re-requested — the API handles this gracefully). Tests should not query Statement Store allowance state directly until on-chain querying ships.
- Bulletin uploads in tests happen through the iframe (via the SBI flow), not from Node. Node-side helpers that called `BulletinClient.create({ environment })` to upload metadata are anti-patterns and have been removed.
- Fixture seeding uses the same production tooling real publishes use — currently `bulletin-deploy`. Operator runs the documented command; if it doesn't work, escalate to its team (don't build a workaround).
- **PoP whitelist on networks that gate it:** when CI moves to a network that requires PoP whitelisting, the e2e funder's address needs a whitelist entry before any PoP-gated test can run. If the network migration triggers test failures with PoP-related errors on the funder, file the whitelist issue first — don't assume it's a code problem.

---

## Signing modes

Two iframe-driven signing paths the suite covers:

| Mode | What it represents | Fixture | Most specs use it |
|---|---|---|---|
| **Dev signer** | Account pre-injected into the test host via the `accounts:` + `productAccounts:` config in `e2e/fixtures.ts`. Skips the RFC-0009 login flow; signing happens directly via the funded account. Matches the developer-laptop CLI flow. | `signerFixture` | `browse`, `detail`, `a11y`, `rate`, `my-apps` (the non-admin assertion), `mobile-smoke` |
| **Mobile signer** | Product issues an RFC-0009 login request on auto-connect; test host's `setLoginBehavior` resolves it; resource allocation happens via `setPermissionBehavior`; signing post-login uses the session-key model. Mirrors the Polkadot mobile-app PoP flow. | `mobileSignerFixture` (named separately for intent + future swap-ability, currently structurally identical to `signerFixture`; the cold-start init path is exercised because every mobile-signer test starts with `testHost.page.reload()` which triggers full iframe re-init → first login request, and `simulateDisconnect()` in `beforeEach` resets host auth state between tests) | `mobile-signer.spec.ts` |

The QR scan + on-phone PoP attestation is the one thing the test SDK can't simulate (it mocks the outcome, not the cryptography). Everything from login-result delivery onward is exercised.

**Cross-cutting:** any spec that asserts on the *product's reaction* to a host event (login result, permission grant/reject, disconnect, allowance change) should drive that event via the test SDK's host API (`setLoginBehavior`, `setPermissionBehavior`, `simulateDisconnect`, `simulateReconnect`, `setPaymentBalance`, etc.). These are documented test-only entry points — they exist precisely because the real cryptography/attestation can't be exercised in CI. Using them is the supported testing path, not a workaround.

### What `mobile-signer.spec.ts` actually tests — and what it doesn't

`mobile-signer.spec.ts` is **product-code regression testing for the mobile flow** — Layer 1 of two layers worth distinguishing:

| Layer | What it tests | What's simulated | What's real |
|---|---|---|---|
| **Layer 1: product flow in simulated host** (`mobile-signer.spec.ts`) | Did the product's mobile code (signer state machine, UI transitions on login result, allowance request handling, retry logic, disconnect/reconnect UX) behave correctly given the host's responses? | Host responses (login result, allowance approval), slot key derivation | Chain interaction for the actual rate tx (real chain, real Revive call) |
| **Layer 2: testnet bootstrap mechanism** (planned — `testnet-bootstrap.spec.ts`) | Does the testnet PoP-grant API + `Resources.claim_long_term_storage` + slot-key signing flow still work end-to-end on the current testnet runtime? | None at chain level — the funder is granted PoP via the API and goes through real chain extrinsics | PoP credential, allowance claim, slot keys, Bulletin / Asset Hub writes signed by slot keys |
| **Layer 3: real mainnet flow** (manual only) | The real-user experience — phone scans QR, PoP attestation cryptography, mainnet runtime | Nothing | Everything; not automatable |

Each layer catches different regressions:
- **Layer 1 catches** product-code regressions (UI state, error handling, allowance-request wiring inside the product).
- **Layer 2 catches** testnet-mechanism regressions (chain runtime drift, extrinsic shape changes, allowance accounting breakage) — the kind of thing that would also bite the production deploy script. Worth running as a separate (slower, real-chain-writing) test surface so a runtime upgrade fails Layer 2 cleanly without polluting Layer 1's signal.
- **Layer 3 is irreplaceable** for actual user-experience verification; covered manually.

Today's plan **only has Layer 1** automated. Layer 2 is a planned addition (see Layer (a) — Tier 1 additions below). Without Layer 2, a chain-runtime change that breaks the deploy bootstrap doesn't show up in the suite at all until it bites production.

---

## Reference pattern: paritytech/host-api-test-sdk

The canonical example of E2E testing for a miniapp inside a Triangle Host is `paritytech/host-api-test-sdk/test/integration.spec.ts`. The SDK ships its own complete reference suite covering account derivation, permission grant/reject, navigation, chat, statement store. Read this when adding tests, especially for permission/navigation/account-switching flows.

**Five patterns worth copying:**

1. **Per-test fresh host** — `createTestHostServer({ productUrl, accounts, productAccounts })` inside `try / finally { await host.close() }`. Use this when a test needs a different `accounts` list, `productAccounts` mapping, or permission behaviour than our shared fixture provides. Slower per-test but enables tests we can't write today (account-switch mid-flow, multi-account, signed-out).

2. **Dual-side `evaluate()`** — `product.evaluate(() => window.__TEST_PRODUCT__.x())` drives the product (inside iframe); `page.evaluate(() => window.__TEST_HOST__.x())` inspects host-side state (`getPermissionLog`, `getNavigationLog`, `getGrantedPermissions`). Lets tests assert on what the host saw, not just what the product rendered.

3. **DOM `data-ready="true"` convention** — test product writes derived values to elements like `#root-keys[data-ready="true"]`; tests `expect(locator).toBeVisible()` then read `textContent()`. Already implicit in our suite via `data-status="done"` etc.; making the convention explicit makes new tests easier to write.

4. **`setPermissionBehavior('reject-all')`** — flips host-side permission outcomes per-test; exposes the rejection path without mocking. We have zero permission-rejection tests today.

5. **Minimal test product** — `test/test-product.ts` + esbuild bundle. Not directly relevant for testing playground.dot itself (we test the real product), but useful when a *new* SDK feature needs an isolated test surface.

**When to use which:** prefer our existing shared `testHost` fixture for tests that don't need different host configs (speed wins). Reach for the per-test fresh-host pattern only when the shared fixture genuinely can't express the scenario.

---

## CLI vs iframe boundary — what this plan does NOT cover

The spec is explicit that **the CLI (`playground deploy --playground`) is the primary publish path for developers**; the in-app PublishModal is admin-only. The playground-app iframe surfaces what happens AFTER a CLI deploy lands — the published app appearing in the registry grid, the detail page rendering its metadata, the owner toggling its visibility.

So the test coverage split is:

| Surface | Where tests live |
|---|---|
| `playground login`, `playground mod`, `playground build`, `playground deploy --playground` (CLI mechanics: tarball download, setup.sh, parallel install, 5-step publish pipeline, PoP QR + session key) | `paritytech/playground-cli` e2e suite |
| What the playground-app iframe shows post-deploy (registry grid, detail panel, account status, My Apps view, visibility toggle UI, star award UX) | This plan |
| Registry contract behaviour (publish / unpublish / set_visibility / pin / award_stars / etc.) | This plan, Layer (b) — revive-dev-node |
| RevX deep-link contract (`revx.dev/editor?mod=<domain>`) | RevX team's repo |

When this plan says "publish flow" it's shorthand for "what the iframe shows during and after a publish" — the actual CLI mechanics are upstream of us. References to `playground-cli` mean "covered there, not here". Tier 1 / Tier 2 items below that touch the publish flow are about the iframe-side observable behaviour (e.g. "newly published domain surfaces in recents grid via event subscription"), not about the CLI's pipeline working.

---

## Layer (a): E2E in Host — by user journey

> **Convention for items in this section**: each bullet describes a *behaviour to verify*, not the assertion strategy. When implementing, expand into "verify X by asserting Y on Z" — e.g., "grid renders pinned items at top" → "verify by asserting the first three `[data-testid=\"app-card\"]` elements have `data-pinned=\"true\"` in order". A loose `expect(cards.first()).toBeVisible()` doesn't satisfy the bullet on its own.

> **Status icons throughout this section**: ✓ implemented · 🟡 planned (UI exists, test pending) · 🚧 blocked on source (test waits on UI to be built) · 🔵 gated on planned contract work · ⛔ relocated (see Relocations section)
>
> The 🟡 vs 🚧 split matters: 🟡 items are ready to be written today; 🚧 items would test against unbuilt UI and would just sit red. Don't write 🚧 tests speculatively — wait for the feature to land, otherwise they fail for the wrong reason and the suite becomes noisy.

Tests organised by the user journeys defined in the V1 spec. Cross-cutting categories (adversarial inputs, integration boundaries, concurrent/temporal, permission flows, property-based candidates) sit at the end as section 7.7.

### 7.1 Discovery — browse, search, filter, detail panel

Spec: "Registry & browsing" V1 P0. User lands on playground.dot, sees the grid (pinned items at top), browses cards, searches/filters, opens detail panel, reads tutorial/sample-app info.

**Happy paths:**
- ✓ Cold load → grid renders cards from registry (`browse.spec.ts`)
- ✓ Pinned items appear first in grid order (tutorial / sample apps / empty starter) — `browse.spec.ts` asserts no `data-pinned="true"` card appears after the first `data-pinned="false"` card. Gated on at-least-one-of-each to avoid vacuous pass.
- 🚧 Onboarding copy visible on first load — *no copy in source today. V1 P0 per spec; test lands once UI ships.*
- ✓ Search by name → only matching apps shown, including filtered empty-state UI when no match (`browse.spec.ts`). Client-side filter over loaded entries (name + domain substring, case-insensitive).
- ✓ Search input tolerates regex special characters + 4KB queries without crashing — adversarial inputs tripwire (`browse.spec.ts`)
- ✓ Filter by tag → only tagged apps shown (`browse.spec.ts`)
- ✓ Moddable indicator on cards + Moddable-only filter (`browse.spec.ts`)
- ✓ Detail panel (sample-app variant): name, description, repo, readme rendered as HTML, mod command, polkadotapp link, tag (`detail.spec.ts`)
- 🚧 Detail panel (tutorial variant): 4 levels with difficulty/time/points (25 each), single "Open in RevX" button, copyable mod command per level, laptop badge on L3-4 *(depends on tutorial app being built; no tutorial-variant rendering in source today)*
- 🔵 "Modded from: [domain]" attribution on detail panel when modded-from field exists *(needs contract field AND iframe-side rendering; neither shipped today)*
- 🚧 App detail deep link (`playground.dot/app/<domain>`) — shareable URL routes to the right detail panel. *No URL routing in source today; App.tsx routes via in-memory state only. Test lands once routing UI ships.*
- ✓ Mobile-responsive layout — home grid + detail panel work on Pixel 7 (`mobile-smoke.spec.ts`)
- 🚧 Mobile path L3-4: "Continue on a laptop" badge + send-link-to-self affordance visible on phone viewport — *depends on tutorial-variant detail page; same blocker as above*
- ⛔ Event-driven UI updates (chain event arrives → grid re-renders) — relocated to Layer (d) component test for the event reducer. Layer (a) iframe-driven version blocked by SDK lacking `injectChainEvent`; see Open Questions.

**Boundary:**
- 🚧 Empty registry (zero apps) → empty state UI rendered — *not testable without controllable chain state (the live registry has many entries). Move to Layer (b) where revive-dev-node gives clean per-test state.*
- 🚧 Single app in registry → grid renders one card, no infinite-scroll trigger — *same blocker as above.*
- 🚧 Pagination: page exactly fills, page partial, request past end — *same. The contract-level invariant (concat of pages == bigger page) is a Layer (b) property test candidate; the iframe-side rendering is downstream of that.*

### 7.2 Sign-in — PoP QR, session key, allowance grant, logout

Spec: "Auth & session" V1 P0. User taps sign-in, scans QR, PoP-attests, session key created, allowances granted, app reaches connected state.

**Happy paths:**
- ✓ Login success → product reaches connected state (`mobile-signer.spec.ts`)
- ✓ QR + login flow effectively covered by `mobile-signer.spec.ts` — the iframe has NO click-to-sign-in CTA. `signer.connect()` auto-fires on mount; the Triangle host owns QR rendering and the entire login UI. The iframe-side observable state IS the post-login transition (anonymous → connected), which `mobile-signer.spec.ts` covers via `setLoginBehavior` success/reject. No additional iframe test possible until the iframe adds an explicit sign-in trigger.
- 🚧 QR explanation copy visible before sign-in — *copy not in source today; V1 P0 per spec*
- ✓ Resource-allocation request fires on login — `getPermissionLog()` contains Bulletin / StatementStore / SmartContract tags (`mobile-signer.spec.ts`)
- ✓ Post-login signing — slot key signs subsequent txs, `getSigningLog()` captures the payload (`mobile-signer.spec.ts`)

**Error paths:**
- ✓ Login reject → product stays disconnected, connect prompt visible (`mobile-signer.spec.ts`)
- ✓ Permission reject during signing → product surfaces clean error, no orphan state (`mobile-signer.spec.ts`)
- 🚧 Sign in cancelled (explicit cancel-button UI) → returns to anonymous browse, no error toast — *no explicit iframe-side cancel-button UI in source today; verify spec intent (host-driven cancel vs iframe cancel) before lifting status*

**State changes mid-session:**
- ✓ Mid-session disconnect → UI reflects unauthenticated state (`mobile-signer.spec.ts`)
- ✓ Reconnect → auth state restored (`mobile-signer.spec.ts`)
- 🚧 Logout UI behaviour in playground-app — when host triggers logout, UI reflects it. *No iframe-side logout-handling code in source today; spec calls this V1 P0. Test lands once UI ships.*

### 7.3 Account status — testnet balance + allowances + voucher

Spec: "Account status component". A reusable component showing the connected account's testnet balance, Bulletin allowance, Statement-store allowance, and voucher-redemption field.

🚧 **Component not yet built** — all tests below are blocked on source, awaiting component implementation. Icon glossary: 🟡 = UI exists, test pending; 🚧 = UI not built, test waits.

**Planned tests (write once component lands):**
- 🚧 Renders correctly post-login with all four fields populated from host state
- 🚧 Updates when allowance state changes (drive via `setPaymentBalance` / allowance grants in the test SDK)
- 🚧 Statement-store allowance field reads from localStorage workaround (per spec — chain query not yet supported)
- 🚧 Voucher-redemption field accepts a code and submits to the appropriate handler

### 7.4 My Apps — connected account + owned apps + visibility + expiry

Spec: "Mod & deploy" / "Hide / show own app" V1 P0. Signed-in user opens their My Apps tab, sees their connected account name, sees their published apps, sees Bulletin expiry countdown per app, can toggle visibility (hide/show).

**Happy paths:**
- ✓ Connected account display shows a registry username or deterministic generated fallback, not the raw wallet label/H160 (`my-apps.spec.ts`)
- ✓ Non-admin: publish button hidden (admin-gate regression catcher) (`my-apps.spec.ts`)
- ✓ Owner's apps appear in My Apps grid — `my-apps.spec.ts` asserts the fixture domain (owned by the funder via setup.ts seeding) surfaces in the My Apps grid when signed in as the funder. No throwaway publish needed; uses the pre-existing fixture.
- 🚧 Bulletin expiry countdown rendered per app (owner view) — spec calls out this UI lives in three places: CLI at publish time, My Apps countdown, App Detail Page (owner view). *No countdown UI in source today; V1 P0 per spec.*

**Visibility — mostly relocated to Layer (d):**
- ⛔ Hide own app → disappears from browse grid, stays in My Apps with Private badge — relocated to Layer (d) component test for the visibility-toggle state machine. Layer (a) iframe version requires admin-signer infrastructure (doesn't exist yet).
- ⛔ Show again → reappears in browse grid — same; Layer (d)
- 🟡 Hide an already-hidden app → idempotent (no error) — could live at Layer (a) (UI assertion only) or Layer (b) (contract idempotency)

### 7.5 Star — cumulative awards

Spec: "Star — permanent one-way" V1 P0. User awards stars to an app from the detail panel; cumulative count goes up, owner gets points.

Current state: `rate.spec.ts` covers the *current* `@mock/reputation` averaged-rating mechanic. The planned points/leaderboard work replaces this with cumulative stars.

**Currently covered (transitional — replaced by points/leaderboard work):**
- ✓ Submitting 5 stars records the signer's rating as 5 (`rate.spec.ts`) — `@mock/reputation` averaged mechanic. When the cumulative-stars contract lands, this test gets superseded.

**Planned (post-points/leaderboard work):**
- 🔵 Award 1 star → app's cumulative count +1, owner gets points
- 🔵 Award 5 stars in two calls (top up 1 → 5) succeeds
- 🔵 6th star rejected — "max 5 reached" UI
- 🔵 Self-star attempt rejected — "you can't star your own apps" UI
- 🔵 Star allocation hits 0 → button shows 0 / disabled
- 🔵 App with 0 stars sorts last (display ordering)
- 🔵 Star prompt after mod deploy — CLI surface (lives in `playground-cli` e2e suite)
- 🔵 Tutorial: just-completed L1 (state should reflect 25pts to one user but no L2-L4)

### 7.6 Standalone readonly — out-of-host browser

Spec / CLAUDE.md: outside Polkadot Desktop / Polkadot Mobile, `BulletinClient.fetchJson` and `fetchBytes` throw `BulletinHostUnavailableError`. The registry grid degrades to placeholder icons and missing metadata in plain browsers. Useful tripwire for "did we accidentally break the container-only graceful-degradation path".

✓ **Three of four planned tests built** in `standalone-readonly.spec.ts`; the fourth bullet is pending chain-client behaviour verification.

**Tests:**
- ✓ Out-of-host load (no `@parity/host-api-test-sdk` fixture; plain `page.goto()` to product URL) — page renders without crash
- 🚧 Grid renders placeholder icons for cards — *uncertain: chain-client may itself require the host transport, in which case the grid is fully empty rather than "cards with placeholder icons". Verify chain-client behaviour without host before asserting on this; if grid is empty, the assertion is "grid mounts but is empty" instead.*
- ✓ Auth-gated UI (publish-app-btn) hidden in the anonymous out-of-host path
- ✓ No uncaught exceptions / pageerrors during load

### 7.7 Cross-cutting (across journeys)

Categories of tests that span multiple journeys; each item annotated with the journey(s) it touches.

**Adversarial inputs:**
1. App name / description with Unicode (RTL, emoji, zero-width) — Discovery (detail panel render) and Star (rating comment if cumulative-stars adds one)
2. App name max-length and one-over — does the UI clamp? Does the contract? — Discovery
3. Search query with regex specials, very long (1KB+) string — Discovery
4. Tag filter with non-existent tag — Discovery
5. Quest ID in URL that doesn't exist in tutorial — Discovery
6. 🔵 Direct contract call attempting `award_stars(domain, 100)` — Star (points/leaderboard work)
7. 🔵 Direct contract call attempting `award_points(self, 1_000_000)` — Star (points/leaderboard work)

**Integration boundaries (the miniapp failure-mode catalogue):**
1. Host disconnects mid-publish → CLI/RevX shows account-changed-or-disconnected error, partial state preserved (Bulletin upload dedupes by content next run) — publish flow (CLI surface, cross-link to playground-cli e2e)
2. WebSocket to Asset Hub drops mid-event-subscription → reconnect logic, no missed events — Discovery (event-driven UI); ⛔ partly blocked on `injectChainEvent`
3. Bulletin chain unreachable → publish step 1 fails cleanly with retry — CLI surface
4. Indexer/event subscription falls behind → grid shows stale state, refresh-on-foreground reconciles — Discovery
5. Two simultaneous publishes for same domain → first wins, second sees `Domain just claimed` — CLI surface
6. Mid-flow account switch → publish aborts with `Account changed mid-publish` — Tier 1; touches Sign-in + publish (CLI); per-test fresh-host pattern needed
7. Network mismatch — user's Host on Kusama not the target chain → detect + block, "switch network" prompt — Sign-in
8. User has multiple PoP accounts and spec assumes one → which is shown in My Apps? — My Apps

**Concurrent / temporal:**
1. 🔵 Star same app from 2 accounts in same block → both succeed, cumulative +2 (points/leaderboard work)
2. Re-publish during retry storm (3x in 30s) → V1: 3 `Published` events, frontend doesn't double-count — CLI + Discovery (event handling)
3. 🔵 Star allocation hits 0 mid-session (in same browser tab) → next star button click reflects new state
4. Pin/unpin happens while user is mid-pagination → grid order shifts; refresh or "list updated" affordance — Discovery

**Property-based candidates:**
- **Domain normalisation** (`utils/contracts.ts`) — round-trip + idempotency property using **fast-check**.
- 🔵 **Rate idempotency** (once cumulative stars lands): rating the same app twice with the same star value → final state == single rating. Verifiable via Node-side oracle read against the registry.
- **Card-ordering invariants under filter changes**: applying then removing a tag filter → grid order matches the unfiltered baseline. Not a textbook property test but a sequence-invariant worth fast-check style coverage if grid-ordering bugs become recurrent.
- Most other E2E behaviour isn't property-shaped.

**Permission-flow tests (adapted from host-api-test-sdk reference):**
Audit step first: enumerate which `host-api` permission tags our publish/rate/visibility flows actually request. Then for each tag, write a grant + reject pair using the reference pattern.

1. Publish flow → permission(s) requested → granted by default → `getPermissionLog()` shows tag with `approved: true` → tx completes — CLI surface
2. Publish flow → `setPermissionBehavior('reject-all')` → permission denied → tx aborts cleanly with user-readable error → no orphan registry/Bulletin state → log shows tag with `approved: false` — CLI surface
3. Bulletin upload → Remote permission to gateway URL → granted → log shows `Remote` with the URL — CLI surface
4. (After audit) per-tag grant/reject pairs for any other tags surfaced

**Account-state tests (enabled by per-test fresh host):**
1. ✓ Signed-out user (no `accounts` array passed) → publish modal disabled / sign-in CTA shown — covered by `mobile-signer.spec.ts` (anonymous fixture); the publish-modal-disabled half is N/A since the modal is admin-only
2. Account switch mid-publish → flow aborts with `Account changed mid-publish` — Tier 1 per Priorities; per-test fresh-host pattern is what makes this implementable
3. Multiple `productAccounts` mappings → My Apps shows the correct product-derived account → no leak between accounts — My Apps

---

## Relocations from Layer (a)

Three spec files that were originally Layer (a) have been **relocated to other layers** because the assertions they actually make aren't user-facing UX — they're contract-roundtrip or component-state-machine tests dressed up in Playwright. The Node-side `publishDomain` helper they relied on was the bypass anti-pattern; moving them out of `e2e/` lets each test live at the right layer with the right tooling.

| Originally at Layer (a) | Now at | Why |
|---|---|---|
| `e2e/unpublish.spec.ts` (publish → unpublish → re-publish round-trip; verifies `Mapping::remove` storage clearing) | **Layer (b)** contract test (revive-dev-node) | Pure contract roundtrip. No iframe involvement. Catches the same bug class via the contract's own tests, faster and without test-funder authorization complications. |
| `e2e/events.spec.ts` (server-side publish surfaces in recents grid via event subscription) | **Layer (d)** component test for the event reducer | The assertion is about the event-reducer wiring inside `App.tsx`, not about user UX. Node-side publish-to-drive-event-observation was the anti-pattern; the reducer can be tested directly at component level once the relevant logic lift lands. |
| `e2e/my-apps.spec.ts` visibility-toggle tests (Public→Private and Private→Public) | **Layer (d)** component test for the visibility-toggle state machine (default) OR **rewrite at Layer (a)** with an admin signer through the actual PublishModal | The throwaway-publish step was the anti-pattern. Default rec: Layer (d) component test; promote to Layer (a) iframe rewrite if/when admin-signer infrastructure exists. |

**Kept at Layer (a)**: `browse`, `detail`, `a11y`, `rate`, `mobile-smoke`, `mobile-signer`, and the non-admin assertion in `my-apps.spec.ts` (publish-button hidden for non-admins — admin-gate regression catcher). These all drive the iframe; no Node-side bypass.

**Tests `test.fixme`'d as first-runs or pending relocation** — captured as explicit follow-ups so the CI signal stays clean. Each fixme has a per-test rationale comment; the categories are:

| Test(s) | Reason | Resolution path |
|---|---|---|
| `events.spec.ts` "newly published in recents", `my-apps.spec.ts` "freshly published in My Apps", `unpublish.spec.ts` "publish→unpublish round-trip" | Node-side `publishDomain` routes through `BulletinClient.create({ environment })` → chain-client → host transport. Throws `Host provider unavailable` in Node. | Plan says relocate to Layer (b)/(d) — write the component-test for the event reducer and the contract-test for `Mapping::remove` storage clearing. Then delete these. |
| `mobile-signer.spec.ts` "post-login signing" + "permission reject mid-session" | `waitForCardMetadata` times out 60s. Fixture-preimage seed in `beforeEach` doesn't survive `testHost.page.reload()`. | Either seed after the reload (requires bytes-export) OR raise to SDK team: should `seedPreimage` persist across page reloads? |
| `mobile-signer-login-reject.spec.ts` "stays unauthenticated" | `getIsAuthenticated()` returns true even with `accounts: []` + `setLoginBehavior("reject")` + `simulateDisconnect`. Iframe-side state IS correct (connect-prompt visible, account absent), only the host-side flag disagrees. | Confirm with host-api-test-sdk team on the intended semantics of `getIsAuthenticated()` under reject. |
| `rate.spec.ts` "submitting a 5-star rating" | First-run after un-fixme. Fails fast (~10s) in CI. Likely Node-side `getSignerRating` hitting the host-routed chain-client. | Per-test investigation; mirrors the throwaway-publish issue if confirmed (relocate to Layer b once the deploy harness lands). |

**First-run-not-regression note**: tests that were `test.fixme`'d through SDK migrations or admin-gate changes had been skipped for weeks while underlying wiring was being diagnosed. When these reappear at their target layer (b)/(d), or first actually run after un-fixme, treat them as **first-runs** rather than regression checks. Their assertions were written against earlier behaviour; first failure is most likely latent drift, not new regression. Re-check the spec for the surface and verify the assertion still verifies the right side effect before trusting them as ongoing tripwires.

---

## Layer (b): Contract tests — by category

### Test infrastructure

Layer (b) tests run against a real `revive-dev-node` (built from polkadot-sdk: `cargo build -p revive-dev-node --release`).

- ~5–10s per test (vs <100ms for native unit tests against a future `MockHost` once available upstream). Deploys registry contract + `@polkadot/contexts` + `@mock/reputation` system contracts via `Revive.instantiate_with_code` extrinsic.
- Cross-contract calls (constructor → contexts, `rate_app` → reputation) work natively; no mocking needed.
- **Property tests via `proptest` are deferred to a nightly-only job** — at ~5-10s × 256 default cases × per-test cost, full proptest runs at PR time would push wall-clock past 30 min. PR-time can run a small `PROPTEST_CASES=8` smoke if useful, but full N=256+ runs nightly.

**Future migration:** when the `cargo-pvm-contract` revision pinned in `Cargo.toml` gains `MockHost` (a future upstream change), move non-cross-contract paths to native unit tests in <100ms, keep `revive-dev-node` only for cross-contract integration. Property tests can return to PR-time at full N once individual cases run in <100ms.

### Property-test scaling

Industry-standard "low-N on PR + full-N nightly" doesn't fit cleanly when each test is ~5-10s on revive-dev-node. Options considered:

| Option | PR wall-clock impact | Tradeoff |
|---|---|---|
| Skip proptest entirely on PR; full N=256+ nightly | None on PR | Lose fast feedback on pin/unpin/pagination property regressions |
| `PROPTEST_CASES=8` on PR (very low) + full N nightly | ~1-2 min on PR | Some signal, much weaker than usual |
| Hand-rolled targeted parametrised tests on PR (replace proptest) | <1 min on PR | Loses fuzzed-input coverage entirely |

**Decision:** **Skip proptest on PR; full N=256+ nightly.** Property tests come back to PR after the migration to MockHost (where they're <100ms each). The Tier-1-must-have property tests (pin/unpin round-trip, publish/unpublish round-trip, pagination invariant, visibility-toggle last-write-wins) live in the nightly suite alongside the funder canary + light-client smoke + cross-browser matrix.

---

Tests against the **current** contract (`publish`, `unpublish`, `rate_app`, `set_visibility`, `pin`/`unpin`, admin functions). Plus a parallel set queued for once the points/leaderboard work lands.

### Layer (b) toolchain — TypeScript + Vitest, not Rust + cargo test

The plan originally specified `cargo test` + `revive-dev-node` for Layer (b). That made sense in a world where `cargo-pvm-contract` shipped `MockHost` (<100ms native unit tests). At the `cargo-pvm-contract` revision currently pinned in `Cargo.toml` there's no native test harness, so all tests must run against a real `revive-dev-node` via RPC anyway. At wire-level, Rust subxt and TypeScript polkadot-api are equivalent for that purpose — we use TypeScript here to reuse the existing Vitest harness + polkadot-api deps already in the project.

Migrate back to native Rust unit tests when `cargo-pvm-contract` gains `MockHost`.

### State isolation strategy (write tests against revive-dev-node)

The Layer (b) write tests will mutate chain state; without an explicit isolation strategy, a failing write test can corrupt downstream tests against the same long-running dev-node (e.g. publish + unpublish leaves the registry in an inconsistent intermediate state if the test aborts mid-flight).

**Adopted strategy: file-level dev-node freshness + unique-domain-per-test.**

- **Per test file:** spin a fresh `revive-dev-node` process. File = serial inside (single funder), parallel across files at the runner level (each file gets its own port + state).
- **Per test inside a file:** generate a unique `e2e-<ts>-<rand>.dot` domain. State mutations key off the unique domain so even if a test aborts mid-flight, the next test's domain isn't touched. Same pattern as `uniqueDomain()` in `e2e/accounts.ts` — reuse it.
- **Test ordering inside a file:** Vitest's default sequential per-file works; do NOT enable `concurrent` for contract tests.

This pairs with the `.skipIf(!canWrite())` gating already in `tests/contract/registry.test.ts` — when the dev-node deploy harness lands and `canWrite()` returns true, the isolation contract above is what those test bodies must respect.

### Layer (b) test runner

- `pnpm test:contract` — runs the Vitest "contract" project
- Default mode (no env var): connects to Paseo Asset Hub via plain polkadot-api; exercises read-only assertions on the deployed contract
- `CONTRACT_RPC_URL=ws://localhost:9944 pnpm test:contract` — connects to a local `revive-dev-node` for the write tests (currently `.skip`-gated pending the deploy harness)

See `tests/contract/README.md` for the full setup playbook.

### Current-contract read paths — ✓ active (8 tests, against the live chain)

`tests/contract/registry.test.ts > registry — read paths`:
- `get_app_count` returns >= 1 (fixture is published)
- `get_context_id` returns a non-zero bytes32
- `get_sudo` returns a non-zero H160 address
- `get_visibility(fixture)` returns a valid visibility byte (0 or 1) — coupling to e2e state intentionally avoided
- `get_visibility(absent)` returns VISIBILITY_PRIVATE (0)
- `is_pinned(fixture | absent)` returns a clean boolean
- `get_pinned_apps` returns a Vec<AppEntry> with the expected struct shape
- `get_owner_app_count(zero address)` returns 0

### Current-contract write paths — 🚧 scaffolded (6 .skip'd tests, awaiting deploy harness)

`tests/contract/registry.test.ts > registry — write paths (local dev-node only)`. Six tests with `.skipIf(!canWrite())` guards, real bodies still TODO. Blocked on the local-dev-node deploy harness landing in `setup.ts`:

1. publish + unpublish round-trip clears storage (a `Mapping::remove` bug class verified upstream)
2. publish with `visibility=2` reverts `InvalidVisibility` (boundary)
3. publish of an existing domain by another caller reverts `Unauthorized` (squat-protection)
4. `rate_app` on a missing domain reverts `AppNotFound`
5. `pin` as non-admin reverts `Unauthorized`
6. `set_visibility` to PRIVATE auto-unpins (cross-storage side effect)

### Current-contract happy paths (planned — extend write tests once deploy harness lands)
1. `publish()` new domain → caller becomes owner, app indexed, `Published` event
2. `publish()` existing domain by same owner → metadata updated, owner unchanged, `Published` event re-emitted (V1 behaviour)
3. `unpublish()` own domain → removed from indexes, `Unpublished` event
4. `set_visibility()` to private → app auto-unpinned if pinned (#6 scaffolded above)
5. `pin()`/`unpin()` as sudo (#5 partially — extend with happy path)
6. `add_admin()`/`remove_admin()` as sudo, then admin can pin
7. `get_apps(start, count)` returns expected page
8. `get_owner_app_count()` / `get_owner_domain_at()` per-owner

### Current-contract boundary (planned)
1. `publish` with `visibility=2` → reverts `InvalidVisibility` (#2 scaffolded)
2. `unpublish` last app → `app_count` decrements, owner indexes consistent
3. `pin` 1st, then 2nd, then unpin 1st → `pinned_count` = 1, indexes shift correctly (this is the one to property-test below)
4. `get_apps(start=app_count, count=10)` → empty page, no error

### Current-contract error paths (planned)
1. `publish` existing domain by different caller → `Unauthorized` (#3 scaffolded)
2. `unpublish` not-mine → `Unauthorized`
3. `pin`/`unpin` as non-sudo → `Unauthorized` (#5 scaffolded)
4. `set_visibility` invalid value → `InvalidVisibility`

### Property-based (PRIORITY — these are gold for the contract)
- **Pin / unpin round-trip:** for any state S and any domain D, `unpin(pin(S, D)) ≈ S` (modulo event emission). Library: `proptest`.
- **Publish / unpublish:** `unpublish(publish(S, D, m)) ≈ S` — within event emission, indexes return to original.
- **Pagination invariant:** for any (start, count), `concat(get_apps(start, count), get_apps(start+count, count2)) == get_apps(start, count+count2)` while no mutation in between.
- **Visibility toggle:** `set_visibility(set_visibility(S, D, v1), D, v2) == set_visibility(S, D, v2)` (last write wins, no leftover state).

### Concurrent / temporal
1. Two pin transactions for the same domain in one block → second is a no-op (per current code)
2. publish + unpublish + publish in same block → final state is published, no orphaned indexes
3. (Once cumulative stars lands) two `award_stars` from two accounts in same block → cumulative count +2 atomic

### Tooling environment
- **Anvil/forge would mislead**: contract is PVM, not EVM. Plan: native unit tests once available, `revive-dev-node` for integration. **Do not use Anvil.**
- **Existential Deposit:** caller must hold ED to be a valid origin. Test setup must fund all dev accounts above ED.
- **Account mapping:** dev accounts must call `Revive.map_account()` once before contract calls (we hit this in CLI tests). Setup helper.

### Points / leaderboard work — pending tests (queued for when implementation lands)
- `award_points` rejects external caller → `Unauthorized`
- `award_stars` rejects self-star → `CannotStarOwnApp`
- `award_stars(domain, 6)` rejects → `MaxStarsExceeded`
- `award_stars(domain, 5)` then `award_stars(domain, 1)` rejects (would exceed 5) → `MaxStarsExceeded`
- `award_stars` increments app's cumulative count and recipient's `account_points` atomically
- `get_points` reads what `award_points` wrote
- Unpublish + re-publish same domain → no extra deploy points awarded
- Tutorial: deploy with `(track_id, quest_id)` → points awarded once for that pair, second deploy at same level → no extra points
- Tutorial: same domain, four different `quest_id`s → 4×25 = 100 points awarded total
- **Property-based:** `award_stars` is monotonic (cumulative count never decreases)

### Relocated from Layer (a)

Originally in `e2e/` as Layer (a) Playwright specs, but the assertions they actually made are contract-level. Moved here:

- **publish → unpublish → re-publish round-trip** (was `e2e/unpublish.spec.ts`). Verifies `Mapping::remove` storage clearing.

Track these as part of Layer (b) Phase 1; the corresponding Layer (a) entries have been removed.

---

## Layer (c): Utility libs / hooks

Vitest harness landed alongside Layer (d) — see `vitest.config.ts` + `pnpm test`. Setup file at `src/test-setup.ts` (jest-dom matchers).

| File | Status | Tests |
|---|---|---|
| `utils/placeholders.ts` | ✓ active (5 tests) | `cardColorForDomain`: deterministic per-domain mapping; --cat-* palette value; distribution across set; empty-domain edge case; Unicode-domain edge case |
| `utils/hooks.ts` (`useIntersectionObserver`) | ✓ active (5 tests) | Observes when enabled; bails when disabled; callback fires on `isIntersecting=true` only; disconnect on unmount; documented rootMargin/threshold values |
| `utils/diagnostics.ts` (`stringify`) | ✓ active (8 tests) | Plain object → JSON; walks non-enumerable Error props (name/message/cause/data); omits stack; bigints → string; Uint8Array → 0x hex; circular ref → `[Circular]`; falls back to error string when serialization throws |
| `utils/contractManifest.ts` | ✓ active (6 tests) | Resolves live addresses; omits failed reads; omits None Options; overwrites manifest addresses; falls back to original when all reads fail; does not mutate input (structuredClone path) |
| `utils/contracts.ts` | ⛔ deferred | Module-load side effect (`contractsReady` IIFE calls `getChainAPI` at import time) makes unit-testing impractical without lifting. Cover via Layer (a) where the full app boots. |
| `utils/bulletin.ts` | 🟡 planned | `useIconUrl` + cache. Requires mocking `BulletinClient.fetchBytes` — moderate effort, not yet covered. |

Property-based candidate here: domain normalization (`utils/contracts.ts` if/when it's lifted).

---

## Layer (d): React component tests

| Component | Status | Tests |
|---|---|---|
| `AppDetailPanel.tsx` | ✓ active (14 tests) | Renders name/description/tag from metadata; domain-stem fallback when metadata absent; mod command shape; RevX link with `mod=` param + NO `quest=` per spec; readme rendered as sanitised HTML (marked + DOMPurify); script-tag stripping (XSS regression catcher); play-only banner when no repo; cumulative rating renders only when ratingCount>0; `data-is-owner` true/false (case-insensitive H160 match); admin pin toggle visibility; non-admin pin indicator; close-button callback |
| **PublishModal logic** (currently inside App.tsx — recommend lifting to a sibling .ts to test cleanly) | 🟡 planned (depends on the App.tsx logic lift) | 5-step state machine: progress through steps, retry-from-failed-step, retry idempotency (storage upload reuses CID, DotNS skips, registry call updates) |
| **Event reducer** (also inside App.tsx — same lift recommended) | 🟡 planned (depends on the App.tsx logic lift) | Subscribed event arrives → grid state updates correctly for `Published`, `Unpublished`, `Rated`, `RatingRemoved`, `VisibilityChanged`, `Pinned`, `Unpinned` |

The lifts aren't strictly required to test, but doing them once gives us much faster, more reliable tests than full-component renders for the same coverage.

---

## Fixture hygiene

### Fixture domain (`playground-e2e-app.dot`) — single, persistent

Used by browse / detail / a11y / rate / mobile-smoke / mobile-signer specs to assert read-only behaviour on a known-good app entry. Owner: the test signer (via the `productAccounts` mapping in `e2e/fixtures.ts`).

**Seeding (operator-driven, out-of-band):** one-time per fixture-metadata change. An operator uses the same production deploy path real publishes go through (currently `bulletin-deploy`; longer term whatever it migrates into post-PAPI-2.x upgrade). This mirrors how real frontend deploys work — the test infrastructure isn't pretending to be a user, it's leveraging the same tooling users would.

**Setup behaviour (`e2e/setup.ts`):**
- Compute the expected CID locally from `fixture-metadata.json`
- Query the registry contract for `playground-e2e-app.dot`
- If present + matching CID → continue; warm the Bulletin gateway cache for fast iframe reads
- If absent or CID drifted → fail loudly with the exact runbook command in the error message. **Setup does NOT publish from Node** — that path was the bypass; gone.

**Visibility toggle between runs:** setup flips fixture to PUBLIC at start, teardown flips back to PRIVATE at end. Done via the registry contract on Asset Hub (the test signer legitimately owns the fixture and has the right to toggle visibility — owner-side hygiene, not a user-flow bypass). This is the one Node-side chain mutation that legitimately stays in `e2e/setup.ts`.

**Race tradeoff:** with reads + writes running as parallel CI jobs, each runs its own setup→teardown. If writes finishes before reads, the PRIVATE flip can land mid-reads. Unlikely (reads is faster) but documented:
- **A. Accept the rare race.** Simple Playwright globalTeardown in both jobs.
- **B. Workflow-level cleanup job.** New `e2e-cleanup` GH Actions job, `needs: [e2e-reads, e2e-writes]`, `if: always()`.

Recommendation: **A** first; escalate to **B** if it flakes.

### Throwaway domains — pattern removed

The previous plan called for Layer (a) tests creating unique `throwaway.domain` per test via Node-side helpers, plus per-test cleanup. **This pattern is gone.** The Node-side `publishDomain` helper was the bypass anti-pattern; the three specs that depended on it have been relocated (see "Relocations from Layer (a)" above):

- `unpublish.spec.ts` → Layer (b) contract test (revive-dev-node's clean state per run; no cleanup needed)
- `events.spec.ts` → Layer (d) component test for the event reducer (no chain state involved)
- `my-apps.spec.ts` visibility-toggle tests → Layer (d) component test (default); Layer (a) iframe rewrite as an option once admin-signer infrastructure exists

If a future Layer (a) test genuinely needs a throwaway (e.g. admin publish-flow coverage once admin signing is in scope), seed it via the iframe + admin signer through the real PublishModal — never via Node-side helpers.

**Historical-cleanup tracking:** the one-time sweep of accumulated test apps from the previous pattern is tracked in the project issue tracker. Forward prevention is now baked into the architecture (no Node-side publishes from `e2e/`).

### Chicken-and-egg: deploy bootstrap problem (transitional)

Post-RFC-0010, any first-time Bulletin write requires an allowance, which requires a product account, which requires a deployed product. The bootstrap answer is in progress upstream — likely PoP Lite for a deployer account, possibly OpenGov referenda or runtime migration. Until that lands, fixture seeding via `bulletin-deploy` works **only because** the legacy sudo-bootstrapped pool path (PAPI 1.x) is still in place.

When `bulletin-deploy`'s PAPI 2.x upgrade ships, the legacy path likely closes and fixture seeding hits the same wall production deploys do. **This is a transitional state, not a permanent test-infrastructure problem.** Our test plan adopts whatever the bootstrap answer turns out to be — we don't build a parallel test-only solution.

Practically: the suite continues to run on the legacy `bulletin-deploy` for now. If the operator runbook stops working, escalate to the `bulletin-deploy` team — don't work around it.

---

## CI execution strategy

Test categories above describe **what** to test. This section describes **when in CI** each category runs.

**Every test runs at PR time** — the "tier and rely on nightly" model was explicitly rejected because manual triggers are wishful thinking and post-merge regression-catching is too late. Instead we get speed by parallelising what the funder constraint allows.

| CI job | Tests | Workers | Concurrency | Wall-clock |
|---|---|---|---|---|
| `e2e-reads` | All read-only Layer (a) tests (`browse`, `detail`, `a11y`, `mobile-smoke`, the non-admin button assertion in `my-apps`) | 3 (`--workers=3`, project `fullyParallel: true`) | None — multiple PRs run reads in parallel | ~3-5 min |
| `e2e-writes` | Layer (a) tests that perform real chain writes via the iframe path: `rate` + `mobile-signer` (post-login signing writes via slot key). The previously-listed `publish` / `unpublish` / `events` / `my-apps` visibility-toggle have all been deleted or relocated (see "Relocations from Layer (a)") — `publish` was admin-only, the others move to Layer (b) or (d). | 1 (funder nonce contention) | `e2e-funder` job-level group — only one PR's writes run at a time | ~3-5 min |
| `e2e-testnet-bootstrap` (planned — see Tier 1 below) | `testnet-bootstrap.spec.ts` only. Real chain writes via Node-side script + slot-key signing. Run nightly + on chain-runtime upgrade detection, not on every PR (slower; mechanism regression, not product regression). | 1 | None | ~3-5 min |
| `tests-fast` (future) | Layer (b) property at low N (`PROPTEST_CASES=64`); Layer (c) Vitest unit; Layer (d) Vitest component | Default | None | ~2-3 min |

**Total wall-clock per PR: ~8 min** (whichever job is longest dominates). Down from ~14-30 min sequential.

### What stays nightly

Daily 06:00 UTC cron remains, currently runs the full suite (same content as PR) — catches current-target-chain runtime drift, fixture metadata divergence, funder balance dipping. Future expansions (cross-browser matrix, light-client smoke, full-N proptest, drift detection separated out, the `e2e-testnet-bootstrap` job from above) would land here as separate jobs. The cron is network-agnostic — it follows whatever `cdm.json` points at.

### Funder constraint, made concrete

The reason writes can't be parallelised: there's one funder account, the chain assigns each of its transactions a strict `nonce` (sequence number), and the chain refuses tx N+1 until tx N has confirmed. So write tests have to run one at a time. Read tests don't sign anything → no nonce, no constraint, full parallelism.

### Retry policy

Per-layer principle:

- **Layer (a) — Playwright:** `retries: process.env.CI ? 2 : 1` in `playwright.config.ts`. E2E hits real WebSockets + real chain RPC + real Bulletin gateway; transient network/RPC flake is inevitable. Two retries in CI catches the genuine flakes without masking real failures (a retry that masks a real bug becomes visible in the retry-rate Sentry dashboard).
- **Layer (b) — Vitest contract:** `retry: 0` (Vitest default). The tests connect to a known-state local `revive-dev-node`; if they fail it's a real regression, not a network blip. A retry that flips red → green here would be hiding state-isolation bugs (see §Layer (b) state-isolation strategy above).
- **Layer (c) / (d) — Vitest unit + component:** `retry: 0` (Vitest default). Pure synchronous-ish code; no network, no race conditions a retry could "fix." Same logic as Layer (b) — retry = bug-hiding here.

The `vitest.config.ts` has retry left at default (0). If we ever consider changing it, the answer is no — file a real bug instead.

## What's NOT applicable here / explicitly skipped

Test-design scope decisions:
- **XCM tests:** registry contract doesn't do cross-chain messaging. N/A.
- **Light-client failure modes:** the dapp uses RPC (not Smoldot in this codebase per CLAUDE.md). N/A for now.
- **Property-based for E2E:** UI flows don't lend themselves to it. Keep property tests at contract + util layer.
- **Performance / load tests:** the conference will be the live load test. Out of scope unless you specifically want venue-screen stress tests.
- **Admin-only Publish modal:** the in-app publish modal is sudo-granted-admin-only. The CLI is the real publish path for developers; the modal is staff-only and intentionally not covered at Layer (a). Layer (d) component tests pick it up once the modal state machine is lifted out of App.tsx. The Layer (a) regression catcher is the non-admin assertion in `my-apps.spec.ts` that the `publish-app-btn` is hidden.
- **Unified code-coverage aggregation across layers:** Vitest has its own `--coverage` (istanbul/c8 backends) but Playwright has no native coverage and merging the two requires `nyc` / `istanbul-merge` tooling investment. Out of scope for V1. Per-layer coverage CAN be inspected individually with `pnpm test --coverage` if useful for local diagnosis, but no CI gate, no merged report, no targets.
- **Visual regression testing (VRT):** DOM assertions miss CSS-only regressions (overlap, broken layout, design-token contrast drift). Playwright's `toHaveScreenshot()` would catch these, but snapshot maintenance + font/OS-rendering flake are real costs against a still-iterating design. **Deferred to nightly-only when added** (Tier 2 — see Priorities). Candidate surfaces: empty registry state, AppDetailPanel sample-app variant, mobile grid layout at Pixel 7. Not part of the PR-gate suite.

Per the V1 spec's "Out of scope" list (see CLAUDE.md):
- **Building from scratch** (entry is always tutorial / sample app / empty starter — not precluded but not promoted; no test for "build from blank canvas" flow)
- **Multiple tutorial tracks** (one structured tutorial only)
- **DeFi quests** (regulatory; no test surface)
- **Comments / reviews on apps** (not implemented; no test surface)
- **Permanent deletion by owners** (visibility toggle only; admin hard delete is admin-only — covered at Layer (b) for the contract path)
- **Account creation outside the Polkadot app / PoP flow** (no alternative auth to test)
- **Contract-modding on mobile** (Level 1 / UI-only quests on phone; L2-4 contract-modding is laptop-only — covered as Discovery sub-journey "L3-4 mobile laptop badge", not as a positive flow)
- **Embedded AI chatbot** (external link only — desktop host sandbox restriction; no in-app surface)
- **Developer hub** (longer-term effort, separate scope; the Account status component is the only Developer-Hub-bound piece we cover here)
- **Full hackathon judging infrastructure** (admin manual verification is enough for V1)

---

## Priorities (so we can phase work if needed)

**Tier 1 — must have for V1:**
- All happy paths in (a)
- All current-contract happy + error paths in (b)
- Property tests for pin/publish round-trips in (b)
- Mid-flow account switch test in (a)
- Domain race test in (a)
- Tutorial level tagging tests in (b) — but these depend on the points/leaderboard work landing
- **Dedicated `mobileSignerFixture` naming** — see §Signing modes. Structurally identical to `signerFixture` today; named separately for intent and future swap-ability. The cold-start init concern is addressed by `testHost.page.reload()` already in every mobile-signer test.
- **`testnet-bootstrap.spec.ts` (Layer 2 of mobile signing coverage — see "Signing modes" above).** Tests the testnet deploy mechanism: granting funder PoP via the testnet API, claiming long-term-storage + smart-contract allowances via `Resources.claim_long_term_storage` on People chain, asserting slot keys exist with the expected allowances, and signing a real Bulletin upload + a real registry-contract publish using the slot keys. Probably lives in its own Playwright project (slower; real chain writes; runs less often than the main suite, e.g. nightly + on chain-runtime changes). Catches testnet-mechanism regressions before they bite the production deploy script.
  - **Prerequisites** (confirm with the deploy team before implementation starts): (1) the testnet PoP-grant API is live on the target chain and reachable from CI runners; (2) `Resources.claim_long_term_storage` extrinsic shape is stable enough to depend on across runs (or the descriptor is regenerated alongside chain upgrades); (3) the resulting slot key is usable from a Node-side script — i.e., slot-key signing of `TransactionStorage.store` (Bulletin) and `Revive.call` (Asset Hub) is accepted without further host mediation. If (1)–(3) hold, the test is straightforward; if any are pending, this test is blocked.

**Tier 2 — strong-to-have:**
- Adversarial inputs across (a) and (b)
- Integration boundary tests (Host disconnect, network mismatch, indexer lag)
- Layer (d) component / lifted-logic tests
- **Visual regression testing (VRT)** via `toHaveScreenshot()`. Nightly-only when added — see §What's NOT applicable for the rationale. Candidate surfaces: empty registry state, AppDetailPanel sample-app variant, mobile grid layout at Pixel 7.

**Tier 3 — nice to have:**
- Layer (c) utility tests (small surface, low payoff per test)
- Concurrent/temporal edges in (a)

**Mobile-viewport coverage (`mobile-chrome` Playwright project, Pixel 7 viewport)**: kept deliberately narrow — `mobile-smoke.spec.ts` only (home grid renders + detail panel opens on mobile viewport). The product is mobile-first per CLAUDE.md, so we keep a tripwire on a real mobile viewport without doubling the desktop suite's chain query load. Called out here so it doesn't drift into "deferred to Tier 3" by accident — the smoke check is part of the Tier 1 read suite.

---

## Implementation status snapshot

Quick reference for "what tests exist today vs what's planned". Update this table when status changes — one-line edit, no narrative drift.

| Spec file | Status | Layer | Journey | Notes |
|---|---|---|---|---|
| `browse.spec.ts` | ✓ active (17 tests) | (a) | Discovery | Cards render, fixture visible, all-pill default-active, tag pill activates, all-pill restores, tag filter scopes, pinned-at-top ordering, search-by-name, search-empty-state, search-regex-specials-no-crash, search-very-long-query, search-clear-button, moddable badge, moddable-only filter; + adversarial inputs (emoji surrogate-pair, RTL Arabic, zero-width specials) |
| `detail.spec.ts` | ✓ active (9 tests) | (a) | Discovery | Open via card click, close via button + backdrop + Escape, name/description/repo, readme HTML rendering, mod command, https href, tag |
| `a11y.spec.ts` | ✓ active (3) + skip (1) | (a) | Discovery / My Apps | Home grid, filtered empty state, My Apps view axe-core. Detail panel skipped on known colour-contrast issue |
| `mobile-smoke.spec.ts` | ✓ active (2 tests, Pixel 7) | (a) | Discovery | Home grid + detail panel render on mobile viewport |
| `mobile-signer.spec.ts` | ✓ active (4) + fixme (2) | (a) | Sign-in | Login success, post-login signing (with `createTransaction` SigningLogEntry type discriminator), disconnect, reconnect. Permission-reject + login-reject fixme'd — filed upstream against host-api-test-sdk. |
| `integration-boundaries.spec.ts` | ✓ active (3 tests) | (a) | Cross-cutting | Host disconnect mid-browse keeps grid attached, reconnect keeps grid usable, 5-cycle disconnect/reconnect doesn't leak listeners |
| `my-apps.spec.ts` (non-admin button + funder-owned fixture) | ✓ active (2 tests) | (a) | My Apps | Connected account + publish-button hidden for non-admin; fixture domain appears in My Apps grid when signed in as the funder (owner) |
| `rate.spec.ts` | ✓ active (1 test) | (a) | Star | `@mock/reputation` averaged-rating mechanic — transitional, replaced when cumulative stars ships |
| `testnet-bootstrap.spec.ts` | 🟡 planned (Tier 1) | (a) Layer 2 | Sign-in (mechanism canary) | Testnet PoP-grant + claim_long_term_storage + slot-key signing. Prereqs in Priorities |
| `account-status.spec.ts` | 🚧 blocked on source | (a) | Account status | Awaiting component build |
| `standalone-readonly.spec.ts` | ✓ active (3 tests) | (a) | Standalone readonly | Page loads without crash, left-rail nav renders, auth-gated UI hidden — out-of-host degradation tripwire. Uses plain Playwright `test` (no host fixture). |
| `tutorial-detail.spec.ts` | 🚧 blocked on source | (a) | Discovery | Tutorial-variant detail page (4 levels). Depends on tutorial app being built AND iframe-side variant rendering |
| Onboarding copy assertion (`browse.spec.ts`) | 🚧 blocked on source | (a) | Discovery | "Welcome to playground.dot..." copy not in source today |
| Deep-link routing (`detail.spec.ts`) | 🚧 blocked on source | (a) | Discovery | `/app/<domain>` URL routing not in source today; needs router lift |
| Modded-from attribution (`detail.spec.ts`) | 🔵 gated on contract work | (a) | Discovery | Contract field + iframe render both pending |
| Mobile L3-4 laptop badge (`mobile-smoke.spec.ts`) | 🚧 blocked on source | (a) | Discovery | Same tutorial-variant blocker as tutorial-detail |
| QR explanation copy (`mobile-signer.spec.ts`) | 🚧 blocked on source | (a) | Sign-in | Copy not in source today |
| Logout UI handling (`mobile-signer.spec.ts`) | 🚧 blocked on source | (a) | Sign-in | No iframe-side logout handler today |
| Bulletin expiry countdown (`my-apps.spec.ts`, `detail.spec.ts`) | 🚧 blocked on source | (a) | My Apps + Discovery | No countdown UI today; V1 P0 |
| Layer (a) — Account-switch mid-publish | 🟡 planned (Tier 1) | (a) | Sign-in + publish | Per-test fresh host pattern; touches CLI surface |
| Layer (a) — Domain race test | 🟡 planned (Tier 1) | (a) | Discovery + Sign-in | CLI surface mostly; needs iframe-side error UI verification |
| `unpublish.spec.ts` (was Layer a) | ⛔ relocated | (b) | n/a | Contract roundtrip test; moved to Layer (b) via revive-dev-node |
| `events.spec.ts` (was Layer a) | ⛔ relocated | (d) | n/a | Event-reducer logic; moved to Layer (d) component test |
| `my-apps.spec.ts` visibility-toggle (was Layer a) | ⛔ relocated | (d) | My Apps | Visibility-toggle state machine; Layer (d) component test |
| `publish.spec.ts` (was Layer a) | ⛔ deleted | n/a | n/a | Admin-only modal; out of Layer (a) scope. Layer (d) picks up the modal state machine once the lift lands |
| Layer (b) — current contract read paths | ✓ active (8 tests, against live chain) | (b) | n/a | get_app_count, get_context_id, get_sudo, get_visibility, is_pinned, get_pinned_apps, get_owner_app_count |
| Layer (b) — current contract write paths | 🚧 scaffolded (6 .skip'd) | (b) | n/a | publish/unpublish/rate/pin/visibility — bodies pending local dev-node deploy harness |
| Layer (b) — property tests | 🟡 planned (Tier 1 nightly) | (b) | n/a | Pin/unpin, publish/unpublish, pagination, visibility toggle. Skip-on-PR, full-N nightly |
| Layer (b) — points/leaderboard work | 🔵 gated on contract work | (b) | n/a | award_stars / award_points / level-tagging — implementation pending |
| Layer (c) — placeholders / hooks / diagnostics / contractManifest | ✓ active (24 tests) | (c) | n/a | Vitest. `pnpm test` |
| Layer (c) — bulletin.ts | ✓ active (6 tests) | (c) | n/a | useIconUrl + cache, with BulletinClient mock |
| Layer (d) — AppDetailPanel | ✓ active (14 tests) | (d) | Discovery | Vitest + Testing Library. Sample-app variant rendering, ownership, admin gating, XSS-strip, close callback |
| Layer (d) — PublishModal state machine | ✓ active (32 tests) via `publishFlow.test.ts` | (d) | (admin) publish | 5-step state machine extracted to `src/publishFlow.ts`. Tests cover parallel Bulletin+Registry, per-step failure attribution, error-message extraction, status state machine, milestone sequencing |
| Layer (d) — Event reducer | ✓ active (22 tests) via `registryEventReducer.test.ts` | (d) | Discovery | 7 event types covered. Pure helpers (`shouldIncludeEntry` / `upsertEntry` / `removeEntry`) extracted to `src/registryEventReducer.ts`; dispatcher tested with mock deps |
| Layer (d) — Visibility-toggle state machine | ✓ active (11 tests) via `visibilityToggle.test.ts` | (d) | My Apps | Extracted to `src/visibilityToggle.ts`. Public↔Private branching, breadcrumb ordering, indexer-lag tolerance, signing-rejection swallow vs telemetry-report+rethrow |
| Layer (d) — AppCard | ✓ active (21 tests) | (d) | Discovery | Rendering with/without metadata, all 5 data attributes, badges (private/moddable/pin), rating u8→star conversion, onSelect callback, data-domain lock |
| Layer (d) — InstallWidget | ✓ active (8 tests) | (d) | Discovery | INSTALL_CMD literal pin, copy click flow, clipboard call, telemetry breadcrumb, 2000ms revert via fake timers |
| Layer (d) — registryUtils (pure helpers) | ✓ active (13 tests) | (d) | n/a | `bytesToHex0x` / `domainToEntity` / `decodeContextIdValue` — extracted from App.tsx. Covers the 3 SDK value shapes for getContextId + invalid-shape throws |

Total active today: **~46 Layer (a) + 8 Layer (b) + 30 Layer (c) + 121 Layer (d) ≈ 205 tests** across ~16 spec/test files, 1 skip + 6 Layer (b) write tests scaffolded (.skip'd pending deploy harness). 🚧 items above are gated on UI work landing or local-dev-node deploy harness — listed so coverage gaps are visible, but tests don't get fully written until the corresponding source ships.

---

## Open questions / watch list

These aren't blockers for the plan as written, but they're worth tracking because answers may shift specific test patterns:

**For the e2e test engineer / SDK team:**
1. RFC-0010 era — what does a canonical "test the allowance-grant + signing flow" pattern look like? Is `mobile-signer.spec.ts`'s combination of `setLoginBehavior('success')` + `setPermissionBehavior` + `getPermissionLog()` the recommended shape? Or is there a planned `getPaymentLog` / `setPaymentBalance` flow that should be used instead? The current SDK exposes both but documented patterns lag.
2. Is there an updated reference implementation covering post-RFC-0010 patterns we should mirror?
3. The "container-only by design" SDK squeeze for Node-side test helpers — planned Node test mode, or is the answer permanently "everything that needs the SDK goes through the iframe"?
4. **Feature request: `injectChainEvent(palletName, eventName, eventData)`** for the test SDK. The current SDK has injection helpers for chat (`injectChatAction`), statements (`injectStatement`), preimages (`seedPreimage`), payment status (`simulatePaymentStatus`), and disconnect/reconnect — but no way to fake a chain event firing. Chain events flow through the real RPC connection (`handleChainConnection`). Without an injection helper, **Layer (a) iframe-driven event testing isn't feasible** — the relocated `events.spec.ts` stays at Layer (d) reducer-only, and the upcoming V2 activity ticker tests will hit the same wall. The ask: a host-side injection that delivers a synthetic `Published` (or any pallet event) into the iframe's event-subscription channel, so tests can assert "iframe correctly observed event X and re-rendered grid". Unblocks both today's event-subscription regression coverage and V2 ticker testing.

**For the deploy / SBI / allowances team:**
4. Fixture seeding bootstrap — for the e2e funder, could we grant PoP via the testnet API, then have a one-time Node script claim its long-term-storage allowance via `Resources.claim_long_term_storage`, save the resulting slot key, and use that slot key to sign Bulletin uploads in CI? Or does the SBI mediation matter such that this counts as a workaround? Connected to the chicken-and-egg problem — same primitives, different caller.
5. Throwaway-domain cleanup — for tests that create per-test throwaways. Plan currently says "don't create them from Node" (relocate the affected tests). Is the relocation the right call, or is there an iframe-side cleanup pattern we should use instead?
6. `setVisibility` between runs — currently Node-side hygiene (test signer is legitimate owner of the fixture). Is the Node-side shortcut acceptable as legitimate-owner test hygiene, or should it be driven through the iframe for purity?
7. Admin-only publish modal. How should tests handle scenarios that need to publish — admin-signer iframe flow, or accept that this lives at Layer (b) / (d) and stop publishing from Layer (a) entirely?

**Watch list — context for future test changes:**
- **Network transition.** Tests follow `cdm.json`'s configured network. When the target chain migrates, tests adopt the change automatically as contracts redeploy.
- **Contract data migration.** Ratings between contract versions are tied to per-contract context IDs; when migrated, `rate.spec.ts`'s `@mock/reputation` mechanic may need updating — the cumulative-stars contract change is the longer-term replacement.
- **Statement Store allowance not queryable on-chain.** Product uses a localStorage workaround; if cleared, the allowance is re-requested (API handles gracefully). Tests asserting on Statement Store allocation should use `getPermissionLog()` to verify the request fired, not chain queries.
- **`host-api-test-sdk` newer-version capabilities to adopt.** Two newer handlers — `handleCreateTransaction` (product accounts construct transactions; test host returns call data for assertions — useful for asserting "did the product try to create the right tx?" without chain interaction; probably most useful at Layer (d)) and `handleAccountCreateProof` (Ring VRF proof creation, host signs with sr25519 as stand-in for real ring VRF — another supported test-only entry point). `mobile-signer.spec.ts` could use `handleAccountCreateProof` to assert on actual proof-creation flow rather than just login-result outcomes. Refinement opportunity, not a current gap.
- **Currently skipped at Layer (a)**: 1 (the second a11y test on detail-panel — known colour-contrast issue on `--color-text-tertiary` #57534e on #161412 = 2.4:1, WCAG AA needs 4.5:1). Track this count over time; growth is silent debt.
- **`mobileSignerFixture` follow-up.** Plan describes a dedicated `mobileSignerFixture` (no pre-injected accounts) but it doesn't exist yet — `mobile-signer.spec.ts` currently reuses the shared `signerFixture` + `simulateDisconnect` between tests. A dedicated fixture would let the login flow start from a clean state instead of relying on disconnect-and-retry. Captured here as a follow-up task; not a blocker for current coverage.

---

## Findings worth knowing

Cross-stack infrastructure quirks discovered while building the suite. Listed here so the next contributor doesn't have to rediscover them.

- **`BulletinClient.create({ environment, signer })` is unusable from Node.** `getChainAPI(env)` routes through `@novasamatech/host-api`'s `getHostProvider`, which requires a Polkadot Desktop/Mobile host context. The `environment` shorthand docstring says it "wires up the chain-client automatically" with no host caveat. Affects any Node consumer (Playwright globalSetup, `scripts/publish-metadata.ts`, etc.). Workaround: use the lower-level `AsyncBulletinClient` directly (re-exported by product-sdk-bulletin) — see `scripts/seed-e2e-fixture.mjs` for the pattern. Upstream issue filed.
- **Bulletin Asset Hub Next fee model is `TransactionStorage.Authorizations`-quota, not native PAS.** `InvalidPayment` errors on `TransactionStorage.store` mean "no auth entry," not "no balance." Grant the signer via https://paritytech.github.io/polkadot-bulletin-chain/authorizations rather than dripping PAS on Bulletin Next. Confirmed empirically — a dev account with 0 PAS + auth successfully wrote.
- **Three different sr25519 keypairs from one mnemonic** depending on tool:
    - SDK empty path → matches dotNS CLI + personhood-faucet bare-mnemonic default
    - SDK `//0` → previously used by `generate-dev-accounts.mjs` (now changed to empty path for alignment)
    - BIP39-PBKDF2 — none of our tooling uses it, but worth knowing exists
  Bash gotcha: `MNEMONIC=val cmd "$MNEMONIC"` does NOT inline-substitute; pass mnemonics directly on the command line.
- **Deploy Frontend's `callerIsRoot` delegatecall chain** is sidestepped by getting the funder PoP-Full via `sudo.personhood.dev/personhood-faucet` directly. Once the relevant upstream PRs land, the standard path resumes working automatically.
- **Node 22 strict-ESM JSON imports.** Bare `import cdmJson from "../cdm.json"` is rejected by Node 22's ESM loader (which Playwright's tsx uses in CI). Vite, Vitest, and older Node tolerate it. Use `with { type: "json" }` syntax (TS 5.3+) — accepted everywhere.
- **Two `mobile-signer.spec.ts` fixmes filed upstream** against `host-api-test-sdk` (permission-log empty after grant+sign; `getIsAuthenticated()` returns true after login-reject). Test-SDK semantics questions; no action needed in product code.
- **`createTransaction` SigningLogEntry type discriminator** — asserted in `mobile-signer.spec.ts` post-login signing test. Locks the host-driven signing path; catches a regression to the legacy PJS-style signer (which would trip on the AsPgas signed-extension).
- **Fixture seeding is one-time per chain wipe.** `e2e/setup.ts`'s `ensureFixtureRegistered` checks `getApp(domain)` first; if the fixture is on chain with the matching CID, it just flips visibility public and warms the gateway cache — no publish needed. So once `scripts/seed-e2e-fixture.mjs` runs against a fresh chain, the suite is autonomous until the next wipe or until `fixture-metadata.json` changes.
