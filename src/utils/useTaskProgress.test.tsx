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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { useRef } from "react";

const getOwnerAppCount = vi.fn();
const getPointBreakdown = vi.fn();
const getOwnerDomainAt = vi.fn();
const getMetadataUri = vi.fn();
vi.mock("./contracts.ts", () => ({
  registryReady: Promise.resolve({
    getOwnerAppCount: { query: (...a: unknown[]) => getOwnerAppCount(...a) },
    getPointBreakdown: { query: (...a: unknown[]) => getPointBreakdown(...a) },
    getOwnerDomainAt: { query: (...a: unknown[]) => getOwnerDomainAt(...a) },
    getMetadataUri: { query: (...a: unknown[]) => getMetadataUri(...a) },
  }),
}));

// `readUsername` now delegates to identity's `hasRevealedIdentity` (the "claimed
// identity" milestone = "revealed identity"): boolean = bound/unbound, null =
// read failure (never-regress).
const hasRevealedIdentity = vi.fn();
vi.mock("./identity.ts", () => ({
  hasRevealedIdentity: (...a: unknown[]) => hasRevealedIdentity(...a),
}));

const fetchJson = vi.fn();
vi.mock("./bulletin.ts", () => ({
  getBulletinClient: () => Promise.resolve({ fetchJson }),
}));

import { useTaskProgress, type TaskProgress, type TaskId } from "./useTaskProgress";
import { TUTORIAL_DOMAIN } from "../config";

const SNAPSHOT_KEY = "pg.taskProgress.v1";

// Harness: renders the hook's state as data-attributes and exposes the
// progress object through a ref the tests can read.
function Probe({
  account,
  connected,
  refresh = 0,
  api,
}: {
  account?: string;
  connected?: string;
  refresh?: number;
  api: { current: TaskProgress | null };
}) {
  const apiRef = useRef(api);
  const progress = useTaskProgress(account, {
    pointsRefresh: refresh,
    connectedAccount: connected,
  });
  apiRef.current.current = progress;
  return (
    <div
      data-testid="probe"
      data-tasks={JSON.stringify(progress.tasks)}
      data-quests-detected={JSON.stringify(progress.questsDetected)}
    />
  );
}

function readTasks(): Record<TaskId, boolean> {
  return JSON.parse(screen.getByTestId("probe").getAttribute("data-tasks")!);
}

function readQuestsDetected(): Record<string, boolean> {
  return JSON.parse(
    screen.getByTestId("probe").getAttribute("data-quests-detected")!,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function snapshotFor(addr: string) {
  const raw = localStorage.getItem(SNAPSHOT_KEY);
  return raw ? (JSON.parse(raw)[addr.toLowerCase()] ?? null) : null;
}

// Distinct accounts per test — the hook keeps module-level session caches.
let acctCounter = 0;
function freshAccount(): string {
  acctCounter += 1;
  return `0x${acctCounter.toString(16).padStart(40, "0")}`;
}

beforeEach(() => {
  localStorage.clear();
  hasRevealedIdentity.mockReset().mockResolvedValue(false);
  getOwnerAppCount.mockReset().mockResolvedValue({ success: true, value: 0 });
  getPointBreakdown.mockReset().mockResolvedValue({
    success: true,
    value: { launch_points: 0n, mod_points: 0n, star_points: 0n, total: 0n },
  });
  getOwnerDomainAt.mockReset();
  getMetadataUri.mockReset();
  fetchJson.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useTaskProgress — auto detection", () => {
  it("resolves AUTO tasks from chain reads and persists the snapshot", async () => {
    const acct = freshAccount();
    hasRevealedIdentity.mockResolvedValue(true);
    getOwnerAppCount.mockResolvedValue({ success: true, value: 2 });
    getPointBreakdown.mockResolvedValue({
      success: true,
      value: { launch_points: 0n, mod_points: 1n, star_points: 0n, total: 175n },
    });
    // `deploy` is no longer derived from the count — it resolves from the
    // metadata scan when an owned app carries the `"site"` tag.
    getOwnerDomainAt.mockResolvedValue({
      success: true,
      value: { isSome: true, value: "my-site.dot" },
    });
    getMetadataUri.mockResolvedValue({
      success: true,
      value: { isSome: true, value: `uri-site-${acct}` },
    });
    fetchJson.mockResolvedValue({ name: "My site", tag: "site" });
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    const tasks = readTasks();
    expect(tasks.username).toBe(true);
    expect(tasks.deploy).toBe(true);
    expect(tasks.mod_received).toBe(true);
    expect(tasks.star_received).toBe(false);
    // Snapshot written for the connected account → next mount seeds from it.
    expect(snapshotFor(acct)?.tasks).toMatchObject({
      username: true,
      deploy: true,
      mod_received: true,
      star_received: false,
    });
  });

  it("seeds synchronously from the snapshot — complete on the FIRST render, before any read", async () => {
    const acct = freshAccount();
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ [acct]: { tasks: { username: true, deploy: true } } }),
    );
    // Reads stall forever — first paint must not depend on them.
    hasRevealedIdentity.mockReturnValue(new Promise(() => {}));
    getOwnerAppCount.mockReturnValue(new Promise(() => {}));
    getPointBreakdown.mockReturnValue(new Promise(() => {}));
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);

    const tasks = readTasks(); // no flush — synchronous seed
    expect(tasks.username).toBe(true);
    expect(tasks.deploy).toBe(true);
  });

  it("never regresses a cached check on read FAILURE (failure ≠ resolved false)", async () => {
    const acct = freshAccount();
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ [acct]: { tasks: { username: true } } }),
    );
    hasRevealedIdentity.mockResolvedValue(null); // read failed → never-regress
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().username).toBe(true); // still complete
    expect(snapshotFor(acct)?.tasks?.username).toBe(true); // not overwritten
  });

  it("DOES apply a resolved false (e.g. identity cleared on-chain)", async () => {
    const acct = freshAccount();
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ [acct]: { tasks: { username: true } } }),
    );
    hasRevealedIdentity.mockResolvedValue(false); // truthful false
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().username).toBe(false);
  });
});

