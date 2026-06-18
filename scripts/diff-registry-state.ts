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
 * Diffs two registry-state snapshots (produced by export-registry-state.ts,
 * format_version 2) and asserts parity for contract migration verification.
 *
 * Usage:
 *   pnpm tsx scripts/diff-registry-state.ts <before.json> <after.json>
 *
 * Exit codes:
 *   0 — no hard diffs (warnings allowed)
 *   1 — one or more hard diffs detected
 *   2 — bad usage / file not found
 */

import { readFileSync, existsSync } from "node:fs";
import { DEV_ACCOUNTS } from "./_lib.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExportedApp {
  domain: string;
  metadata_uri: string;
  owner: string;
  publisher: string;
  visibility: number;
  is_moddable?: boolean;
  modded_from?: string;
}

interface LeaderboardEntry {
  account: string;
  score: string; // u128 decimal string
}

interface SocialEntry {
  domain: string;
  star_count: number;
  mod_count: number;
}

interface UsernameEntry {
  account: string;
  name: string;
}

interface LineageEdge {
  child: string;
  source: string;
}

interface SnapshotSource {
  network: string;
  package: string;
  address: string;
  version: number;
}

interface Snapshot {
  format_version: number;
  source: SnapshotSource;
  apps: ExportedApp[];
  pinned: string[];
  leaderboard: LeaderboardEntry[];
  social: SocialEntry[];
  usernames: UsernameEntry[];
  lineage: LineageEdge[];
  notes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseAddr(addr: string): string {
  return addr.toLowerCase();
}

function loadSnapshot(filePath: string): Snapshot {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Snapshot>;
  return {
    format_version: parsed.format_version ?? 0,
    source: parsed.source ?? { network: "", package: "", address: "", version: 0 },
    apps: parsed.apps ?? [],
    pinned: parsed.pinned ?? [],
    leaderboard: parsed.leaderboard ?? [],
    social: parsed.social ?? [],
    usernames: parsed.usernames ?? [],
    lineage: parsed.lineage ?? [],
    notes: parsed.notes,
  };
}

// ---------------------------------------------------------------------------
// Diff accumulators
// ---------------------------------------------------------------------------

let hardDiffs = 0;
const warnings: string[] = [];

function hard(msg: string): void {
  hardDiffs++;
  console.log(`  ✗ HARD: ${msg}`);
}

function warn(msg: string): void {
  warnings.push(msg);
  console.log(`  ⚠ WARN: ${msg}`);
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Apps
// ---------------------------------------------------------------------------

function diffApps(before: Snapshot, after: Snapshot): void {
  console.log("\n── Apps ──────────────────────────────────────────────");

  const beforeMap = new Map<string, ExportedApp>(
    before.apps.map((a) => [a.domain, a])
  );
  const afterMap = new Map<string, ExportedApp>(
    after.apps.map((a) => [a.domain, a])
  );

  const allDomains = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let appHardDiffs = 0;
  let appWarnings = 0;

  for (const domain of [...allDomains].sort()) {
    const b = beforeMap.get(domain);
    const a = afterMap.get(domain);

    if (!b) {
      hard(`domain present in after but missing in before: ${domain}`);
      appHardDiffs++;
      continue;
    }
    if (!a) {
      hard(`domain present in before but missing in after: ${domain}`);
      appHardDiffs++;
      continue;
    }

    // owner (case-insensitive)
    if (normaliseAddr(b.owner) !== normaliseAddr(a.owner)) {
      hard(`[${domain}] owner mismatch: before=${b.owner} after=${a.owner}`);
      appHardDiffs++;
    }

    // visibility
    if (b.visibility !== a.visibility) {
      hard(`[${domain}] visibility mismatch: before=${b.visibility} after=${a.visibility}`);
      appHardDiffs++;
    }

    // metadata_uri
    if (b.metadata_uri !== a.metadata_uri) {
      hard(`[${domain}] metadata_uri mismatch: before=${b.metadata_uri} after=${a.metadata_uri}`);
      appHardDiffs++;
    }

    // publisher — legitimate to differ post-migration
    if (normaliseAddr(b.publisher) !== normaliseAddr(a.publisher)) {
      warn(`[${domain}] publisher differs (expected post-migration): before=${b.publisher} after=${a.publisher}`);
      appWarnings++;
    }

    // is_moddable — best-effort (derived from Bulletin metadata at export time),
    // so a flip is usually a flaky gateway during one of the exports rather than
    // a migration fault. Warn so it's visible without failing parity.
    if ((b.is_moddable ?? false) !== (a.is_moddable ?? false)) {
      warn(`[${domain}] is_moddable differs (likely a flaky Bulletin read during export): before=${b.is_moddable ?? false} after=${a.is_moddable ?? false}`);
      appWarnings++;
    }
  }

  if (appHardDiffs === 0) {
    ok(`${allDomains.size} domain(s) match (owner, visibility, metadata_uri)`);
  }
  if (appWarnings === 0 && appHardDiffs === 0) {
    ok("publisher fields identical across all domains");
  }
}

// ---------------------------------------------------------------------------
// 2. Pinned
// ---------------------------------------------------------------------------

function diffPinned(before: Snapshot, after: Snapshot): void {
  console.log("\n── Pinned ────────────────────────────────────────────");

  const b = before.pinned;
  const a = after.pinned;

  if (b.length !== a.length) {
    hard(`pinned array length differs: before=${b.length} after=${a.length}`);
    return;
  }

  let mismatch = false;
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== a[i]) {
      hard(`pinned[${i}] differs: before="${b[i]}" after="${a[i]}"`);
      mismatch = true;
    }
  }

