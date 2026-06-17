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

// Per-account onboarding-task completion for the island quest circles and the
// playground journey cards. The UI consumes booleans only — absence of a check
// IS the loading state. Last-known values seed SYNCHRONOUSLY from a
// localStorage snapshot (final checks paint on the first frame); chain reads
// reconcile in the background, and a FAILED read never writes — one flaky RPC
// call must not regress a cached check. Completion is detection-only (no manual
// self-attest); `star_given` has no affordable signal and is never detected.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registryReady } from "./contracts.ts";
import { withReadDeadline } from "./deadline.ts";
import { hasRevealedIdentity } from "./identity.ts";
import { getBulletinClient } from "./bulletin.ts";
import { TUTORIAL_DOMAIN } from "../config";
import type { AppMetadata } from "../App";

export type TaskId =
  | "username"
  | "deploy"
  | "tutorial"
  | "mod"
  | "star_given"
  | "mod_received"
  | "star_received";

export type Tasks = Record<TaskId, boolean>;

export interface TaskProgress {
  /** Auto-detected completion per task (the only source — no self-attest). */
  tasks: Tasks;
  /** Island quest id → detected complete. */
  questsDetected: Record<string, boolean>;
  /**
   * XP total from the same `get_point_breakdown` read the detection batch
   * already pays for; `null` until the first successful read this session.
   */
  xpTotal: bigint | null;
}

const NO_TASKS: Tasks = {
  username: false,
  deploy: false,
  tutorial: false,
  mod: false,
  star_given: false,
  mod_received: false,
  star_received: false,
};

// ---------------------------------------------------------------------------
// Snapshot storage: localStorage for the connected account (survives reload);
// an in-session Map for other accounts — nothing about other people persists
// on this device.

const SNAPSHOT_KEY = "pg.taskProgress.v1";

interface SnapshotEntry {
  /** Resolved auto-detected values. Only ever written from successful reads. */
  tasks?: Partial<Tasks>;
}

type SnapshotFile = Record<string, SnapshotEntry>;

const memorySnapshots = new Map<string, SnapshotEntry>();

function readSnapshotFile(): SnapshotFile {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SnapshotFile) : {};
  } catch {
    return {};
  }
}

function readSeed(addr: string, persist: boolean): SnapshotEntry {
  if (!persist) return memorySnapshots.get(addr) ?? {};
  return readSnapshotFile()[addr] ?? {};
}

function writeSeed(
  addr: string,
  persist: boolean,
  patch: { tasks?: Partial<Tasks> },
): void {
  if (!persist) {
    const prev = memorySnapshots.get(addr) ?? {};
    memorySnapshots.set(addr, { tasks: { ...prev.tasks, ...patch.tasks } });
    return;
  }
  try {
    const file = readSnapshotFile();
    const prev = file[addr] ?? {};
    file[addr] = { tasks: { ...prev.tasks, ...patch.tasks } };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(file));
  } catch {
    /* storage full / unavailable — snapshot is an optimisation only */
  }
}

// ---------------------------------------------------------------------------
// Reads. Each returns `null` on failure — distinguishable from a resolved
// `false`/`0` so the never-regress rule can skip the write.

/**
 * Whether the account has revealed a verified identity (its root account is
 * bound). The "claimed identity" milestone now means "revealed identity" — the
 * in-app username claim was replaced by the verified-identity flow. Kept named
 * `readUsername` so the `"username"` TaskId and its consumers stay stable.
 * `null` on read failure so the never-regress rule can skip the write.
 */
export async function readUsername(addr: string): Promise<boolean | null> {
  return hasRevealedIdentity(addr);
}

export async function readOwnerAppCount(addr: string): Promise<number | null> {
  try {
    const registry = await registryReady;
    const res = await withReadDeadline(
      registry.getOwnerAppCount.query(addr as `0x${string}`),
      "Registry owner app count",
    );
    if (!res.success) return null;
    return Number(res.value);
  } catch {
    return null;
  }
}

