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
 * Playwright globalSetup — runs once before all e2e tests.
 *
 * 1. Check the SIGNER's balances (canary — opens a GH issue if either side is low).
 * 2. Ensure the fixture domain is registered AND its on-chain metadata
 *    matches `fixture-metadata.json`.
 * 3. Warm the Bulletin gateway cache for the fixture metadata so per-test
 *    fetches are fast.
 * 4. Clean up the chain WebSocket on teardown so playwright can exit.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { destroyTestClient } from "./chain.js";
import { checkFunderAndWarn } from "./funder.js";
import {
  getApp,
  publishDomain,
  computeMetadataCid,
  ensureSignerMapped,
  setVisibility,
  VISIBILITY_PRIVATE,
  VISIBILITY_PUBLIC,
} from "./registry.js";
import { SIGNER } from "./accounts.js";
import { FIXTURE_DOMAIN } from "./fixture.js";
import { gatewayFetchJson } from "./bulletin-gateway.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureFixtureRegistered(): Promise<void> {
  const metadataPath = join(__dirname, "fixture-metadata.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  const expectedCid = await computeMetadataCid(metadata);

  const existing = await getApp(FIXTURE_DOMAIN);

  if (existing && existing.metadataUri === expectedCid) {
    console.log(`[e2e setup] Fixture '${FIXTURE_DOMAIN}' already registered, metadata in sync (cid: ${existing.metadataUri})`);
    // Ensure fixture is PUBLIC for browse/detail tests. Idempotent — flips
    // back from any prior teardown's PRIVATE state. Costs one tx per setup
    // (~1s) but keeps the fixture hidden between runs without the test code
    // having to know whether it was hidden.
    try {
      await setVisibility(FIXTURE_DOMAIN, VISIBILITY_PUBLIC);
      console.log(`[e2e setup]   visibility set to PUBLIC for test run`);
    } catch (err) {
      console.warn(`[e2e setup]   setVisibility(PUBLIC) failed (tests may fail): ${err}`);
    }
    // Warm the Bulletin gateway cache so the iframe's per-test fetch is fast.
    // The warm itself isn't load-bearing — tests will still work, just slower
    // — so we keep this as a warning rather than a hard failure.
    try {
      await gatewayFetchJson(existing.metadataUri);
      console.log(`[e2e setup]   gateway cache warmed`);
    } catch (err) {
      console.warn(`[e2e setup]   gateway warm failed (tests may be slower): ${err}`);
    }
    return;
  }

  if (existing) {
    // Fixture exists but the on-chain metadata CID doesn't match what's in
    // the local file. Most likely cause: someone edited fixture-metadata.json
    // without re-publishing. Bail loudly — detail tests asserting on exact
    // strings would otherwise fail with confusing per-test timeouts.
    throw new Error(
      `Fixture '${FIXTURE_DOMAIN}' on-chain metadata CID does not match fixture-metadata.json.\n` +
        `  on-chain cid: ${existing.metadataUri}\n` +
        `  expected cid: ${expectedCid}\n` +
        `  Either revert fixture-metadata.json, or unpublish ${FIXTURE_DOMAIN} and re-run setup.`,
    );
  }

  // Map the signer on Revive (one-time per account on Asset Hub).
  // A fresh account fails its first contract call with `AccountUnmapped`.
  await ensureSignerMapped();

  console.log(`[e2e setup] Publishing fixture '${FIXTURE_DOMAIN}' (signer: ${SIGNER.name}) …`);
  let cid: string;
  try {
    cid = await publishDomain(FIXTURE_DOMAIN, metadata);
  } catch (publishErr) {
    // The Reads + Writes jobs run globalSetup in parallel with the SAME funder.
    // On an unseeded chain both try to seed and their store/publish txs can
    // collide on nonce (InvalidTxError "Stale"). That's fine — the winner seeds
    // the fixture; the loser just needs to wait for it to appear. Poll getApp
    // for the expected CID before treating the failure as fatal.
    console.warn(`[e2e setup] publish failed (${(publishErr as Error).message}); polling for a concurrent seed…`);
    const deadline = Date.now() + 60_000;
    let seeded = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const row = await getApp(FIXTURE_DOMAIN);
      if (row && row.metadataUri === expectedCid) {
        console.log(`[e2e setup]   fixture seeded by a parallel job (cid: ${row.metadataUri})`);
        seeded = true;
        break;
      }
    }
    if (!seeded) throw publishErr; // genuinely failed — surface the original cause
    cid = expectedCid;
  }
  console.log(`[e2e setup]   → metadataCid: ${cid}`);

  // publishDomain already calls waitForApp internally, so the row is
  // queryable. Belt-and-braces: re-fetch and confirm before tests run.
  const verified = await getApp(FIXTURE_DOMAIN);
  if (!verified) {
    throw new Error(
      `Publish reported success but '${FIXTURE_DOMAIN}' is still not queryable in the registry.`,
    );
  }
}