  if (!mismatch) {
    ok(`${b.length} pinned entry/entries match (ordered)`);
  }
}

// ---------------------------------------------------------------------------
// 3. Leaderboard
// ---------------------------------------------------------------------------

function diffLeaderboard(before: Snapshot, after: Snapshot): void {
  console.log("\n── Leaderboard ───────────────────────────────────────");

  // Dev accounts that must never hold points on the migrated contract.
  const devSet = new Set(DEV_ACCOUNTS.map(normaliseAddr));

  const beforeMap = new Map<string, string>(
    before.leaderboard.map((e) => [normaliseAddr(e.account), e.score])
  );
  const afterMap = new Map<string, string>(
    after.leaderboard.map((e) => [normaliseAddr(e.account), e.score])
  );

  const allAccounts = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  // Collect rows for the side-by-side table
  type Row = {
    account: string;
    bScore: string;
    aScore: string;
    ok: boolean;
    isDev: boolean;
    devScrubbed: boolean;
  };
  const rows: Row[] = [];
  let lbHardDiffs = 0;

  for (const account of allAccounts) {
    const bScore = beforeMap.get(account) ?? "(missing)";
    const aScore = afterMap.get(account) ?? "(missing)";
    const isDev = devSet.has(account);

    if (isDev) {
      // Dev account in before with points → expected scrub, not a hard diff.
      if (bScore !== "(missing)" && bScore !== "0") {
        warn(
          `dev account ${account} had ${bScore} points on source — scrubbed by migration (expected)`
        );
      }
      // Dev account in after with points → hard diff regardless.
      if (aScore !== "(missing)" && aScore !== "0") {
        hard(
          `dev account ${account} must not have points on the migrated contract (after=${aScore})`
        );
        lbHardDiffs++;
      }
      rows.push({ account, bScore, aScore, ok: aScore === "(missing)" || aScore === "0", isDev, devScrubbed: true });
      continue;
    }

    // Non-dev account: exact set + score parity required.
    const match = bScore !== "(missing)" && aScore !== "(missing)" && bScore === aScore;
    rows.push({ account, bScore, aScore, ok: match, isDev: false, devScrubbed: false });
    if (!match) lbHardDiffs++;
  }

  // Sort by before-score descending (treat missing as 0 for sort)
  rows.sort((x, y) => {
    const bx = BigInt(x.bScore === "(missing)" ? "0" : x.bScore);
    const by = BigInt(y.bScore === "(missing)" ? "0" : y.bScore);
    if (by > bx) return 1;
    if (by < bx) return -1;
    return 0;
  });

  // Print side-by-side table
  const COL_ACCT = 44;
  const COL_SCORE = 22;
  const header =
    "account".padEnd(COL_ACCT) +
    "before-score".padStart(COL_SCORE) +
    "after-score".padStart(COL_SCORE) +
    "  status";
  const sep = "─".repeat(header.length);
  console.log(`\n  ${header}`);
  console.log(`  ${sep}`);
  for (const row of rows) {
    let status: string;
    let marker: string;
    if (row.isDev && row.devScrubbed) {
      status = row.ok ? "DEV/scrubbed" : "DEV/ERROR";
      marker = row.ok ? "  " : "✗ ";
    } else {
      status = row.ok ? "OK" : "DIFF";
      marker = row.ok ? "  " : "✗ ";
    }
    console.log(
      `  ${marker}${row.account.padEnd(COL_ACCT - 2)}` +
        row.bScore.padStart(COL_SCORE) +
        row.aScore.padStart(COL_SCORE) +
        `  ${status}`
    );
  }
  console.log();

  if (lbHardDiffs > 0) {
    for (const row of rows.filter((r) => !r.ok && !r.devScrubbed)) {
      hard(
        `leaderboard account ${row.account}: before=${row.bScore} after=${row.aScore}`
      );
    }
  } else {
    const nonDevCount = rows.filter((r) => !r.isDev).length;
    ok(`${nonDevCount} non-dev leaderboard entry/entries match`);
  }
}

