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
 * Snapshot the live playground-registry into JSON for replay via
 * `import-registry-state.ts`.
 *
 * Walks `getAppCount` + `getDomainAt(i)` directly so private apps are
 * captured (`getApps` filters them per-caller). For pre-publisher
 * contracts the `publisher` column is set to `owner` (legacy contracts
 * recorded caller as owner, so they're the same address). Admins,
 * reputation, and sudo are NOT in the snapshot — see migration runbook.
 *
 * Usage:
 *   bun scripts/export-registry-state.ts [--package @staging/playground-registry]
 *                                        [--address 0x...] [--ws wss://...] [--out path.json]
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createInkSdk } from "@polkadot-api/sdk-ink";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cdmJson from "../cdm.json";

// Paseo Asset Hub does not expose ReviveApi_trace_call — polkadot-api's InkSdk
// fires a preflight compatibility check that always rejects on this node.
// The actual dry-run falls back to ReviveApi_call (which does work).
// Suppress the background trace_call unhandled rejections so they don't crash
// the process; log a single notice instead.
let traceCallNoticePrinted = false;
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("ReviveApi_trace_call")) {
    if (!traceCallNoticePrinted) {
      console.log("  (ReviveApi_trace_call not available on this node — dry-run uses ReviveApi_call fallback, reads work fine)");
      traceCallNoticePrinted = true;
    }
    return; // suppress: queries succeed via the call fallback
  }
  // Re-throw anything else as a genuine fatal error.
  console.error("Unhandled rejection:", reason);
  process.exitCode = 1;
});

