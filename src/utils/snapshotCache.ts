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

// Snapshot-first paint cache: the last-known XP breakdown and leaderboard
// page are persisted to localStorage so the next mount paints real values
// immediately instead of zeros/skeletons, then revalidates in background.
//
// Deliberately NOT re-exported from the `./utils` barrel: component tests
// mock the barrel wholesale, and this module must stay importable under
// vitest without dragging in the chain client.

import type { PointBreakdown } from "../PointsBreakdown";
import type { TopBuilder } from "../Leaderboard";

const PREFIX = "playground:snapshot:v1:";
const POINTS_PREFIX = `${PREFIX}points:`;
const LEADERBOARD_KEY = `${PREFIX}leaderboard`;

// The registry address the snapshots are valid for. A contract redeploy
// resets all XP, so blobs written under another address must never paint.
// The live address is only known once `contractsReady` resolves (it's read
// from the on-chain CDM meta-registry), so invalidation is a boot-time
// purge: reads before confirmation still serve the previous blob (one brief
// stale paint on the first load after a redeploy), writes are inert until
// the address is confirmed.
let liveRegistryAddr: string | null = null;

interface Envelope<T> {
  addr: string;
  at: number;
  data: T;
}

function read<T>(key: string): Envelope<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (typeof env?.addr !== "string" || env.data == null) return null;
    if (liveRegistryAddr !== null && env.addr !== liveRegistryAddr) return null;
    return env;
  } catch {
    return null;
  }
}

function write<T>(key: string, data: T): void {
  if (liveRegistryAddr === null) return;
  try {
    const env: Envelope<T> = { addr: liveRegistryAddr, at: Date.now(), data };
    localStorage.setItem(key, JSON.stringify(env));
  } catch {
    // localStorage unavailable (private browsing, quota); degraded but not broken
  }
}

/**
 * Record the live-resolved registry address and purge every snapshot written
 * under a different one. Called once at boot when `contractsReady` resolves;
 * until then `write*` calls are no-ops.
 */
export function confirmRegistryAddress(addr: string): void {
  liveRegistryAddr = addr.toLowerCase();
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const env = JSON.parse(raw) as Envelope<unknown>;
        if (env?.addr !== liveRegistryAddr) stale.push(key);
      } catch {
        stale.push(key);
      }
    }
    // Collect first, remove after — removal shifts localStorage's index.
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // ignore — worst case a stale blob survives until its next overwrite
  }
}

interface StoredPoints {
  total: string;
  launch_points: string;
  mod_points: string;
  star_points: string;
}

export function readPointsSnapshot(account: string): PointBreakdown | null {
  const env = read<StoredPoints>(POINTS_PREFIX + account.toLowerCase());
  if (!env) return null;
  try {
    return {
      total: BigInt(env.data.total),
      launch_points: BigInt(env.data.launch_points),
      mod_points: BigInt(env.data.mod_points),
      star_points: BigInt(env.data.star_points),
    };
  } catch {
    return null;
  }
}

export function writePointsSnapshot(account: string, b: PointBreakdown): void {
  write<StoredPoints>(POINTS_PREFIX + account.toLowerCase(), {
    total: b.total.toString(),
    launch_points: b.launch_points.toString(),
    mod_points: b.mod_points.toString(),
    star_points: b.star_points.toString(),
  });
}

interface StoredLeaderboard {
  entries: { account: string; score: string }[];
  usernames: [string, string | null][];
}

export interface LeaderboardSnapshot {
  entries: TopBuilder[];
  usernames: Map<string, string | null>;
}

export function readLeaderboardSnapshot(): LeaderboardSnapshot | null {
  const env = read<StoredLeaderboard>(LEADERBOARD_KEY);
  if (!env || !Array.isArray(env.data.entries) || !Array.isArray(env.data.usernames)) return null;
  try {
    return {
      entries: env.data.entries.map((e) => ({ account: e.account, score: BigInt(e.score) })),
      usernames: new Map(env.data.usernames),
    };
  } catch {
    return null;
  }
}

export function writeLeaderboardSnapshot(
  entries: TopBuilder[],
  usernames: Map<string, string | null>,
): void {
  write<StoredLeaderboard>(LEADERBOARD_KEY, {
    entries: entries.map((e) => ({ account: e.account, score: e.score.toString() })),
    usernames: [...usernames.entries()],
  });
}