// ---------------------------------------------------------------------------
// 4. Social
// ---------------------------------------------------------------------------

function diffSocial(before: Snapshot, after: Snapshot): void {
  console.log("\n── Social (star/mod counts) ──────────────────────────");

  // Only consider domains with non-zero counts
  const beforeMap = new Map<string, SocialEntry>(
    before.social
      .filter((s) => s.star_count !== 0 || s.mod_count !== 0)
      .map((s) => [s.domain, s])
  );
  const afterMap = new Map<string, SocialEntry>(
    after.social
      .filter((s) => s.star_count !== 0 || s.mod_count !== 0)
      .map((s) => [s.domain, s])
  );

  const allDomains = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let socialHardDiffs = 0;

  for (const domain of [...allDomains].sort()) {
    const b = beforeMap.get(domain);
    const a = afterMap.get(domain);

    if (!b) {
      hard(`social domain in after but not before (non-zero counts): ${domain}`);
      socialHardDiffs++;
      continue;
    }
    if (!a) {
      hard(`social domain in before but not after (non-zero counts): ${domain}`);
      socialHardDiffs++;
      continue;
    }

    if (b.star_count !== a.star_count) {
      hard(`[${domain}] star_count mismatch: before=${b.star_count} after=${a.star_count}`);
      socialHardDiffs++;
    }
    if (b.mod_count !== a.mod_count) {
      hard(`[${domain}] mod_count mismatch: before=${b.mod_count} after=${a.mod_count}`);
      socialHardDiffs++;
    }
  }

  if (socialHardDiffs === 0) {
    ok(`${allDomains.size} domain(s) with non-zero social counts match`);
  }
}

// ---------------------------------------------------------------------------
// 5. Usernames
// ---------------------------------------------------------------------------

