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

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

// Locked achievement tiles render as <Link>s, which need a Router context.
// Wrap via the `wrapper` option so rerender() keeps the same context.
const renderWithRouter = (ui: ReactElement) =>
  render(ui, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });

const getPointBreakdown = vi.fn();
// The shared read helpers (real ones live in useTaskProgress.ts, covered
// there): number-or-null app count, boolean-or-null username, null = failed.
const readOwnerAppCount = vi.fn();
const readUsername = vi.fn();
vi.mock("./utils", () => ({
  registryReady: Promise.resolve({
    getPointBreakdown: { query: (...args: unknown[]) => getPointBreakdown(...args) },
  }),
  stringify: (v: unknown) => JSON.stringify(v),
  readOwnerAppCount: (...args: unknown[]) => readOwnerAppCount(...args),
  readUsername: (...args: unknown[]) => readUsername(...args),
}));

import PointsBreakdown from "./PointsBreakdown";
import {
  confirmRegistryAddress,
  readPointsSnapshot,
  writePointsSnapshot,
} from "./utils/snapshotCache";
import { markIdentityBonusClaimed } from "./utils/identityBonus";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  getPointBreakdown.mockReset();
  readOwnerAppCount.mockReset();
  readUsername.mockReset();
  // Defaults: a fresh account — nothing achieved yet.
  readOwnerAppCount.mockResolvedValue(0);
  readUsername.mockResolvedValue(false);
  // Snapshot cache state is per-worker: reset storage and (re)arm writes so
  // tests neither leak into each other nor depend on execution order.
  localStorage.clear();
  confirmRegistryAddress("0xregistry");
});

async function flushFetch() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const breakdown = (mods: bigint, stars: bigint, total: bigint) => ({
  success: true,
  value: { launch_points: 0n, mod_points: mods, star_points: stars, total },
});

