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

// `./utils` barrel re-exports `./utils/contracts.ts` which eagerly calls
// `getChainAPI(CHAIN)` on import — throws in Node. Mock just the symbols
// Leaderboard actually consumes.
const getTopBuilders = vi.fn();
let usernamesBatch = new Map<string, string | null>();
// Self verified-identity for the connected viewer, driving the reveal nudge.
// `undefined` (default) = not known yet → nudge suppressed (won't disturb the
// existing rendering tests). Set to `null` to assert the anonymous nudge.
let selfUsername: string | null | undefined = undefined;
// Captures the sentinel's onIntersect callback when the observer is enabled so
// tests can drive infinite-scroll pagination synchronously (happy-dom has no
// real IntersectionObserver). `undefined` while disabled.
let triggerLoadMore: (() => void) | undefined;
vi.mock("./utils", () => ({
  registryReady: Promise.resolve({
    getTopBuilders: { query: (...args: unknown[]) => getTopBuilders(...args) },
  }),
  stringify: (v: unknown) => JSON.stringify(v),
  useIntersectionObserver: (onIntersect: () => void, enabled: boolean) => {
    triggerLoadMore = enabled ? onIntersect : undefined;
    return { current: null };
  },
  // Venue auto-scroll — a no-op in tests (only runs in fullscreen anyway).
  useKioskAutoScroll: () => {},
  profilePathForAccount: (account: string) => `/profile/${encodeURIComponent(account)}`,
  displayNameForAccount: (username: string | null | undefined, account: string | null | undefined) =>
    username?.trim() || `generated ${String(account).slice(2, 6)} name`,
  // `shortAddr` is re-exported from Leaderboard but originates in utils,
  // so the import chain hits this mock first. Mirror the implementation
  // here so the dedicated `shortAddr` tests still pass.
  shortAddr: (addr: string) => {
    if (!addr) return "";
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  },
}));

// The leaderboard now batch-resolves verified-identity usernames per page via
// `useRootUsernamesBatch`, and checks the connected user's own reveal state via
// `useRootUsername`. Returning an empty batch map lets every row fall back to a
// deterministic generated name; `selfUsername` controls the reveal nudge.
vi.mock("./utils/identity", () => ({
  useRootUsernamesBatch: () => usernamesBatch,
  useRootUsername: () => ({ username: selfUsername, loading: false, refresh: () => {} }),
}));

import Leaderboard, { shortAddr } from "./Leaderboard";
import {
  confirmRegistryAddress,
  readLeaderboardSnapshot,
  writeLeaderboardSnapshot,
} from "./utils/snapshotCache";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  getTopBuilders.mockReset();
  usernamesBatch = new Map();
  selfUsername = undefined;
  triggerLoadMore = undefined;
  // Snapshot cache state is per-worker: reset storage and (re)arm writes so
  // tests neither leak into each other nor depend on execution order.
  localStorage.clear();
  confirmRegistryAddress("0xregistry");
});

/** A page of N distinct ranked rows, scores descending from `topScore`. */
function makeRows(n: number, topScore: number, prefix = "a") {
  return Array.from({ length: n }, (_, i) => ({
    account: `0x${prefix}${String(i).padStart(39, "0")}`,
    score: BigInt(topScore - i),
  }));
}

/** Wait for the leaderboard's initial async fetch to flush a render. */
async function flushFetch() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderLeaderboard(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("shortAddr", () => {
  it("truncates an H160 to 0xabcd…1234", () => {
    expect(shortAddr("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });

  it("returns short strings unchanged", () => {
    expect(shortAddr("0xabcd")).toBe("0xabcd");
  });
});

describe("Leaderboard — rendering", () => {
  it("shows the empty state when the contract returns zero entries", async () => {
    getTopBuilders.mockResolvedValue({ success: true, value: [] });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();
    expect(screen.getByTestId("leaderboard-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("leaderboard-list")).toBeNull();
  });

  it("renders ranked rows in the order the contract returned them", async () => {
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [
        { account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", score: 12n },
        { account: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", score: 7n },
        { account: "0xcccccccccccccccccccccccccccccccccccccccc", score: 3n },
      ],
    });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    const rows = screen.getAllByTestId("leaderboard-row");
    expect(rows).toHaveLength(3);
    // The contract sorts descending; the component must not re-sort.
    expect(rows[0]).toHaveAttribute("data-rank", "1");
    expect(rows[0]).toHaveTextContent("12");
    expect(rows[1]).toHaveAttribute("data-rank", "2");
    expect(rows[1]).toHaveTextContent("7");
    expect(rows[2]).toHaveAttribute("data-rank", "3");
    expect(rows[2]).toHaveTextContent("3");
  });

  it("highlights the row belonging to the connected viewer", async () => {
    const meAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [
        { account: "0xffffffffffffffffffffffffffffffffffffffff", score: 99n },
        { account: meAddr, score: 50n },
      ],
    });
    renderLeaderboard(<Leaderboard currentUserAddr={meAddr} />);
    await flushFetch();

    const rows = screen.getAllByTestId("leaderboard-row");
    expect(rows[0]).toHaveAttribute("data-is-you", "false");
    expect(rows[1]).toHaveAttribute("data-is-you", "true");
    expect(screen.getByText("you")).toBeInTheDocument();
  });

  it("matches the viewer regardless of address case", async () => {
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account: "0xAaAa000000000000000000000000000000000000", score: 1n }],
    });
    renderLeaderboard(<Leaderboard currentUserAddr="0xaaaa000000000000000000000000000000000000" />);
    await flushFetch();
    expect(screen.getByTestId("leaderboard-row")).toHaveAttribute("data-is-you", "true");
  });

  it("falls back to an empty list when the contract read fails", async () => {
    getTopBuilders.mockResolvedValue({ success: false, value: null });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();
    expect(screen.getByTestId("leaderboard-empty")).toBeInTheDocument();
  });

  it("shows the username as the label but links to the public profile by address", async () => {
    const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    usernamesBatch = new Map([[account, "alice"]]);
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account, score: 12n }],
    });

    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    const link = screen.getByTestId("leaderboard-profile-link");
    expect(link).toHaveAttribute("href", `/profile/${account}`);
    expect(link).toHaveTextContent("alice");
  });

  it("uses a deterministic label while keeping the profile link address-backed without a username", async () => {
    const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account, score: 12n }],
    });

    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    const link = screen.getByTestId("leaderboard-profile-link");
    expect(link).toHaveAttribute("href", `/profile/${account}`);
    expect(link).toHaveTextContent("generated aaaa name");
    expect(link).not.toHaveTextContent("0xaaaa");
  });
});