export default async function globalSetup() {
  console.log("[e2e setup] Playground-app E2E test suite starting…");
  console.log(`[e2e setup] Fixture domain: ${FIXTURE_DOMAIN}`);
  console.log(`[e2e setup] Signer: ${SIGNER.name} (${SIGNER.address}, h160 ${SIGNER.h160})`);

  // Canary is best-effort: a low balance opens a GH issue but should not
  // block tests (read-only suite still runs without writes).
  try {
    await checkFunderAndWarn();
  } catch (err) {
    console.warn(`[e2e setup] Balance canary failed (continuing): ${err}`);
  }

  // Fixture registration IS load-bearing: every browse/detail test asserts
  // on FIXTURE_DOMAIN. If we can't make the fixture present, fail setup so
  // the run reports a clear cause instead of a cascade of opaque timeouts.
  try {
    await ensureFixtureRegistered();
  } catch (err) {
    const reason = (err as Error).message;
    // Read the actual `reason` above before assuming a cause — these gates
    // stack, and a single guess here previously sent debugging down the wrong
    // path. Common causes, in the order they tend to surface on a fresh chain:
    //   1. Funder has no PAS         → top up at https://faucet.polkadot.io/?network=pah
    //   2. Funder not authorized on  → grant at
    //      Bulletin Next (InvalidPayment)  https://paritytech.github.io/polkadot-bulletin-chain/authorizations
    //   3. Fixture not on this chain → `publishDomain` self-seeds it from Node
    //      (AsyncBulletinClient over a direct WS, bypassing the host-only
    //      CloudStorageClient — product-sdk#94). If that publish itself errors,
    //      `scripts/seed-e2e-fixture.mjs` runs the same path standalone for a
    //      one-off: `E2E_FUNDER_SEED='<mnemonic>' pnpm tsx scripts/seed-e2e-fixture.mjs`
    throw new Error(
      `[e2e setup] Fixture registration failed — aborting suite.\n` +
        `  reason: ${reason}\n` +
        `  runbook: see the comment in e2e/setup.ts at this throw — the three gates are\n` +
        `    (1) fund the funder with PAS, (2) authorize it on Bulletin Next,\n` +
        `    (3) re-seed the fixture via scripts/seed-e2e-fixture.mjs.`,
    );
  }

  return async () => {
    // Hide the fixture from the public registry now that the test run is over.
    // Idempotent and best-effort — failures here must not block Playwright
    // from exiting (CI would hang otherwise). Setup re-flips PUBLIC on the
    // next run.
    try {
      await setVisibility(FIXTURE_DOMAIN, VISIBILITY_PRIVATE);
      console.log(`[e2e teardown] Fixture '${FIXTURE_DOMAIN}' set to PRIVATE`);
    } catch (err) {
      console.warn(`[e2e teardown] setVisibility(PRIVATE) failed (fixture may stay public): ${err}`);
    }
    try {
      destroyTestClient();
    } catch {
      // best-effort cleanup
    }
  };
}