describe("useTaskProgress — metadata proxy scan (deploy + tutorial + mod)", () => {
  it("detects a tutorial mod as ONLY the tutorial quest (exclusive of deploy + mod)", async () => {
    const acct = freshAccount();
    getOwnerAppCount.mockResolvedValue({ success: true, value: 1 });
    getOwnerDomainAt.mockResolvedValue({
      success: true,
      value: { isSome: true, value: "my-game.dot" },
    });
    getMetadataUri.mockResolvedValue({
      success: true,
      value: { isSome: true, value: `uri-tutorial-${acct}` },
    });
    fetchJson.mockResolvedValue({ name: "My game", moddedFrom: TUTORIAL_DOMAIN });
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().tutorial).toBe(true);
    expect(readQuestsDetected().gates).toBe(true);
    // Exclusive buckets: a tutorial mod is NOT the generic mod quest, and a
    // mod is not a site deploy — only "Build a game" lights.
    expect(readTasks().mod).toBe(false);
    expect(readTasks().deploy).toBe(false);
    expect(readQuestsDetected().underground).toBe(false);
    expect(readQuestsDetected().star).toBe(false);
    expect(snapshotFor(acct)?.tasks?.tutorial).toBe(true);
    expect(snapshotFor(acct)?.tasks?.mod).toBe(false);
  });

  it("detects a site deploy via the `site` tag as ONLY the dot-site quest", async () => {
    const acct = freshAccount();
    getOwnerAppCount.mockResolvedValue({ success: true, value: 1 });
    getOwnerDomainAt.mockResolvedValue({
      success: true,
      value: { isSome: true, value: "my-site.dot" },
    });
    getMetadataUri.mockResolvedValue({
      success: true,
      value: { isSome: true, value: `uri-site-${acct}` },
    });
    fetchJson.mockResolvedValue({ name: "My site", tag: "site" });
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().deploy).toBe(true);
    expect(readQuestsDetected().star).toBe(true);
    expect(readTasks().tutorial).toBe(false);
    expect(readTasks().mod).toBe(false);
    expect(snapshotFor(acct)?.tasks?.deploy).toBe(true);
  });

  it("leaves `deploy` un-written when the site's metadata is unavailable (no regression)", async () => {
    const acct = freshAccount();
    getOwnerAppCount.mockResolvedValue({ success: true, value: 1 });
    getOwnerDomainAt.mockResolvedValue({
      success: true,
      value: { isSome: true, value: "my-site.dot" },
    });
    getMetadataUri.mockResolvedValue({
      success: true,
      value: { isSome: true, value: `uri-site-fail-${acct}` },
    });
    fetchJson.mockRejectedValue(new Error("BulletinHostUnavailable"));
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().deploy).toBe(false); // unchecked, not failed
    expect(snapshotFor(acct)?.tasks?.deploy).toBeUndefined();
  });

  it("detects a non-tutorial mod as VERIFIED mod but resolved-false tutorial", async () => {
    const acct = freshAccount();
    getOwnerAppCount.mockResolvedValue({ success: true, value: 1 });
    getOwnerDomainAt.mockResolvedValue({
      success: true,
      value: { isSome: true, value: "my-fork.dot" },
    });
    getMetadataUri.mockResolvedValue({
      success: true,
      value: { isSome: true, value: `uri-othermod-${acct}` },
    });
    fetchJson.mockResolvedValue({ name: "My fork", moddedFrom: "someones-app.dot" });
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().mod).toBe(true);
    expect(readQuestsDetected().underground).toBe(true);
    expect(readTasks().tutorial).toBe(false); // full scan resolved, no match
    expect(snapshotFor(acct)?.tasks?.mod).toBe(true);
  });

  it("leaves tutorial and mod un-written when Bulletin is unavailable (plain browser)", async () => {
    const acct = freshAccount();
    getOwnerAppCount.mockResolvedValue({ success: true, value: 1 });
    getOwnerDomainAt.mockResolvedValue({
      success: true,
      value: { isSome: true, value: "my-game.dot" },
    });
    getMetadataUri.mockResolvedValue({
      success: true,
      value: { isSome: true, value: `uri-unavailable-${acct}` },
    });
    fetchJson.mockRejectedValue(new Error("BulletinHostUnavailable"));
    const api = { current: null as TaskProgress | null };
    render(<Probe account={acct} connected={acct} api={api} />);
    await flush();

    expect(readTasks().tutorial).toBe(false); // unchecked, not failed
    expect(readTasks().mod).toBe(false);
    // Crucially: nothing persisted — a later in-host visit can still detect.
    expect(snapshotFor(acct)?.tasks?.tutorial).toBeUndefined();
    expect(snapshotFor(acct)?.tasks?.mod).toBeUndefined();
  });

  it("never scans other accounts' apps (cost guard)", async () => {
    const viewer = freshAccount();
    const other = freshAccount();
    getOwnerAppCount.mockResolvedValue({ success: true, value: 5 });
    const api = { current: null as TaskProgress | null };
    render(<Probe account={other} connected={viewer} api={api} />);
    await flush();

    expect(getOwnerDomainAt).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe("useTaskProgress — signed out", () => {
  it("reports nothing complete", async () => {
    const api = { current: null as TaskProgress | null };
    render(<Probe api={api} />);
    await flush();
    expect(Object.values(readTasks()).every((v) => v === false)).toBe(true);
  });
});