describe("Leaderboard — reveal-identity nudge", () => {
  const meAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("shows the 'Listed as … — become a builder?' nudge when the ranked viewer is not a builder", async () => {
    selfUsername = null; // chain-confirmed anonymous
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account: meAddr, score: 12n }],
    });
    renderLeaderboard(<Leaderboard currentUserAddr={meAddr} />);
    await flushFetch();

    const nudge = screen.getByTestId("leaderboard-reveal-nudge");
    expect(nudge).toHaveAttribute("href", "/become-builder");
    // Label is the deterministic anonymous name (displayNameForAccount(null, …)).
    expect(nudge).toHaveTextContent("generated aaaa name");
  });

  it("hides the nudge when the viewer has revealed an identity", async () => {
    selfUsername = "alice";
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account: meAddr, score: 12n }],
    });
    renderLeaderboard(<Leaderboard currentUserAddr={meAddr} />);
    await flushFetch();
    expect(screen.queryByTestId("leaderboard-reveal-nudge")).toBeNull();
  });

  it("hides the nudge when reveal state is not yet known (avoids a flash)", async () => {
    selfUsername = undefined;
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account: meAddr, score: 12n }],
    });
    renderLeaderboard(<Leaderboard currentUserAddr={meAddr} />);
    await flushFetch();
    expect(screen.queryByTestId("leaderboard-reveal-nudge")).toBeNull();
  });

  it("hides the nudge for an anonymous viewer who is NOT on the board", async () => {
    selfUsername = null;
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account: "0xffffffffffffffffffffffffffffffffffffffff", score: 99n }],
    });
    renderLeaderboard(<Leaderboard currentUserAddr={meAddr} />);
    await flushFetch();
    expect(screen.queryByTestId("leaderboard-reveal-nudge")).toBeNull();
  });
});