describe("PointsBreakdown — achievements rendering", () => {
  it("shows the Total XP hero and locks every tile for a fresh account", async () => {
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 0n));
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    expect(screen.getByTestId("points-total")).toHaveTextContent("0");
    for (const id of ["username", "deployed", "modded", "starred"]) {
      expect(screen.getByTestId(`ach-${id}`)).toHaveAttribute("data-ach-state", "locked");
    }
    // Locked cards wear the XP on offer + how-to-earn line on the face
    // (no hover/click needed — the card would otherwise read as empty).
    expect(screen.getByTestId("ach-username")).toHaveTextContent("+25 XP");
    expect(screen.getByTestId("ach-username")).toHaveTextContent("Set up your verified builder identity");
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("+100 XP");
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("Deploy an app");
    expect(screen.getByTestId("ach-modded")).toHaveTextContent("+50 XP");
    expect(screen.getByTestId("ach-modded")).toHaveTextContent("Get your app modded");
    expect(screen.getByTestId("ach-starred")).toHaveTextContent("+10 XP");
    expect(screen.getByTestId("ach-starred")).toHaveTextContent("Earn a star");
    // The labels mirror the same text for screen readers.
    expect(screen.getByTestId("ach-username")).toHaveAttribute(
      "aria-label", "Become a builder: +25 XP. Set up your verified builder identity");
    // At zero deploys the "N of 3" progress is suppressed — the locked
    // earn hint (asserted above) is the tile's whole face.
    expect(screen.getByTestId("ach-deployed")).not.toHaveTextContent("of 3");
    // A locked tile is a shortcut into the Playground journey card that earns
    // it (the `?section=` deep link honoured by PlaygroundTab on mount).
    const sections: Record<string, string> = {
      username: "username",
      deployed: "dot-site",
      modded: "get-modded",
      starred: "stars",
    };
    for (const [id, section] of Object.entries(sections)) {
      expect(screen.getByTestId(`ach-${id}`).tagName).toBe("A");
      expect(screen.getByTestId(`ach-${id}`)).toHaveAttribute("href", `/?section=${section}`);
    }
  });

  it("unlocks the intro tile from the local bonus flag before the username read resolves", async () => {
    // Fast-path: the +25 XP is on the total and the bonus is recorded locally,
    // but the username read hasn't resolved yet — the local intro-bonus flag is
    // enough to paint the tile unlocked without waiting on the chain read.
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 25n));
    readUsername.mockResolvedValue(false);
    markIdentityBonusClaimed(ACCOUNT);
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    const tile = screen.getByTestId("ach-username");
    expect(tile).toHaveAttribute("data-ach-state", "unlocked");
    // Unlocked face shows the earned XP, not the locked how-to-earn hint.
    expect(tile).not.toHaveTextContent("Set up your verified builder identity");
  });

  it("unlocks tiles from on-chain state and shows counts for mods/stars", async () => {
    getPointBreakdown.mockResolvedValue(breakdown(2n, 3n, 255n));
    readOwnerAppCount.mockResolvedValue(4);
    readUsername.mockResolvedValue(true);
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    expect(screen.getByTestId("points-total")).toHaveTextContent("255");
    // Unlocked tiles stay links into their journey card (consistent with
    // locked tiles); the section href is unchanged by the unlock state.
    for (const id of ["username", "deployed", "modded", "starred"]) {
      expect(screen.getByTestId(`ach-${id}`)).toHaveAttribute("data-ach-state", "unlocked");
      expect(screen.getByTestId(`ach-${id}`).tagName).toBe("A");
    }
    expect(screen.getByTestId("ach-deployed")).toHaveAttribute("href", "/?section=dot-site");
    expect(screen.getByTestId("ach-modded")).toHaveTextContent("×2");
    expect(screen.getByTestId("ach-starred")).toHaveTextContent("×3");
    // The earned XP each source carries lives in the aria-label: 2 mods × 50,
    // 3 stars × 10, and the deploy residual 255 − 100 − 30 − 25 = 100 →
    // first deploy done.
    expect(screen.getByTestId("ach-modded")).toHaveAttribute(
      "aria-label", "Modded by others: +100 XP. Get your app modded");
    expect(screen.getByTestId("ach-starred")).toHaveAttribute(
      "aria-label", "Stars received: +30 XP. Earn a star");
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("1 of 3");
  });

  it("renders an arbitrary (non-connected) account's achievements from chain reads alone", async () => {
    // No hasUsername prop — the username tile unlocks purely from the
    // username read, which works for any H160 (public profiles).
    getPointBreakdown.mockResolvedValue(breakdown(0n, 1n, 35n));
    readOwnerAppCount.mockResolvedValue(1);
    readUsername.mockResolvedValue(true);
    renderWithRouter(
      <PointsBreakdown account="0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" refreshKey={0} />,
    );
    await flushFetch();

    expect(screen.getByTestId("ach-username")).toHaveAttribute("data-ach-state", "unlocked");
    expect(screen.getByTestId("ach-deployed")).toHaveAttribute("data-ach-state", "unlocked");
    expect(screen.getByTestId("ach-starred")).toHaveTextContent("×1");
    expect(screen.getByTestId("ach-modded")).toHaveAttribute("data-ach-state", "locked");
  });

  it("hasUsername optimistically unlocks the username tile ahead of the chain echo", async () => {
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 25n));
    readUsername.mockResolvedValue(false); // lagging node
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} hasUsername />);
    await flushFetch();

    expect(screen.getByTestId("ach-username")).toHaveAttribute("data-ach-state", "unlocked");
  });

  it("degrades to zeros/locked when every read fails — never throws", async () => {
    getPointBreakdown.mockRejectedValue(new Error("WS down"));
    // The helpers never reject — they resolve null on failure.
    readOwnerAppCount.mockResolvedValue(null);
    readUsername.mockResolvedValue(null);
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    expect(screen.getByTestId("points-total")).toHaveTextContent("0");
    for (const id of ["username", "deployed", "modded", "starred"]) {
      expect(screen.getByTestId(`ach-${id}`)).toHaveAttribute("data-ach-state", "locked");
    }
  });
});

describe("PointsBreakdown — deploy progress", () => {
  it("fills pips from the deploy-XP residual: 100 → 1 of 3, 200 → 2 of 3, 300 → 3 of 3", async () => {
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 100n));
    readOwnerAppCount.mockResolvedValue(1);
    const { rerender } = renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();
    expect(screen.getByTestId("ach-deployed")).toHaveAttribute("data-ach-state", "unlocked");
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("1 of 3");

    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 200n));
    rerender(<PointsBreakdown account={ACCOUNT} refreshKey={1} />);
    await flushFetch();
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("2 of 3");

    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 300n));
    rerender(<PointsBreakdown account={ACCOUNT} refreshKey={2} />);
    await flushFetch();
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("3 of 3");
  });

  it("caps at 3 of 3 when the residual exceeds three deploys' worth", async () => {
    // Inconsistent reads can leave a residual above 300 — the pips never
    // promise more than the three rewarded deploys.
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 500n));
    readOwnerAppCount.mockResolvedValue(7);
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();
    expect(screen.getByTestId("ach-deployed")).toHaveTextContent("3 of 3");
  });

  it("unlocks the deployed tile from app count even when the award was suppressed", async () => {
    // Dev-signer / blacklisted recipient: apps exist but no deploy XP landed.
    // The tile still unlocks (they did deploy) but never claims "0 of 3" — it
    // wears the plain unlocked check instead.
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 0n));
    readOwnerAppCount.mockResolvedValue(1);
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();
    expect(screen.getByTestId("ach-deployed")).toHaveAttribute("data-ach-state", "unlocked");
    expect(screen.getByTestId("ach-deployed")).not.toHaveTextContent("of 3");
  });
});