async function readSocialCounts(
  addr: string,
): Promise<{ modded: boolean; starred: boolean; total: bigint } | null> {
  try {
    const registry = await registryReady;
    const res = await withReadDeadline(
      registry.getPointBreakdown.query(addr as `0x${string}`),
      "Registry point breakdown",
    );
    if (!res.success) return null;
    return {
      modded: res.value.mod_points > 0n,
      starred: res.value.star_points > 0n,
      total: res.value.total,
    };
  } catch {
    return null;
  }
}

interface AutoReads {
  name: boolean | null;
  count: number | null;
  social: { modded: boolean; starred: boolean; total: bigint } | null;
}

// Concurrent mounts (island + journey cards) share ONE in-flight read set per
// (account, refresh tick); entries clear on settle so a later mount reads fresh.
const autoInflight = new Map<string, Promise<AutoReads>>();

function readAutoBatch(addr: string, tick: number): Promise<AutoReads> {
  const key = `${addr}:${tick}`;
  const hit = autoInflight.get(key);
  if (hit) return hit;
  const promise = Promise.all([
    readUsername(addr),
    readOwnerAppCount(addr),
    readSocialCounts(addr),
  ]).then(([name, count, social]) => ({ name, count, social }));
  autoInflight.set(key, promise);
  void promise.finally(() => autoInflight.delete(key));
  return promise;
}

// Bound the tutorial scan so power-user accounts don't fan out unbounded
// metadata fetches. 24 covers every realistic onboarding-era account.
const MAX_TUTORIAL_SCAN = 24;

// Bulletin metadata is content-addressed (immutable per URI) — cache fulfilled
// fetches for the session so the island + cards + profile share one round-trip.
// Failures are NOT cached (a host becoming available should be retryable).
const metadataCache = new Map<string, AppMetadata>();

async function fetchMetadataOnce(
  uri: string,
): Promise<{ ok: true; meta: AppMetadata } | { ok: false }> {
  const hit = metadataCache.get(uri);
  if (hit) return { ok: true, meta: hit };
  try {
    const client = await getBulletinClient();
    const meta = await withReadDeadline(client.fetchJson<AppMetadata>(uri), "Bulletin metadata fetch");
    metadataCache.set(uri, meta);
    return { ok: true, meta };
  } catch {
    return { ok: false };
  }
}

/**
 * One metadata pass over the account's owned apps, classifying each into ONE
 * mutually-exclusive deploy-type bucket so the three deploy quests don't all
 * light from a single deploy:
 *   - `site` — a Site Builder / `.dot` site deploy, marked `tag === "site"`,
 *   - `tutorial` — a mod of the tutorial (`moddedFrom === TUTORIAL_DOMAIN`),
 *   - `mod` — a mod of any OTHER app (non-empty `moddedFrom`, not the tutorial).
 * Per bit: `true` = match found (stands even if other reads failed);
 * `false` = everything resolved, no match; `null` = can't tell — a missing
 * blob could BE the match, so a partial no-match must not write a regression.
 */
