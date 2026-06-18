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
 * Replay a snapshot from export-registry-state.ts into the registry
 * currently referenced by cdm.json. Both import methods are idempotent at
 * the contract level (no-op if the domain / pinned entry already exists),
 * so this is safe to re-run after a partial failure.
 *
 * Usage:
 *   MNEMONIC="..." pnpm tsx scripts/import-registry-state.ts <snapshot.json>
 *   MNEMONIC="..." pnpm tsx scripts/import-registry-state.ts <snapshot.json> --dry-run
 *   MNEMONIC="..." pnpm tsx scripts/import-registry-state.ts <snapshot.json> --package @staging/playground-registry
 *
 * The MNEMONIC must derive to the sudo on the new registry (= deployer).
 * --package defaults to PLAYGROUND_REGISTRY_CONTRACT (@w3s/playground-registry).
 * Use --package @staging/playground-registry for dress-rehearsal imports.
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { readFileSync } from "node:fs";
import cdmJson from "../cdm.json" with { type: "json" };
import { PLAYGROUND_REGISTRY_CONTRACT } from "../src/utils/contractManifest.ts";
import { assetHubDescriptor, assetHubWsUrl, DEV_ACCOUNTS, resolveChain } from "./_lib.ts";

// ---------------------------------------------------------------------------
// Snapshot types — accept both format_version 1 and 2.
// Missing arrays from v1 snapshots are treated as [] so old snapshots still
// import apps + pinned cleanly.
// ---------------------------------------------------------------------------

interface ExportedApp {
  source_index: number;
  domain: string;
  metadata_uri: string;
  owner: `0x${string}`;
  publisher: `0x${string}`;
  visibility: number;
  /** Source contracts that pre-date the points/leaderboard PR didn't carry
   *  this — the export script derives it from the Bulletin metadata's
   *  `repository` field at snapshot time. Older snapshots without this
   *  field are accepted by treating it as `false` (matches publish without
   *  `--moddable`); owners can re-publish to fix. */
  is_moddable?: boolean;
  /** Source domain recorded in Bulletin metadata. Empty string when absent.
   *  Added in format_version 2. */
  modded_from?: string;
}

interface LeaderboardEntry {
  account: `0x${string}`;
  /** u128 stored as decimal string to avoid JSON number precision loss. */
  score: string;
}

interface SocialEntry {
  domain: string;
  star_count: number;
  mod_count: number;
}

interface UsernameEntry {
  account: `0x${string}`;
  name: string;
}

interface LineageEntry {
  child: string;
  source: string;
}