describe("PointsBreakdown — compact (widget strip)", () => {
  it("renders the flat dt/dd strip and skips the achievement-gate reads", async () => {
    // total = 100 (deploy) + 50 (mod) + 20 (stars) + 25 (username) = 195.
    getPointBreakdown.mockResolvedValue(breakdown(1n, 2n, 195n));
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} hasUsername compact />);
    await flushFetch();

    expect(screen.getByTestId("points-total")).toHaveTextContent("195");
    expect(screen.getByTestId("points-username")).toHaveTextContent("25");
    expect(screen.getByTestId("points-deploys")).toHaveTextContent("100");
    expect(screen.getByTestId("points-mod")).toHaveTextContent("50");
    expect(screen.getByTestId("points-star")).toHaveTextContent("20");
    // No achievement cards in the widget…
    expect(screen.queryByTestId("ach-deployed")).toBeNull();
    // …and no per-tile chain reads either — just the breakdown.
    expect(readOwnerAppCount).not.toHaveBeenCalled();
    expect(readUsername).not.toHaveBeenCalled();
  });
});

describe("PointsBreakdown — snapshot-first paint", () => {
  it("paints the cached snapshot before the fetch resolves", () => {
    writePointsSnapshot(ACCOUNT, {
      launch_points: 0n, mod_points: 1n, star_points: 0n, total: 150n,
    });
    getPointBreakdown.mockReturnValue(new Promise(() => {})); // never resolves
    // Compact strip exposes the per-bucket testids — the snapshot seeds the
    // same state the cards render from, so this exercises the first-paint path.
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} compact />);

    // No flushing: the snapshot must be in the first paint, not post-fetch.
    expect(screen.getByTestId("points-total")).toHaveTextContent("150");
    expect(screen.getByTestId("points-mod")).toHaveTextContent("50");
    expect(screen.getByTestId("points-breakdown")).toHaveAttribute("data-loading", "false");
  });

  it("keeps the snapshot when the revalidation fails", async () => {
    writePointsSnapshot(ACCOUNT, {
      launch_points: 0n, mod_points: 1n, star_points: 0n, total: 150n,
    });
    getPointBreakdown.mockResolvedValue({ success: false, value: null });
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    // A failed read must not snap the cached values back to zero.
    expect(screen.getByTestId("points-total")).toHaveTextContent("150");
    expect(screen.getByTestId("points-breakdown")).toHaveAttribute("data-loading", "false");
  });

  it("persists a successful fetch for the next mount", async () => {
    getPointBreakdown.mockResolvedValue({
      success: true,
      value: { launch_points: 0n, mod_points: 0n, star_points: 3n, total: 30n },
    });
    renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    expect(readPointsSnapshot(ACCOUNT)).toEqual({
      launch_points: 0n, mod_points: 0n, star_points: 3n, total: 30n,
    });
  });
});

describe("PointsBreakdown — refresh wiring", () => {
  it("re-fetches when refreshKey bumps (driven by registry-event dispatcher)", async () => {
    getPointBreakdown.mockResolvedValueOnce(breakdown(0n, 0n, 2n));
    const { rerender } = renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();
    expect(screen.getByTestId("points-total")).toHaveTextContent("2");
    expect(getPointBreakdown).toHaveBeenCalledTimes(1);

    getPointBreakdown.mockResolvedValueOnce(breakdown(0n, 1n, 12n));
    rerender(<PointsBreakdown account={ACCOUNT} refreshKey={1} />);
    await flushFetch();
    expect(screen.getByTestId("points-total")).toHaveTextContent("12");
    expect(getPointBreakdown).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when the account changes", async () => {
    getPointBreakdown.mockResolvedValue(breakdown(0n, 0n, 0n));
    const { rerender } = renderWithRouter(<PointsBreakdown account={ACCOUNT} refreshKey={0} />);
    await flushFetch();

    rerender(
      <PointsBreakdown
        account="0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        refreshKey={0}
      />,
    );
    await flushFetch();

    expect(getPointBreakdown).toHaveBeenCalledTimes(2);
    expect(getPointBreakdown).toHaveBeenLastCalledWith(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});