async function scanOwnedMods(
  addr: string,
  count: number,
): Promise<{ site: boolean | null; tutorial: boolean | null; mod: boolean | null }> {
  const registry = await registryReady;
  const indexes = Array.from(
    { length: Math.min(count, MAX_TUTORIAL_SCAN) },
    (_, i) => i,
  );
  let anyReadFailed = count > MAX_TUTORIAL_SCAN;

  const uris = (
    await Promise.all(
      indexes.map(async (i) => {
        try {
          const dRes = await withReadDeadline(
            registry.getOwnerDomainAt.query(addr as `0x${string}`, i),
            "Registry owner domain",
          );
          // A None slot is a tombstone (re-claimed domain) — resolved, not a failure.
          if (!dRes.success) { anyReadFailed = true; return null; }
          if (!dRes.value?.isSome) return null;
          const mRes = await withReadDeadline(
            registry.getMetadataUri.query(dRes.value.value),
            "Registry metadata URI",
          );
          if (!mRes.success) { anyReadFailed = true; return null; }
          return mRes.value?.isSome ? mRes.value.value : null;
        } catch {
          anyReadFailed = true;
          return null;
        }
      }),
    )
  ).filter((u): u is string => u !== null);

  const results = await Promise.all(uris.map(fetchMetadataOnce));
  let site: boolean | null = false;
  let tutorial: boolean | null = false;
  let mod: boolean | null = false;
  for (const r of results) {
    if (!r.ok) continue;
    // One bucket per app: a site deploy carries no `moddedFrom`, a mod carries
    // no `"site"` tag — they're disjoint, so order only fixes the rare overlap.
    if (r.meta.tag === "site") { site = true; continue; }
    const src = r.meta.moddedFrom ?? "";
    if (src === TUTORIAL_DOMAIN) tutorial = true;
    else if (src !== "") mod = true; // a mod, but NOT of the tutorial
  }
  if (anyReadFailed || results.some((r) => !r.ok)) {
    // Positive matches stand; a no-match over an incomplete set proves nothing.
    if (site === false) site = null;
    if (tutorial === false) tutorial = null;
    if (mod === false) mod = null;
  }
  return { site, tutorial, mod };
}

// Concurrent hook instances share one scan per account — without this, the
// island and the journey cards would each fan out their own metadata fetches.
const scanInflight = new Map<string, ReturnType<typeof scanOwnedMods>>();

function scanOwnedModsOnce(addr: string, count: number) {
  const hit = scanInflight.get(addr);
  if (hit) return hit;
  const promise = scanOwnedMods(addr, count);
  scanInflight.set(addr, promise);
  void promise.finally(() => scanInflight.delete(addr));
  return promise;
}

// ---------------------------------------------------------------------------

interface UseTaskProgressOpts {
  /** Bumped by App.tsx on point-award events — triggers a background re-read. */
  pointsRefresh?: number;
  /** The signed-in H160; gates the metadata scan + localStorage persistence. */
  connectedAccount?: string;
}