const DEFAULT_REGISTRY_PACKAGE = "@w3s/playground-registry";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  package: string;
  address?: string;
  ws?: string;
  out?: string;
  // A read-only origin is required by InkSdk's query API. The actual address
  // doesn't matter for view methods — default to Alice's well-known SS58.
  origin: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    package: DEFAULT_REGISTRY_PACKAGE,
    origin: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--address") out.address = argv[++i];
    else if (a === "--ws") out.ws = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--origin") out.origin = argv[++i];
    else if (a === "--package") out.package = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: bun scripts/export-registry-state.ts [--package @staging/playground-registry] [--address 0x...] [--ws wss://...] [--out path.json] [--origin 0x...]",
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const REGISTRY_PACKAGE = args.package;

// ---------------------------------------------------------------------------
// Resolve target from cdm.json
// ---------------------------------------------------------------------------

const contracts = (cdmJson as any).contracts as
  | Record<string, { address: string; version: number; abi: unknown[] }>
  | undefined;
const registryEntryOpt = contracts?.[REGISTRY_PACKAGE];
if (!registryEntryOpt) {
  throw new Error(`cdm.json has no ${REGISTRY_PACKAGE} entry`);
}
// Re-bind so the narrowing survives async closures below (TS doesn't
// propagate guard narrowing into nested function scopes).
const registryEntry = registryEntryOpt;
// Default to the Paseo Next v2 endpoint that matches `-n paseo`.
const wsUrl = args.ws ?? process.env.ASSET_HUB_WS_URL ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const registryAddr = (args.address ?? registryEntry.address) as `0x${string}`;
const abi = registryEntry.abi as Array<{ type: string; name?: string }>;

// Determine which methods are present in the resolved ABI (used to guard
// on-chain lineage reads against older contract versions).
const abiMethodNames = new Set(
  abi.filter((e) => e.type === "function").map((e) => e.name ?? ""),
);

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  args.out ??
    `migration/registry-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);

console.log(`Source : ${REGISTRY_PACKAGE} v${registryEntry.version} @ ${registryAddr}`);
console.log(`Network: ${wsUrl}`);
console.log(`Output : ${outPath}`);
console.log(`Lineage on-chain: ${abiMethodNames.has("getLineage") ? "YES (v14+)" : "NO (older ABI)"}`);
console.log();

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

const client = createClient(getWsProvider(wsUrl));
const ink = createInkSdk(client);
const registry: any = ink.getContract({ abi } as any, registryAddr);
const origin = args.origin;

async function call<T = unknown>(method: string, data?: Record<string, unknown>): Promise<T> {
  const r = await registry.query(method, data === undefined ? { origin } : { origin, data });
  if (!r.success) {
    throw new Error(`${method}: query failed — ${JSON.stringify(r.value ?? r, null, 2)}`);
  }
  return normalize(r.value.response) as T;
}

// The InkSdk returns bytes32/address fields as Uint8Array. Convert to 0x-hex
// recursively so the snapshot JSON is human-readable and easy to re-encode.
function normalize(v: any): any {
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

// Some ABI return shapes wrap optionals as { isSome, value } tuples — unwrap.
function unwrapOption<T>(v: any): T | null {
  if (v && typeof v === "object" && "isSome" in v) return v.isSome ? (v.value as T) : null;
  return (v ?? null) as T | null;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface ExportedApp {
  /** Slot index in the source. Informational; new registry reindexes on import. */
  source_index: number;
  domain: string;
  metadata_uri: string;
  owner: `0x${string}`;
  /** Pre-publisher contracts don't store this — see file header for the
   *  publisher = owner fallback used in that case. */
  publisher: `0x${string}`;
  visibility: number;
  /** Derived from the on-Bulletin metadata's `repository` field at export
   *  time. Drives the launch-point award size when `import_one` replays
   *  the app (3 if true, 2 if false). Defaults to `false` when metadata
   *  is unreachable or malformed — same shape as a re-publish without
   *  `--moddable`. */
  is_moddable: boolean;
  /** Source domain recorded in Bulletin metadata (one of modded_from /
   *  moddedFrom / source / modSource). Empty string when absent. */
  modded_from: string;
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

interface LineageSnapEntry {
  child: string;
  source: string;
}

interface Snapshot {
  format_version: 2;
  exported_at: string;
  source: {
    network: string;
    package: string;
    address: `0x${string}`;
    version: number;
  };
  context_id: `0x${string}`;
  app_count_onchain: number;
  apps: ExportedApp[];
  pinned: string[];
  leaderboard: LeaderboardEntry[];
  social: SocialEntry[];
  usernames: UsernameEntry[];
  lineage: LineageSnapEntry[];
  notes: {
    skipped_slots: number;
    private_apps: number;
    public_apps: number;
    /** Number of apps where probing Bulletin for the `repository` field
     *  failed (network, malformed JSON, missing field). These were stored
     *  with `is_moddable=false`. Owners can re-publish to set it true. */
    moddable_defaulted_false: number;
    /** Lineage edges read from the on-chain getLineage method (0 when ABI
     *  lacks the method). */
    lineage_onchain: number;
    /** Lineage edges inferred from app Bulletin metadata fields. */
    lineage_from_metadata: number;
  };
}

// Fetch the Bulletin metadata JSON for an app and report both whether it has
// a `repository` field and the `modded_from` source domain it records.
// Extracts source from the first present key among:
//   ["modded_from","moddedFrom","source","modSource"]
// Returns both in a single fetch so we never double-fetch the same CID.
// On any fetch / parse failure we default to safe values — losing a moddable
// bit per migration is a re-publish away from being correctable.
// Defaults to Paseo Next v2; override with `BULLETIN_GATEWAY_URL` for Summit
// (`https://summit-ipfs.polkadot.io/ipfs`) — same env name as cleanup-e2e-leaks.ts.
const BULLETIN_GATEWAY =
  process.env.BULLETIN_GATEWAY_URL ?? "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs";
const METADATA_FETCH_TIMEOUT_MS = 10_000;
const SOURCE_DOMAIN_KEYS = ["modded_from", "moddedFrom", "source", "modSource"] as const;

async function probeMeta(metadataUri: string): Promise<{ isModdable: boolean; moddedFrom: string }> {
  if (!metadataUri) return { isModdable: false, moddedFrom: "" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), METADATA_FETCH_TIMEOUT_MS);
  try {
    const url = `${BULLETIN_GATEWAY}/${metadataUri}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { isModdable: false, moddedFrom: "" };
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return { isModdable: false, moddedFrom: "" };
    const meta = json as Record<string, unknown>;
    const repo = meta["repository"];
    const isModdable = typeof repo === "string" && repo.length > 0;
    let moddedFrom = "";
    for (const key of SOURCE_DOMAIN_KEYS) {
      const v = meta[key];
      if (typeof v === "string" && v.length > 0) {
        moddedFrom = v;
        break;
      }
    }
    return { isModdable, moddedFrom };
  } catch {
    return { isModdable: false, moddedFrom: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function snapshot(): Promise<Snapshot> {
  const contextId = (await call<`0x${string}`>("getContextId")) as `0x${string}`;
  const appCount = Number(await call<number | bigint>("getAppCount"));
  console.log(`getContextId  = ${contextId}`);
  console.log(`getAppCount   = ${appCount}`);

  const apps: ExportedApp[] = [];
  let skipped = 0;
  let priv = 0;
  let pub = 0;
  let moddable_unreachable = 0;
  // Map domain -> raw moddedFrom string (from Bulletin metadata), filled
  // during the app scan loop so we can resolve lineage sources later.
  const metaSourceByDomain = new Map<string, string>();

  for (let i = 0; i < appCount; i++) {
    const domain = unwrapOption<string>(await call("getDomainAt", { index: i }));
    if (domain === null) {
      skipped++;
      continue;
    }
    const [metadataUriRaw, owner, visibilityRaw] = await Promise.all([
      call("getMetadataUri", { domain }),
      call<`0x${string}`>("getOwner", { domain }),
      call<number>("getVisibility", { domain }),
    ]);
    const metadataUri = unwrapOption<string>(metadataUriRaw) ?? "";
    const visibility = Number(visibilityRaw);
    if (visibility === 0) priv++;
    else pub++;
    const { isModdable, moddedFrom } = await probeMeta(metadataUri);
    if (!isModdable && metadataUri) moddable_unreachable++;
    if (moddedFrom) metaSourceByDomain.set(domain, moddedFrom);
    apps.push({
      source_index: i,
      domain,
      metadata_uri: metadataUri,
      owner,
      publisher: owner,
      visibility,
      is_moddable: isModdable,
      modded_from: moddedFrom,
    });
    if ((i + 1) % 25 === 0 || i + 1 === appCount) {
      console.log(`  scanned ${i + 1}/${appCount}  kept=${apps.length}  skipped=${skipped}`);
    }
  }
  if (moddable_unreachable > 0) {
    console.log(`  (${moddable_unreachable} apps defaulted is_moddable=false — see notes.moddable_defaulted_false)`);
  }

  // Pinned order matters: importPinned must be called in this order to
  // preserve pinned_at indices on the new registry.
  const pinnedEntries =
    (await call<Array<{ domain: string }>>("getPinnedApps")) ?? [];
  const pinned = pinnedEntries.map((e) => e.domain);
  console.log(`getPinnedApps = ${pinned.length}`);

  // ---------------------------------------------------------------------------
  // Leaderboard — page getTopBuilders until a page returns fewer than 100
  // NOTE: getTopBuilders(start, 0) short-circuits to [], always use count > 0.
  // ---------------------------------------------------------------------------
  const leaderboard: LeaderboardEntry[] = [];
  {
    const PAGE = 100;
    let start = 0;
    while (true) {
      const page = await call<Array<{ account: `0x${string}`; score: bigint | number }>>(
        "getTopBuilders",
        { start, count: PAGE },
      );
      for (const e of page) {
        leaderboard.push({ account: e.account, score: BigInt(e.score).toString() });
      }
      if (page.length < PAGE) break;
      start += PAGE;
    }
    console.log(`leaderboard   = ${leaderboard.length} accounts`);
  }

  // ---------------------------------------------------------------------------
  // Social counts — fetch star_count + mod_count per captured app.
  // Keep only entries where at least one count is non-zero.
  // ---------------------------------------------------------------------------
  const social: SocialEntry[] = [];
  {
    for (const app of apps) {
      const [starRaw, modRaw] = await Promise.all([
        call<number | bigint>("getStarCount", { domain: app.domain }),
        call<number | bigint>("getModCount", { domain: app.domain }),
      ]);
      const star_count = Number(starRaw);
      const mod_count = Number(modRaw);
      if (star_count > 0 || mod_count > 0) {
        social.push({ domain: app.domain, star_count, mod_count });
      }
    }
    console.log(`social (non-zero) = ${social.length}`);
  }

  // ---------------------------------------------------------------------------
  // Usernames — no enumeration getter.
  // Build candidate set from all app owners ∪ all leaderboard accounts,
  // dedup case-insensitively, then batch-query via getUsernames if available
  // (single call), else fall back to individual getUsername calls.
  // ---------------------------------------------------------------------------
  const usernames: UsernameEntry[] = [];
  {
    const seenLower = new Set<string>();
    const candidates: `0x${string}`[] = [];
    const addCandidate = (addr: `0x${string}`) => {
      const lower = addr.toLowerCase();
      if (!seenLower.has(lower)) {
        seenLower.add(lower);
        candidates.push(addr);
      }
    };
    for (const app of apps) addCandidate(app.owner);
    for (const e of leaderboard) addCandidate(e.account);

    if (abiMethodNames.has("getUsernames") && candidates.length > 0) {
      // Batch fetch: getUsernames(address[]) -> string[]
      // Pass as an array to the ABI param named "accounts".
      const names = await call<string[]>("getUsernames", { accounts: candidates });
      for (let i = 0; i < candidates.length; i++) {
        const name = names[i];
        if (typeof name === "string" && name.length > 0) {
          usernames.push({ account: candidates[i], name });
        }
      }
    } else {
      // Fallback: individual calls
      for (const account of candidates) {
        const name = await call<string>("getUsername", { account });
        if (typeof name === "string" && name.length > 0) {
          usernames.push({ account, name });
        }
      }
    }
    console.log(`usernames     = ${usernames.length}`);
  }

  // ---------------------------------------------------------------------------
  // Lineage — union of on-chain (if ABI has getLineage) + Bulletin metadata.
  // On-chain entry wins when a child appears in both sources.
  // ---------------------------------------------------------------------------
  const lineage: LineageSnapEntry[] = [];
  let lineage_onchain = 0;
  let lineage_from_metadata = 0;
  {
    const knownDomains = new Set(apps.map((a) => a.domain));

    // --- On-chain source (v14+) ---
    const onchainByChild = new Map<string, string>();
    if (abiMethodNames.has("getLineage")) {
      try {
        const lineageCount = Number(await call<number | bigint>("getLineageCount"));
        const PAGE = 200;
        let start = 0;
        while (start < lineageCount) {
          const page = await call<Array<{ child: string; source: string }>>(
            "getLineage",
            { start, count: PAGE },
          );
          for (const e of page) {
            onchainByChild.set(e.child, e.source);
          }
          if (page.length < PAGE) break;
          start += PAGE;
        }
        lineage_onchain = onchainByChild.size;
      } catch (err) {
        console.warn(
          `  WARNING: getLineage call failed (${err instanceof Error ? err.message : String(err)}); continuing with metadata-only lineage`,
        );
      }
    }

    // --- Metadata source ---
    const metaByChild = new Map<string, string>();
    for (const [domain, sourceDomain] of metaSourceByDomain) {
      // Only record if source is a known domain and not self-referential.
      if (sourceDomain && knownDomains.has(sourceDomain) && sourceDomain !== domain) {
        metaByChild.set(domain, sourceDomain);
      }
    }
    lineage_from_metadata = metaByChild.size;

    // --- Union: on-chain wins on conflict ---
    const unionByChild = new Map<string, string>([...metaByChild, ...onchainByChild]);
    for (const [child, source] of unionByChild) {
      lineage.push({ child, source });
    }

    console.log(
      `lineage       = ${lineage.length} (onchain=${lineage_onchain}, metadata=${lineage_from_metadata})`,
    );
  }

  return {
    format_version: 2,
    exported_at: new Date().toISOString(),
    source: {
      network: wsUrl,
      package: REGISTRY_PACKAGE,
      address: registryAddr,
      version: registryEntry.version,
    },
    context_id: contextId,
    app_count_onchain: appCount,
    apps,
    pinned,
    leaderboard,
    social,
    usernames,
    lineage,
    notes: {
      skipped_slots: skipped,
      private_apps: priv,
      public_apps: pub,
      moddable_defaulted_false: moddable_unreachable,
      lineage_onchain,
      lineage_from_metadata,
    },
  };
}

const startedAt = Date.now();
try {
  const snap = await snapshot();

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snap, null, 2) + "\n");

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log();
  console.log(
    `EXPORTED ${snap.apps.length} apps (${snap.notes.public_apps} public, ${snap.notes.private_apps} private), ` +
      `${snap.pinned.length} pinned, ` +
      `${snap.leaderboard.length} leaderboard, ` +
      `${snap.social.length} social, ` +
      `${snap.usernames.length} usernames, ` +
      `${snap.lineage.length} lineage ` +
      `to ${outPath} in ${elapsedS}s`,
  );
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`::error::export-registry-state: ${msg}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}

process.exit(process.exitCode ?? 0);