function diffUsernames(before: Snapshot, after: Snapshot): void {
  console.log("\n── Usernames ─────────────────────────────────────────");

  const beforeMap = new Map<string, string>(
    before.usernames.map((u) => [normaliseAddr(u.account), u.name])
  );
  const afterMap = new Map<string, string>(
    after.usernames.map((u) => [normaliseAddr(u.account), u.name])
  );

  const allAccounts = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let usernameHardDiffs = 0;

  for (const account of [...allAccounts].sort()) {
    const b = beforeMap.get(account);
    const a = afterMap.get(account);

    if (b === undefined) {
      hard(`username account in after but not before: ${account} → "${a}"`);
      usernameHardDiffs++;
      continue;
    }
    if (a === undefined) {
      hard(`username account in before but not after: ${account} → "${b}"`);
      usernameHardDiffs++;
      continue;
    }
    if (b !== a) {
      hard(`[${account}] username mismatch: before="${b}" after="${a}"`);
      usernameHardDiffs++;
    }
  }

  if (usernameHardDiffs === 0) {
    ok(`${allAccounts.size} username mapping(s) match`);
  }
}

// ---------------------------------------------------------------------------
// 6. Lineage (superset check)
// ---------------------------------------------------------------------------

function diffLineage(before: Snapshot, after: Snapshot): void {
  console.log("\n── Lineage (superset check) ──────────────────────────");

  const edgeKey = (e: LineageEdge): string => `${e.child}|${e.source}`;

  const beforeEdges = new Set(before.lineage.map(edgeKey));
  const afterEdges = new Set(after.lineage.map(edgeKey));

  // Every before-edge must appear in after
  let missingInAfter = 0;
  for (const key of beforeEdges) {
    if (!afterEdges.has(key)) {
      const [child, source] = key.split("|");
      hard(`lineage edge present in before but missing in after: child=${child} source=${source}`);
      missingInAfter++;
    }
  }

  // Extra edges in after — warnings only
  let extraInAfter = 0;
  for (const key of afterEdges) {
    if (!beforeEdges.has(key)) {
      const [child, source] = key.split("|");
      warn(`lineage edge in after but not before (new since snapshot): child=${child} source=${source}`);
      extraInAfter++;
    }
  }

  if (missingInAfter === 0) {
    ok(
      `after.lineage is a superset of before.lineage ` +
        `(${beforeEdges.size} preserved, ${extraInAfter} new in after)`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const [, , beforePath, afterPath] = process.argv;

  if (!beforePath || !afterPath) {
    console.error(
      "Usage: pnpm tsx scripts/diff-registry-state.ts <before.json> <after.json>"
    );
    process.exit(2);
  }

  if (!existsSync(beforePath)) {
    console.error(`File not found: ${beforePath}`);
    console.error(
      "Usage: pnpm tsx scripts/diff-registry-state.ts <before.json> <after.json>"
    );
    process.exit(2);
  }

  if (!existsSync(afterPath)) {
    console.error(`File not found: ${afterPath}`);
    console.error(
      "Usage: pnpm tsx scripts/diff-registry-state.ts <before.json> <after.json>"
    );
    process.exit(2);
  }

  const before = loadSnapshot(beforePath);
  const after = loadSnapshot(afterPath);

  console.log("=== Registry State Diff ===");
  console.log(`  before : ${beforePath}`);
  console.log(
    `           address=${before.source.address}  version=${before.source.version}  network=${before.source.network}`
  );
  console.log(`  after  : ${afterPath}`);
  console.log(
    `           address=${after.source.address}  version=${after.source.version}  network=${after.source.network}`
  );

  diffApps(before, after);
  diffPinned(before, after);
  diffLeaderboard(before, after);
  diffSocial(before, after);
  diffUsernames(before, after);
  diffLineage(before, after);

  console.log("\n══════════════════════════════════════════════════════");

  if (warnings.length > 0) {
    console.log(`  Warnings: ${warnings.length}`);
  }

  if (hardDiffs === 0) {
    console.log("  PARITY OK");
    process.exit(0);
  } else {
    console.log(`  PARITY FAILED: ${hardDiffs} hard diff(s)`);
    process.exit(1);
  }
}

main();