export function useTaskProgress(
  account: string | undefined,
  opts: UseTaskProgressOpts = {},
): TaskProgress {
  const addr = account?.toLowerCase();
  const connected = opts.connectedAccount?.toLowerCase();
  const isSelf = !!addr && addr === connected;
  const pointsRefresh = opts.pointsRefresh ?? 0;

  // Synchronous seed — a useMemo (not an effect reset) so an account switch
  // never paints one frame of the previous account's checks.
  const seed = useMemo<SnapshotEntry>(
    () => (addr ? readSeed(addr, isSelf) : {}),
    [addr, isSelf],
  );

  // Session overlay, tagged with the account it belongs to so a stale async
  // resolve from a previous account can never leak across a switch.
  const [auto, setAuto] = useState<{ addr?: string; tasks: Partial<Tasks> }>({ tasks: {} });
  // Non-boolean facts the batch already paid for: the owned-app count feeds
  // the metadata scan (no second read) and the XP total feeds the island.
  const [chainMeta, setChainMeta] = useState<{
    addr?: string;
    count?: number;
    xpTotal?: bigint;
  }>({});

  const mergeAuto = useCallback(
    (forAddr: string, persist: boolean, next: Partial<Tasks>) => {
      if (Object.keys(next).length === 0) return;
      setAuto((prev) =>
        prev.addr === forAddr
          ? { addr: forAddr, tasks: { ...prev.tasks, ...next } }
          : { addr: forAddr, tasks: next },
      );
      writeSeed(forAddr, persist, { tasks: next });
    },
    [],
  );

  // AUTO batch: three O(1) chain reads (shared across concurrent hook
  // instances via readAutoBatch), ONE task merge (no popcorn updates).
  useEffect(() => {
    if (!addr) return;
    let cancelled = false;
    void (async () => {
      const { name, count, social } = await readAutoBatch(addr, pointsRefresh);
      if (cancelled) return;
      const next: Partial<Tasks> = {};
      if (name !== null) next.username = name;
      // `deploy`/`tutorial`/`mod` are deploy-TYPE bits — a raw count can't tell
      // a site from a tutorial mod from an app mod, so they resolve from the
      // metadata scan below. The count only proves the zero case here.
      if (count === 0) {
        next.deploy = false; // no apps ⇒ no site, no tutorial mod, no mod
        next.tutorial = false;
        next.mod = false;
      }
      if (social !== null) {
        next.mod_received = social.modded;
        next.star_received = social.starred;
      }
      mergeAuto(addr, isSelf, next);
      setChainMeta((prev) => {
        // Failed reads keep the previous value (never-regress, same as tasks).
        const base = prev.addr === addr ? prev : {};
        return {
          addr,
          count: count ?? base.count,
          xpTotal: social?.total ?? base.xpTotal,
        };
      });
    })();
    return () => { cancelled = true; };
  }, [addr, isSelf, pointsRefresh, mergeAuto]);

  // PROXY metadata scan (deploy + tutorial + mod): connected account only,
  // skipped once all three deploy-type bits are detected. The app count comes
  // from the batch above (via chainMeta) — no extra chain reads beyond the
  // per-app lookups.
  const detectedBit = (id: "tutorial" | "mod" | "deploy"): boolean =>
    (auto.addr === addr ? auto.tasks[id] : undefined) ??
    seed.tasks?.[id] ??
    false;
  const deployDone = detectedBit("deploy");
  const tutorialDone = detectedBit("tutorial");
  const modDone = detectedBit("mod");
  const ownedCount = chainMeta.addr === addr ? chainMeta.count : undefined;
  useEffect(() => {
    if (!addr || !isSelf || (deployDone && tutorialDone && modDone)) return;
    if (ownedCount === undefined || ownedCount === 0) return; // 0 handled by AUTO
    let cancelled = false;
    void (async () => {
      const result = await scanOwnedModsOnce(addr, ownedCount);
      if (cancelled) return;
      const next: Partial<Tasks> = {};
      if (result.site !== null) next.deploy = result.site;
      if (result.tutorial !== null) next.tutorial = result.tutorial;
      if (result.mod !== null) next.mod = result.mod;
      mergeAuto(addr, true, next); // null bits skipped — never regress
    })();
    return () => { cancelled = true; };
  }, [addr, isSelf, deployDone, tutorialDone, modDone, ownedCount, pointsRefresh, mergeAuto]);

  return useMemo(() => {
    const autoFor = auto.addr === addr ? auto.tasks : {};
    const seedTasks = seed.tasks ?? {};

    const resolved = (id: TaskId): boolean =>
      autoFor[id] ?? seedTasks[id] ?? false;

    // `star_given` has no affordable on-chain signal — it can never be detected,
    // so the "Give and receive stars" quest completes on `star_received` alone.
    const tasks: Tasks = addr
      ? {
          username: resolved("username"),
          deploy: resolved("deploy"),
          tutorial: resolved("tutorial"),
          mod: resolved("mod"),
          star_given: false,
          mod_received: resolved("mod_received"),
          star_received: resolved("star_received"),
        }
      : { ...NO_TASKS };

    return {
      tasks,
      questsDetected: {
        character: tasks.username,
        star: tasks.deploy,
        gates: tasks.tutorial,
        underground: tasks.mod,
        pet: tasks.mod_received,
        lights: tasks.star_received,
      },
      xpTotal: chainMeta.addr === addr ? chainMeta.xpTotal ?? null : null,
    };
  }, [addr, seed, auto, chainMeta]);
}
