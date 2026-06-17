// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

/**
 * Layer (b) — registry contract tests.
 *
 * Two categories:
 *   - **read tests** (always run): exercise the deployed contract on
 *     Paseo. Catch regressions in storage layout + query return shapes
 *     that would otherwise only surface as Layer (a) flakes.
 *   - **write tests** (skip unless CONTRACT_RPC_URL set): mutate chain
 *     state on a local revive-dev-node. Needed for publish / unpublish /
 *     rate / visibility / pin coverage; scaffolded but currently
 *     `.skip`-gated until the local-target wiring lands. See setup.ts
 *     for the followup.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  WRITE_TX_OPTS,
  devAccount,
  getChainTarget,
  getHandles,
  destroyHandles,
  FIXTURE_DOMAIN,
} from "./setup";

const FAKE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

afterAll(async () => {
  await destroyHandles();
});

// On Paseo the fixture domain `playground-e2e-app.dot` is published by the
// long-running e2e suite. Against a fresh PPN it doesn't exist, so the read
// tests would all fail on the first assertion (`app_count >= 1`). Publish
// it once as Alice (the local sudo/deployer) before the read block runs;
// on reruns it's a no-op-with-tx (Alice is the recorded owner so the
// re-publish branch of `is_authorized_to_republish` accepts).
beforeAll(async () => {
  if (getChainTarget() !== "local") return;
  const { registry } = await getHandles();
  const alice = devAccount("Alice", "//Alice");
  const reg = registry as unknown as {
    publish: { tx: (...args: unknown[]) => Promise<unknown> };
  };
  await reg.publish.tx(
    FIXTURE_DOMAIN,
    FAKE_CID,
    1, // VISIBILITY_PUBLIC — `is_pinned` test is decidable either way; we
       // pin to public here so the visibility-shape test can still pass.
    { isSome: false, value: "0x0000000000000000000000000000000000000000" },
    "", // modded_from
    false, // is_moddable
    false, // is_dev_signer
    { ...WRITE_TX_OPTS, signer: alice.signer, origin: alice.ss58 },
  );
});

describe("registry — read paths", () => {
  it("get_app_count returns at least 1 (fixture is published)", async () => {
    // setup.ts publishes the fixture domain on first run, so app_count must
    // be >= 1 against any active testnet. Catches the regression where the
    // contract storage layout drifts and the counter returns 0 / garbage.
    const { registry } = await getHandles();
    const result = await registry.getAppCount.query();
    expect(result.success, "get_app_count call must succeed").toBe(true);
    expect(typeof result.value).toBe("number");
    expect(result.value).toBeGreaterThanOrEqual(1);
  });

  it("get_context_id returns a non-zero ContextId", async () => {
    // The constructor stores the context_id derived from the contract's own
    // address. A zero return = contract was upgraded without re-running the
    // constructor / context registration was skipped.
    const { registry } = await getHandles();
    const result = await registry.getContextId.query();
    expect(result.success).toBe(true);
    // ContextId is bytes32 — sdk-ink decodes it as a FixedSizeBinary
    // object with `.asHex()`. Normalise to a hex string and assert
    // shape + non-zero.
    const raw = result.value as { asHex?: () => string } | Uint8Array | string;
    const hex =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? "0x" + Buffer.from(raw).toString("hex")
          : raw.asHex!();
    expect(hex).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(hex).not.toBe("0x" + "0".repeat(64));
  });

  it("get_sudo returns a non-zero Ethereum address", async () => {
    // The deployer becomes sudo via Storage::sudo().set(&caller()) in the
    // constructor. The address is fixed per-deploy and must be H160
    // (20 bytes, 40 hex chars after 0x).
    const { registry } = await getHandles();
    const result = await registry.getSudo.query();
    expect(result.success).toBe(true);
    const addr = result.value as string;
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(addr).not.toBe("0x" + "0".repeat(40));
  });

  it("get_visibility for the fixture returns a valid visibility value", async () => {
    // The fixture's visibility flips between PUBLIC (1) and PRIVATE (0)
    // depending on whether e2e/setup.ts has run recently (it sets PUBLIC
    // at start, PRIVATE at teardown). Asserting an exact value would
    // couple this Layer (b) test to e2e suite state, so instead we
    // assert the contract returns a valid byte (0 or 1) — the storage-
    // layout regression catcher this test exists for.
    const { registry } = await getHandles();
    const result = await registry.getVisibility.query(FIXTURE_DOMAIN);
    expect(result.success).toBe(true);
    expect([0, 1]).toContain(result.value);
  });

  it("get_visibility for a non-existent domain returns VISIBILITY_PRIVATE (0)", async () => {
    // Contract behaviour: missing apps return Private (0) rather than
    // erroring. This means the frontend can guard against private apps
    // without first checking existence. Catches a regression where the
    // method starts returning a sentinel like 255 or reverts on missing
    // keys.
    const { registry } = await getHandles();
    const result = await registry.getVisibility.query(
      "this-domain-does-not-exist-zz-9f3e1c70.dot",
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe(0);
  });

  it("is_pinned for the fixture is decidable (boolean returned)", async () => {
    // The pinning state of the fixture isn't load-bearing for assertions
    // here — we just verify is_pinned returns a clean boolean both for
    // a known-existing and a non-existing domain. The Layer (a) browse
    // suite asserts on ordering effects; here we pin down the contract
    // return shape.
    const { registry } = await getHandles();
    const known = await registry.isPinned.query(FIXTURE_DOMAIN);
    expect(known.success).toBe(true);
    expect(typeof known.value).toBe("boolean");

    const unknown = await registry.isPinned.query(
      "absent-zz-9f3e1c70.dot",
    );
    expect(unknown.success).toBe(true);
    expect(unknown.value).toBe(false);
  });

  it("get_pinned_apps returns an array of AppEntry shapes", async () => {
    // Result type is Vec<AppEntry>. Even if empty, the call must succeed
    // and the value must be an array — guards against a return-type
    // regression (e.g. returning Option<Vec> by accident).
    const { registry } = await getHandles();
    const result = await registry.getPinnedApps.query();
    expect(result.success).toBe(true);
    expect(Array.isArray(result.value)).toBe(true);

    // If anything is pinned, check the shape of the first entry — domain
    // is non-empty, owner + publisher are both H160s. Catches the
    // regression where the SolAbi encoding changes and the decoded
    // struct comes back with shifted fields (the `publisher` field was
    // appended after `visibility`; an off-by-one decode would surface
    // here as a non-hex publisher).
    const entries = result.value as Array<{
      domain: string;
      owner: string;
      visibility: number;
      publisher: string;
    }>;
    if (entries.length > 0) {
      const e = entries[0];
      expect(typeof e.domain).toBe("string");
      expect(e.domain.length).toBeGreaterThan(0);
      expect(e.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(e.visibility).toBeGreaterThanOrEqual(0);
      expect(e.publisher).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("get_owner_app_count of a non-owner returns 0", async () => {
    // Spot-check that the per-owner index doesn't leak state — querying a
    // zero address returns 0. A regression where the storage scan falls
    // back to the global count would show up as a non-zero answer.
    const { registry } = await getHandles();
    const zero = "0x" + "0".repeat(40);
    const result = await registry.getOwnerAppCount.query(zero);
    expect(result.success).toBe(true);
    expect(result.value).toBe(0);
  });
});

describe("registry — write paths (local dev-node only)", () => {
  // These tests need a fresh-state revive-dev-node with the registry +
  // dependencies deployed. The signer must be funded + Revive-mapped.
  //
  // Current status: scaffolded but `.skip`-gated. See tests/contract/
  // README.md + setup.ts for the wiring plan. When the local-target path
  // is implemented in setup.ts, drop the `skipIf` guards.
  //
  // ─── State-isolation contract (TESTING_PLAN.md §Layer (b)) ────────
  // When these bodies get written, every test in this describe MUST:
  //   1. Use a unique domain — `uniqueDomain()` from `e2e/accounts.ts`
  //      (or an equivalent ts-rand-suffix helper) so state mutations
  //      don't bleed between tests. Even a half-aborted test's
  //      half-published domain can't poison a sibling test.
  //   2. NOT depend on the dev-node's state being reset between tests.
  //      File-level freshness (new dev-node process per file) is the
  //      assumed isolation; within-file is serial-with-unique-domains.
  //   3. NOT retry. Vitest is configured `retry: 0` for Layer (b) by
  //      design — a flake here is a real state-isolation bug, not a
  //      network blip.

  it.todo("publish + unpublish round-trip clears storage", async () => {
    // The contract's `Mapping::remove` storage clearing is the bug class
    // that bit cargo-pvm-contract PR #64 — re-publishing a previously-
    // unpublished domain must give back fresh metadata, not stale bytes.
    // Was at Layer (a) as `unpublish.spec.ts`; per the plan, relocated
    // here for fast feedback without iframe + funder overhead.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("publish with an oversize visibility byte reverts InvalidVisibility", async () => {
    // visibility > MAX_VISIBILITY (1) must revert the tx. Boundary catch
    // for the contract's input validation. Without this, a future code
    // path that adds VISIBILITY_HIDDEN=2 could silently accept the wrong
    // value if MAX_VISIBILITY wasn't bumped.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("publish a domain owned by another caller reverts Unauthorized", async () => {
    // The auth check on `publish` of an existing domain: only the original
    // owner or sudo can update. Caller B trying to overwrite A's domain
    // must hit the Unauthorized revert; a regression where the check is
    // dropped would let arbitrary actors squat on others' .dot listings.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("pin as non-admin reverts Unauthorized", async () => {
    // The pin/unpin gate is `is_sudo_or_admin`. A non-admin caller MUST
    // fail. Without this assertion, a future admin-role refactor could
    // silently widen access to pin (would be exploitable for promotion
    // of arbitrary listings).
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("set_visibility to PRIVATE auto-unpins the app", async () => {
    // Contract behaviour: flipping a pinned app to private must remove it
    // from the pinned list. Without this, the pinned grid would render
    // private apps that shouldn't be visible to non-owners. Verified by
    // checking is_pinned returns false post-flip.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  // ─── Claimed-owner (dev-mode CLI flow) ────────────────────────────────
  // These cover the `Option<Address> owner` parameter added to `publish`
  // for the CLI's dev-mode + active-session flow: a dev key (Alice) signs
  // the tx but the user's H160 is recorded as owner so MyApps still
  // resolves their app. The `publisher` field stores the actual caller.
  //
  // See docs/superpowers/specs/2026-05-20-fully-dev-deploy-design.md in
  // playground-cli for the design context.

  it.todo("publish with owner=None records caller as both owner and publisher", async () => {
    // Baseline path — no claimed-owner override. The contract falls back
    // to `caller` for `owner`, and MyApps under the caller's H160 lists
    // the domain. `publisher == caller` too.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("publish with owner=Some(other) records other as owner and caller as publisher", async () => {
    // The headline scenario. Alice signs; passes owner=Some(user_h160).
    // After tx: info.owner == user_h160, info.publisher == Alice's H160.
    // get_owner_app_count(user_h160) increments; get_owner_app_count(alice) does not.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("re-publish by the original publisher succeeds (publisher branch of is_authorized_to_republish)", async () => {
    // Alice published as user_h160 first; she re-publishes (e.g. iterates
    // on metadata_uri). is_authorized_to_republish accepts publisher ==
    // caller, so the tx goes through. info.owner and info.publisher must
    // both be UNCHANGED on update — ownership is immutable after first
    // publish to block hostile rewrites.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("re-publish by a random third party reverts Unauthorized", async () => {
    // Eve, who is neither the owner nor publisher nor admin, tries to
    // update metadata of a user_h160-owned app. is_authorized_to_republish
    // returns false; the tx reverts.
    expect.fail("not implemented — wire local target in setup.ts");
  });

  it.todo("unpublish by the publisher reverts Unauthorized — only owner/admin can delete", async () => {
    // Critical: the narrower is_authorized (owner-only) gates unpublish.
    // Even though Alice published the entry on the user's behalf, she
    // cannot delete it later. Prevents a dev key from clearing user-
    // owned apps out of the registry. The user (owner) and sudo/admin
    // are the only callers permitted to unpublish.
    expect.fail("not implemented — wire local target in setup.ts");
  });
});