describe("Leaderboard — refresh wiring", () => {
  it("invokes the registered refresh and re-fetches on call", async () => {
    getTopBuilders.mockResolvedValueOnce({
      success: true,
      value: [{ account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", score: 1n }],
    });
    let refresh: (() => void) | undefined;
    const register = vi.fn((fn?: () => void) => { refresh = fn ?? undefined; });

    renderLeaderboard(<Leaderboard registerRefresh={register} />);
    await flushFetch();

    // First fetch — initial render.
    expect(getTopBuilders).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.any(Function));

    // Second fetch — triggered by event-driven refresh.
    getTopBuilders.mockResolvedValueOnce({
      success: true,
      value: [
        { account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", score: 1n },
        { account: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", score: 1n },
      ],
    });
    await act(async () => {
      refresh!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getTopBuilders).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("leaderboard-row")).toHaveLength(2);
  });

  it("deregisters the refresh callback on unmount", async () => {
    getTopBuilders.mockResolvedValue({ success: true, value: [] });
    const register = vi.fn();

    const { unmount } = renderLeaderboard(<Leaderboard registerRefresh={register} />);
    await flushFetch();

    // Registered once on mount...
    expect(register).toHaveBeenCalledWith(expect.any(Function));
    register.mockClear();

    unmount();
    // ...and cleared once on unmount, so the parent can stop polling a
    // setter bound to an unmounted tree.
    expect(register).toHaveBeenCalledWith(undefined);
  });
});

describe("Leaderboard — snapshot-first paint", () => {
  const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("paints cached rows before the page-0 fetch resolves, sentinel disarmed", () => {
    writeLeaderboardSnapshot([{ account: ACCOUNT, score: 42n }], new Map());
    getTopBuilders.mockReturnValue(new Promise(() => {})); // never resolves
    renderLeaderboard(<Leaderboard />);

    // No flushing: rows must come from the snapshot, in the first paint.
    const row = screen.getByTestId("leaderboard-row");
    expect(row).toHaveTextContent("42");
    expect(screen.getByTestId("leaderboard")).toHaveAttribute("data-loading", "false");
    // Revalidation in flight → pagination must not arm off snapshot offsets.
    expect(triggerLoadMore).toBeUndefined();
  });

  it("keeps snapshot rows when the revalidation fails and disarms paging", async () => {
    writeLeaderboardSnapshot([{ account: ACCOUNT, score: 42n }], new Map());
    getTopBuilders.mockResolvedValue({ success: false, value: null });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    // A failed read must not blank the board it painted from.
    expect(screen.getByTestId("leaderboard-row")).toHaveTextContent("42");
    expect(screen.queryByTestId("leaderboard-sentinel")).toBeNull();
    expect(triggerLoadMore).toBeUndefined();
  });

  it("paints the cached username instead of the loading ellipsis", () => {
    writeLeaderboardSnapshot(
      [{ account: ACCOUNT, score: 42n }],
      new Map([[ACCOUNT, "george"]]),
    );
    getTopBuilders.mockReturnValue(new Promise(() => {}));
    renderLeaderboard(<Leaderboard />);

    // usernamesBatch is empty (live read pending) → the snapshot name shows.
    expect(screen.getByTestId("leaderboard-profile-link")).toHaveTextContent("george");
  });

  it("persists page 0 after a successful fetch for the next mount", async () => {
    usernamesBatch = new Map([[ACCOUNT, "alice"]]);
    getTopBuilders.mockResolvedValue({
      success: true,
      value: [{ account: ACCOUNT, score: 12n }],
    });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    const snap = readLeaderboardSnapshot();
    expect(snap?.entries).toEqual([{ account: ACCOUNT, score: 12n }]);
    expect(snap?.usernames.get(ACCOUNT)).toBe("alice");
  });
});

describe("Leaderboard — infinite scroll", () => {
  it("does not arm the sentinel when the first page is short", async () => {
    getTopBuilders.mockResolvedValueOnce({ success: true, value: makeRows(3, 50) });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    // A full page is PAGE_SIZE (20); three rows means there is no next page.
    expect(screen.queryByTestId("leaderboard-sentinel")).toBeNull();
    expect(triggerLoadMore).toBeUndefined();
  });

  it("fetches and appends the next page when the sentinel intersects", async () => {
    // Page 0 is a full page → sentinel armed.
    getTopBuilders.mockResolvedValueOnce({ success: true, value: makeRows(20, 100, "a") });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    expect(screen.getAllByTestId("leaderboard-row")).toHaveLength(20);
    expect(screen.getByTestId("leaderboard-sentinel")).toBeInTheDocument();
    expect(triggerLoadMore).toBeTypeOf("function");

    // Page 1 is short → no further pages.
    getTopBuilders.mockResolvedValueOnce({ success: true, value: makeRows(5, 80, "b") });
    await act(async () => {
      triggerLoadMore!();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Paged by offset: first call at 0, second at 20.
    expect(getTopBuilders).toHaveBeenNthCalledWith(1, 0, 20);
    expect(getTopBuilders).toHaveBeenNthCalledWith(2, 20, 20);
    expect(screen.getAllByTestId("leaderboard-row")).toHaveLength(25);
    // Short final page retires the sentinel.
    expect(screen.queryByTestId("leaderboard-sentinel")).toBeNull();
  });

  it("continues numbering ranks across appended pages", async () => {
    getTopBuilders.mockResolvedValueOnce({ success: true, value: makeRows(20, 100, "a") });
    renderLeaderboard(<Leaderboard />);
    await flushFetch();

    getTopBuilders.mockResolvedValueOnce({ success: true, value: makeRows(2, 80, "b") });
    await act(async () => {
      triggerLoadMore!();
      await Promise.resolve();
      await Promise.resolve();
    });

    const rows = screen.getAllByTestId("leaderboard-row");
    expect(rows[20]).toHaveAttribute("data-rank", "21");
    expect(rows[21]).toHaveAttribute("data-rank", "22");
  });

  it("drops duplicate accounts when a rank shifts between page reads", async () => {
    const page0 = makeRows(20, 100, "a");
    renderLeaderboard(<Leaderboard />);
    getTopBuilders.mockResolvedValueOnce({ success: true, value: page0 });
    await flushFetch();

    // Page 1 re-surfaces the last row of page 0 plus one genuinely new row.
    getTopBuilders.mockResolvedValueOnce({
      success: true,
      value: [page0[19], ...makeRows(1, 70, "b")],
    });
    await act(async () => {
      triggerLoadMore!();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 20 + 1 fresh (the duplicate is dropped), not 22.
    expect(screen.getAllByTestId("leaderboard-row")).toHaveLength(21);
  });
});