interface Snapshot {
  format_version: 1 | 2;
  exported_at: string;
  source: { network: string; package: string; address: `0x${string}`; version: number };
  app_count_onchain: number;
  apps: ExportedApp[];
  pinned: string[];
  /** Added in format_version 2. Absent in v1 snapshots — treated as []. */
  leaderboard?: LeaderboardEntry[];
  /** Added in format_version 2. Absent in v1 snapshots — treated as []. */
  social?: SocialEntry[];
  /** Added in format_version 2. Absent in v1 snapshots — treated as []. */
  usernames?: UsernameEntry[];
  /** Added in format_version 2. Absent in v1 snapshots — treated as []. */
  lineage?: LineageEntry[];
  notes: { skipped_slots: number; private_apps: number; public_apps: number };
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const snapshotPath = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

// --package <name>: which CDM package to import into.
// Defaults to PLAYGROUND_REGISTRY_CONTRACT so existing callers are unaffected.
const packageArgIdx = args.indexOf("--package");
const packageName: string =
  packageArgIdx !== -1 && args[packageArgIdx + 1]
    ? args[packageArgIdx + 1]
    : PLAYGROUND_REGISTRY_CONTRACT;

if (!snapshotPath) {
  console.error(
    "Usage: pnpm tsx scripts/import-registry-state.ts <snapshot.json> [--dry-run] [--package @staging/playground-registry]",
  );
  process.exit(2);
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic && !dryRun) {
  console.error("MNEMONIC env var required (sudo of the target registry)");
  process.exit(1);
}

const startedAt = Date.now();
const snapshot: Snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const { signer, ss58Address: origin, h160Address: callerH160 } = mnemonic
  ? seedToAccount(mnemonic, "")
  : { signer: undefined as never, ss58Address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as const, h160Address: "0x0000000000000000000000000000000000000000" as const };

// Normalise optional v2 arrays — v1 snapshots omit these entirely.
const leaderboard: LeaderboardEntry[] = snapshot.leaderboard ?? [];
const social: SocialEntry[] = snapshot.social ?? [];
const usernames: UsernameEntry[] = snapshot.usernames ?? [];
const lineage: LineageEntry[] = snapshot.lineage ?? [];

// Dev/test accounts that must never hold leaderboard points. Include the live
// deployer (callerH160) so the actual signer is always covered regardless of
// whether it matches one of the canonical dev addresses.
const devSet = new Set([...DEV_ACCOUNTS, callerH160].map((a) => a.toLowerCase()));

console.log(`Snapshot     : ${snapshotPath}`);
console.log(`  format_ver : ${snapshot.format_version}`);
console.log(`  exported   : ${snapshot.exported_at}`);
console.log(`  source     : ${snapshot.source.address}`);
console.log(`  apps       : ${snapshot.apps.length} (${snapshot.notes.public_apps} public, ${snapshot.notes.private_apps} private)`);
console.log(`  pinned     : ${snapshot.pinned.length}`);
console.log(`  leaderboard: ${leaderboard.length}`);
console.log(`  social     : ${social.length}`);
console.log(`  usernames  : ${usernames.length}`);
console.log(`  lineage    : ${lineage.length}`);
const chain = resolveChain();
console.log(`Package      : ${packageName}`);
console.log(`Chain        : ${chain}`);
console.log(`Caller       : ${origin}  (${callerH160})`);
console.log(`Mode         : ${dryRun ? "DRY-RUN (no transactions)" : "LIVE"}`);
console.log();

const client = createClient(getWsProvider(assetHubWsUrl(chain)));

const manager = await ContractManager.fromLiveClient(
  cdmJson as unknown as CdmJson,
  client,
  assetHubDescriptor(chain),
  {
    defaultSigner: signer,
    defaultOrigin: origin,
    registryOrigin: origin,
    libraries: [packageName],
  },
);

try {
  const registry: any = manager.getContract(packageName);
  const targetAddr = manager.getAddress(packageName);
  console.log(`Target registry: ${targetAddr}\n`);

  if (targetAddr.toLowerCase() === snapshot.source.address.toLowerCase()) {
    throw new Error(`Target registry == snapshot source. Refusing to import into the same contract.`);
  }

  // Sudo check — bail early with a useful message instead of letting the
  // first import_app revert with Unauthorized after the network round-trip.
  const sudoRes = await registry.getSudo.query();
  if (sudoRes.success) {
    console.log(`Target sudo: ${sudoRes.value}`);
    if (!dryRun && callerH160.toLowerCase() !== sudoRes.value.toLowerCase()) {
      throw new Error(`Caller ${callerH160} is not sudo.`);
    }
  }
  console.log();

  if (dryRun) {
    console.log("Dry-run complete; everything would have been imported.");
    process.exit(0);
  }

  // Per-tx options:
  //  - Explicit gas/storage: the SDK's auto-estimate runs too tight on the
  //    first import per new owner (fresh storage slots). Field names are
  //    snake_case to match Weight in @parity/product-sdk-tx; camelCase
  //    silently produces an empty Weight and breaks extrinsic encoding.
  //  - Short timeout + retry: the public RPC occasionally drops txs after
  //    long bursts; idempotent re-submit is faster than waiting 5min.
  //  - Inter-tx delay: avoid pummeling a single mempool slot.
  const TX_OPTS = {
    // 1.5T ref_time — the prior 50B undershot once the `points_index`
    // OrderedIndex grew deep enough on later chunks (Revive.OutOfGas around
    // app 64 of a 79-app prod migration). Same numbers as the smoke tests,
    // which consistently land.
    gasLimit: { ref_time: 1_500_000_000_000n, proof_size: 2_000_000n },
    storageDepositLimit: 1_000_000_000_000_000n,
    timeoutMs: 60_000,
  };
  const INTER_TX_DELAY_MS = 300;

  type TxOutcome = { ok: boolean; txHash?: string };
  async function submitIdempotent(label: string, fn: () => Promise<TxOutcome>): Promise<TxOutcome> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fn();
        if (res.ok) return res;
        console.warn(`  ⟲ ${label} attempt ${attempt} returned ok=false (hash=${res.txHash})`);
      } catch (e) {
        console.warn(`  ⟲ ${label} attempt ${attempt} failed: ${(e as Error).message ?? e}`);
      }
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    throw new Error(`${label} failed after ${maxAttempts} attempts`);
  }

  // -------------------------------------------------------------------------
  // 0. Blacklist dev/test accounts
  // -------------------------------------------------------------------------
  // Runs BEFORE the apps import loop so that `import_one` (called per app
  // inside `importApps`) finds these accounts already blacklisted and skips
  // awarding launch points to them. This stops dev accounts from appearing
  // as phantoms before reconciliation even gets a chance to run.
  console.log(`Blacklisting ${devSet.size} dev account(s) on target...`);
  await submitIdempotent("setBlacklisted(devs)", () =>
    registry.setBlacklisted.tx([...devSet], true, TX_OPTS),
  );

  // -------------------------------------------------------------------------
  // 1. Apps
  // -------------------------------------------------------------------------
  // Source-index ascending so the new registry's domain_at order matches
  // the snapshot. Chunk size 1: chunk=3 OutOfGases around app 64 once the
  // points_index B-tree grows deep enough — verified twice now (staging
  // v12 → v13 test, prod v7 → v8). `import_one` is idempotent (no-op when
  // the domain is already in `info`), so re-running over already-imported
  // apps is cheap. Bump back to 3 only if a future contract revision moves
  // the OrderedIndex into a more gas-friendly shape.
  const CHUNK_SIZE = 1;
  console.log(`Importing ${snapshot.apps.length} apps in batches of ${CHUNK_SIZE}...`);
  for (let i = 0; i < snapshot.apps.length; i += CHUNK_SIZE) {
    const chunk = snapshot.apps.slice(i, i + CHUNK_SIZE);
    const entries = chunk.map(({ domain, owner, publisher, visibility, metadata_uri, is_moddable }) => ({
      domain, owner, publisher, visibility, metadata_uri,
      // Default to false for snapshots from pre-PR export scripts. The
      // post-PR export populates this from Bulletin metadata.
      is_moddable: is_moddable === true,
    }));
    const label = `importApps(${chunk.map((a) => a.domain).join(",")})`;
    const res = await submitIdempotent(label, () => registry.importApps.tx(entries, TX_OPTS));
    const range = `${i + 1}-${i + chunk.length}/${snapshot.apps.length}`;
    console.log(`  ✓ [${range}] ${chunk.map((a) => a.domain).join(", ")}  ${res.txHash}`);
    if (i + CHUNK_SIZE < snapshot.apps.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
  }

  // -------------------------------------------------------------------------
  // 2. Pinned
  // -------------------------------------------------------------------------
  console.log(`\nImporting ${snapshot.pinned.length} pinned entries...`);
  for (let i = 0; i < snapshot.pinned.length; i++) {
    const domain = snapshot.pinned[i];
    const res = await submitIdempotent(`importPinned(${domain})`, () => registry.importPinned.tx(domain, TX_OPTS));
    console.log(`  ✓ [${i + 1}/${snapshot.pinned.length}] ${domain}  ${res.txHash}`);
    if (i + 1 < snapshot.pinned.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
  }

  // -------------------------------------------------------------------------
  // 3. Points
  // -------------------------------------------------------------------------
  // Points MUST come after apps. `import_one` (called per app above) may seed a
  // launch-point award for imported app owners. `importPoints` then SETs the
  // authoritative total from the snapshot, overwriting that seed. Reversing
  // the order would leave the launch-point seed un-overwritten for any account
  // that had a positive balance before the migration.
  //
  // Chunk size 1 — `import_points` calls `set_points` per entry, which does an
  // OrderedIndex remove+insert on `points_index`; batching even ~8 entries
  // exhausts the per-tx gas (verified: Revive.OutOfGas on an 8-entry chunk at
  // 1.5T ref_time during the @staging dress rehearsal). Same reason importApps
  // uses CHUNK_SIZE=1. Each single-entry tx lands well within the limit.
  if (leaderboard.length > 0) {
    // Scrub dev accounts before importing: a dev account with points on the
    // source contract is a bug (should have been blacklisted there too) and
    // must not carry over to the new contract.
    const cleanLeaderboard = leaderboard.filter(({ account }) => {
      if (devSet.has(account.toLowerCase())) {
        console.log(
          `  skipping dev account ${account} (${leaderboard.find((e) => e.account === account)?.score ?? "?"} points on source — not migrated)`,
        );
        return false;
      }
      return true;
    });

    const POINTS_CHUNK = 1;
    console.log(`\nImporting ${cleanLeaderboard.length} point balances in batches of ${POINTS_CHUNK} (${leaderboard.length - cleanLeaderboard.length} dev account(s) scrubbed)...`);
    for (let i = 0; i < cleanLeaderboard.length; i += POINTS_CHUNK) {
      const chunk = cleanLeaderboard.slice(i, i + POINTS_CHUNK);
      const entries = chunk.map(({ account, score }) => ({
        account,
        total: BigInt(score),
      }));
      const label = `importPoints(${i + 1}-${i + chunk.length})`;
      const res = await submitIdempotent(label, () => registry.importPoints.tx(entries, TX_OPTS));
      const range = `${i + 1}-${i + chunk.length}/${cleanLeaderboard.length}`;
      console.log(`  ✓ [${range}]  ${res.txHash}`);
      if (i + POINTS_CHUNK < cleanLeaderboard.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
    }
  } else {
    console.log(`\nNo leaderboard entries in snapshot — skipping importPoints.`);
  }

  // -------------------------------------------------------------------------
  // 3b. Leaderboard reconciliation — evict phantom accounts
  // -------------------------------------------------------------------------
  // `import_one` (called per app above) RE-AWARDS launch points to app owners
  // regardless of public/private visibility or whether they earned points on
  // the source.
  // The blacklist was seeded above (step 0) so dev accounts are already
  // blocked from earning during importApps. However any non-dev account that
  // wasn't on the source leaderboard could still appear (e.g. app owners
  // whose source publish used is_dev_signer=false but the source contract
  // had them at 0 because of an older bug). We read the live leaderboard and
  // evict any account NOT present in snapshotAccounts using `importPoints`
  // with `total: 0n` (the contract evicts at score 0).
  //
  // snapshotAccounts = authoritative non-dev source accounts. Dev accounts
  // are deliberately excluded: even if they had points on the source (a bug),
  // they must not carry over and will be caught by the verify step below.
  {
    const snapshotAccounts = new Set(
      leaderboard
        .filter((e) => !devSet.has(e.account.toLowerCase()))
        .map((e) => e.account.toLowerCase()),
    );

    // Build the phantom set DETERMINISTICALLY from the snapshot rather than a
    // live read. `import_one` re-awards launch points to app owners regardless
    // of visibility, so any owner that is NOT a legit source leaderboard
    // account is a phantom that must be evicted back to 0. Deriving this from
    // snapshot.apps (not getTopBuilders) makes reconciliation immune to
    // best-block read lag — a live read right after the import txs can miss
    // freshly-awarded entries and silently leave phantoms behind (observed on
    // the @staging dress rehearsal: a non-dev owner survived at 2 points).
    // IMPORTANT: this scrubs leaderboard/points entries and their matching
    // deploy-award counters only. The apps themselves — including dev-owned
    // apps — remain imported and visible in the registry.
    const evict = new Set<string>();
    for (const a of snapshot.apps) {
      const owner = a.owner.toLowerCase();
      if (!snapshotAccounts.has(owner)) evict.add(owner);
    }

    // Belt-and-suspenders: also fold in anything currently on the live
    // leaderboard that isn't a legit source account (catches a non-fresh target
    // carrying pre-existing phantoms). Best-effort — skipped on query failure;
    // the deterministic set above is the guarantee.
    try {
      // u32 params — pass plain numbers (matches export-registry-state.ts).
      let lbPageStart = 0;
      const LB_PAGE_SIZE = 100;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pageRes = await registry.getTopBuilders.query(lbPageStart, LB_PAGE_SIZE);
        if (!pageRes.success) break;
        const page: Array<{ account: string; score: bigint }> = pageRes.value;
        for (const entry of page) {
          const acct = entry.account.toLowerCase();
          if (!snapshotAccounts.has(acct)) evict.add(acct);
        }
        if (page.length < LB_PAGE_SIZE) break;
        lbPageStart += LB_PAGE_SIZE;
      }
    } catch (e) {
      console.warn(
        `⚠ live leaderboard read failed during reconciliation; using deterministic set only. ${(e as Error).message ?? e}`,
      );
    }

    const phantoms = [...evict];
    if (phantoms.length > 0) {
      console.log(
        `\nReconciling leaderboard: evicting ${phantoms.length} phantom account(s) (app owners / live entries not on the source leaderboard)...`,
      );
      for (let pi = 0; pi < phantoms.length; pi++) {
        const phantom = phantoms[pi];
        const isDev = devSet.has(phantom);
        const res = await submitIdempotent(
          `importPoints(evict ${phantom}${isDev ? " [dev]" : ""})`,
          () =>
            registry.importPoints.tx(
              [{ account: phantom as `0x${string}`, total: 0n }],
              TX_OPTS,
            ),
        );
        const resetDeployCount =
          typeof registry.adminSetDeployAwardCount?.tx === "function"
            ? await submitIdempotent(
                `adminSetDeployAwardCount(${phantom}, 0)`,
                () => registry.adminSetDeployAwardCount.tx(phantom as `0x${string}`, 0, TX_OPTS),
              )
            : null;
        console.log(
          `  ✓ evicted ${phantom}${isDev ? " [dev account]" : ""}  ${res.txHash}` +
            (resetDeployCount ? `; deploy-award count reset ${resetDeployCount.txHash}` : ""),
        );
        if (pi + 1 < phantoms.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
      }
    } else {
      console.log(`\nLeaderboard reconciliation: no phantom accounts.`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Social counts
  // -------------------------------------------------------------------------
  // snake_case field names (star_count / mod_count) — verified against
  // check-migration.ts assertion 5 which uses the same shape.
  if (social.length > 0) {
    const SOCIAL_CHUNK = 10;
    console.log(`\nImporting ${social.length} social count entries in batches of ${SOCIAL_CHUNK}...`);
    for (let i = 0; i < social.length; i += SOCIAL_CHUNK) {
      const chunk = social.slice(i, i + SOCIAL_CHUNK);
      const entries = chunk.map(({ domain, star_count, mod_count }) => ({
        domain,
        star_count,
        mod_count,
      }));
      const label = `importSocialCounts(${i + 1}-${i + chunk.length})`;
      const res = await submitIdempotent(label, () => registry.importSocialCounts.tx(entries, TX_OPTS));
      const range = `${i + 1}-${i + chunk.length}/${social.length}`;
      console.log(`  ✓ [${range}]  ${res.txHash}`);
      if (i + SOCIAL_CHUNK < social.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
    }
  } else {
    console.log(`\nNo social entries in snapshot — skipping importSocialCounts.`);
  }

  // -------------------------------------------------------------------------
  // 5. Usernames
  // -------------------------------------------------------------------------
  if (usernames.length > 0) {
    const USERNAMES_CHUNK = 10;
    console.log(`\nImporting ${usernames.length} usernames in batches of ${USERNAMES_CHUNK}...`);
    for (let i = 0; i < usernames.length; i += USERNAMES_CHUNK) {
      const chunk = usernames.slice(i, i + USERNAMES_CHUNK);
      const entries = chunk.map(({ account, name }) => ({ account, name }));
      const label = `importUsernames(${i + 1}-${i + chunk.length})`;
      const res = await submitIdempotent(label, () => registry.importUsernames.tx(entries, TX_OPTS));
      const range = `${i + 1}-${i + chunk.length}/${usernames.length}`;
      console.log(`  ✓ [${range}]  ${res.txHash}`);
      if (i + USERNAMES_CHUNK < usernames.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
    }
  } else {
    console.log(`\nNo username entries in snapshot — skipping importUsernames.`);
  }

  // -------------------------------------------------------------------------
  // 6. Lineage
  // -------------------------------------------------------------------------
  if (lineage.length > 0) {
    const LINEAGE_CHUNK = 10;
    console.log(`\nImporting ${lineage.length} lineage edges in batches of ${LINEAGE_CHUNK}...`);
    for (let i = 0; i < lineage.length; i += LINEAGE_CHUNK) {
      const chunk = lineage.slice(i, i + LINEAGE_CHUNK);
      const entries = chunk.map(({ child, source }) => ({ child, source }));
      const label = `importLineage(${i + 1}-${i + chunk.length})`;
      const res = await submitIdempotent(label, () => registry.importLineage.tx(entries, TX_OPTS));
      const range = `${i + 1}-${i + chunk.length}/${lineage.length}`;
      console.log(`  ✓ [${range}]  ${res.txHash}`);
      if (i + LINEAGE_CHUNK < lineage.length) await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
    }
  } else {
    console.log(`\nNo lineage edges in snapshot — skipping importLineage.`);
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  // App count — best-block reads can lag the last few txs, so a mismatch here
  // is a warning, not an error — the per-domain getMetadataUri walk in
  // export-registry-state.ts verifies authoritatively.
  const countRes = await registry.getAppCount.query();
  const live = countRes.success ? Number(countRes.value) : NaN;
  if (live !== snapshot.apps.length) {
    console.warn(`⚠ getAppCount=${live}, expected ${snapshot.apps.length} (best-block lag is harmless; re-probe later to confirm)`);
  }

  // Points spot-check — query each leaderboard entry and count matches.
  // Best-block lag may cause transient mismatches immediately after import;
  // warn rather than error. Only probe non-dev accounts (dev balances are
  // intentionally scrubbed and must not be checked against snapshot values).
  if (leaderboard.length > 0) {
    const nonDevLeaderboard = leaderboard.filter((e) => !devSet.has(e.account.toLowerCase()));
    let pointsMatch = 0;
    for (const { account, score } of nonDevLeaderboard) {
      const pRes = await registry.getPoints.query(account);
      if (pRes.success && BigInt(pRes.value) === BigInt(score)) pointsMatch++;
    }
    const pointsMsg = `points ${pointsMatch}/${nonDevLeaderboard.length} match`;
    if (pointsMatch === nonDevLeaderboard.length) {
      console.log(pointsMsg);
    } else {
      console.warn(`⚠ ${pointsMsg} (best-block lag is likely; re-probe to confirm)`);
    }

    // snapshotAccounts used by the verify step — same definition as used in
    // reconciliation: non-dev accounts only.
    const verifySnapshotAccounts = new Set(
      nonDevLeaderboard.map((e) => e.account.toLowerCase()),
    );

    // Leaderboard size + dev-account check — re-read the live leaderboard after
    // reconciliation. Assert:
    //   1. Its size equals the number of non-dev snapshot accounts.
    //   2. No dev account appears on it.
    // Both are warnings (not crashes) since best-block lag can cause transient
    // mismatches; a persisting failure indicates a phantom regression.
    let verifyLiveAccounts: string[] = [];
    let verifyOk = true;
    try {
      // u32 params — plain numbers (matches export-registry-state.ts).
      let verifyStart = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const vRes = await registry.getTopBuilders.query(verifyStart, 100);
        if (!vRes.success) { verifyOk = false; break; }
        const page: Array<{ account: string; score: bigint }> = vRes.value;
        for (const entry of page) {
          verifyLiveAccounts.push(entry.account.toLowerCase());
        }
        if (page.length < 100) break;
        verifyStart += 100;
      }
    } catch {
      verifyOk = false;
    }
    if (verifyOk) {
      const verifyLiveSize = verifyLiveAccounts.length;
      const expectedSize = verifySnapshotAccounts.size;
      const sizeMsg = `leaderboard size live=${verifyLiveSize} expected=${expectedSize}`;
      if (verifyLiveSize === expectedSize) {
        console.log(sizeMsg);
      } else {
        console.warn(`⚠ ${sizeMsg} (best-block lag possible; re-probe to confirm — phantom regression if persists)`);
      }

      // Dev-account assertion — none should appear on the live leaderboard.
      const devOnLive = verifyLiveAccounts.filter((a) => devSet.has(a));
      if (devOnLive.length === 0) {
        console.log(`✓ no dev accounts on leaderboard`);
      } else {
        console.warn(
          `⚠ WARNING: ${devOnLive.length} dev account(s) still on live leaderboard after reconciliation:\n` +
          devOnLive.map((a) => `    ${a}`).join("\n") +
          `\n  These must be evicted before the migration is considered complete.`,
        );
      }
    } else {
      console.warn(`⚠ leaderboard size + dev-account check skipped — getTopBuilders query failed`);
    }
  }

  // Lineage count — compare on-chain total to snapshot length.
  if (lineage.length > 0) {
    const lcRes = await registry.getLineageCount.query();
    const lineageLive = lcRes.success ? Number(lcRes.value) : NaN;
    const lineageMsg = `lineage on-chain=${lineageLive} expected=${lineage.length}`;
    if (lineageLive === lineage.length) {
      console.log(lineageMsg);
    } else {
      console.warn(`⚠ ${lineageMsg} (best-block lag or pre-existing edges; re-probe to confirm)`);
    }
  }

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nMIGRATED ${snapshot.apps.length} apps, ${snapshot.pinned.length} pinned, ` +
    `${leaderboard.length} points, ${social.length} social, ` +
    `${usernames.length} usernames, ${lineage.length} lineage in ${elapsedS}s`,
  );
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`::error::import-registry-state: ${msg}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
