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

import { describe, it, expect, vi } from "vitest";
import {
  shouldIncludeEntry,
  upsertEntry,
  removeEntry,
  handleRegistryEvent,
  EVENT_NAMES,
  type RegistryEventDeps,
} from "./registryEventReducer";
import { VISIBILITY_PUBLIC, type AppEntry } from "./registryTypes";

const VISIBILITY_PRIVATE = 0;

const entry = (
  domain: string,
  owner: string | undefined,
  visibility: number = VISIBILITY_PUBLIC,
): AppEntry => ({ domain, owner, visibility, metadataUri: "bafk-" + domain });

describe("shouldIncludeEntry", () => {
  it("keeps public apps regardless of viewer", () => {
    const e = entry("a.dot", "0xowner", VISIBILITY_PUBLIC);
    expect(shouldIncludeEntry(e, null)).toBe("keep");
    expect(shouldIncludeEntry(e, "0xother")).toBe("keep");
    expect(shouldIncludeEntry(e, "0xowner")).toBe("keep");
  });

  it("removes private apps when no viewer is connected", () => {
    const e = entry("a.dot", "0xowner", VISIBILITY_PRIVATE);
    expect(shouldIncludeEntry(e, null)).toBe("remove");
    expect(shouldIncludeEntry(e, undefined)).toBe("remove");
    expect(shouldIncludeEntry(e, "")).toBe("remove");
  });

  it("removes private apps owned by someone else", () => {
    const e = entry("a.dot", "0xowner", VISIBILITY_PRIVATE);
    expect(shouldIncludeEntry(e, "0xother")).toBe("remove");
  });

  it("keeps private apps owned by the viewer", () => {
    const e = entry("a.dot", "0xowner", VISIBILITY_PRIVATE);
    expect(shouldIncludeEntry(e, "0xowner")).toBe("keep");
  });

  it("matches owner case-insensitively (h160 addresses normalise inconsistently)", () => {
    // Owner is lowercase on chain; viewer ref may carry checksummed casing.
    const e = entry("a.dot", "0xabcdef0123456789", VISIBILITY_PRIVATE);
    expect(shouldIncludeEntry(e, "0xABCDEF0123456789")).toBe("keep");
  });

  it("removes private apps where owner is missing (defensive — shouldn't happen on chain)", () => {
    // owner undefined + private = not yours by definition.
    const e = entry("a.dot", undefined, VISIBILITY_PRIVATE);
    expect(shouldIncludeEntry(e, "0xanyone")).toBe("remove");
  });
});

describe("upsertEntry", () => {
  it("prepends a new entry when domain doesn't exist", () => {
    const prev = [entry("a.dot", "0xa"), entry("b.dot", "0xb")];
    const next = upsertEntry(prev, entry("c.dot", "0xc"));
    expect(next.map((e) => e.domain)).toEqual(["c.dot", "a.dot", "b.dot"]);
  });

  it("merges fields onto an existing entry in place (preserves order)", () => {
    const prev = [
      entry("a.dot", "0xa"),
      { ...entry("b.dot", "0xb"), metadataUri: "bafk-old" },
      entry("c.dot", "0xc"),
    ];
    const next = upsertEntry(prev, {
      domain: "b.dot",
      metadataUri: "bafk-new",
    });
    expect(next.map((e) => e.domain)).toEqual(["a.dot", "b.dot", "c.dot"]);
    expect(next[1]).toEqual({
      ...prev[1],
      metadataUri: "bafk-new",
    });
  });

  it("does not mutate the input array", () => {
    const prev = [entry("a.dot", "0xa")];
    const before = [...prev];
    upsertEntry(prev, entry("b.dot", "0xb"));
    expect(prev).toEqual(before);
  });

  it("handles empty list", () => {
    expect(upsertEntry([], entry("a.dot", "0xa"))).toEqual([entry("a.dot", "0xa")]);
  });
});

describe("removeEntry", () => {
  it("removes a present domain", () => {
    const prev = [entry("a.dot", "0xa"), entry("b.dot", "0xb")];
    expect(removeEntry(prev, "a.dot")).toEqual([entry("b.dot", "0xb")]);
  });

  it("returns the same reference when domain is absent (skips re-renders)", () => {
    // The contract here is referential equality, not deep equality —
    // callers using setEntries(prev => removeEntry(prev, domain)) depend on
    // this to avoid spurious re-renders when an event fires for an unrelated
    // domain we never had in the list.
    const prev = [entry("a.dot", "0xa")];
    expect(removeEntry(prev, "nope.dot")).toBe(prev);
  });

  it("returns a new reference when the list changed", () => {
    const prev = [entry("a.dot", "0xa")];
    const next = removeEntry(prev, "a.dot");
    expect(next).not.toBe(prev);
    expect(next).toEqual([]);
  });
});

function makeDeps(overrides: Partial<RegistryEventDeps> = {}): RegistryEventDeps {
  return {
    fetchEntry: vi.fn(),
    applyDecision: vi.fn(),
    removeDomain: vi.fn(),
    fetchPinnedApps: vi.fn(),
    backfillDetails: vi.fn(),
    getCurrentUserAddr: () => null,
    refreshSocialCounts: vi.fn(),
    refreshLeaderboard: vi.fn(),
    refreshIdentities: vi.fn(),
    ...overrides,
  };
}

describe("handleRegistryEvent", () => {
  describe("Published / VisibilityChanged (async fetch + decide)", () => {
    it("fetches the entry then applies keep + backfills details for a public app", async () => {
      const e = entry("a.dot", "0xowner", VISIBILITY_PUBLIC);
      const fetchEntry = vi.fn().mockResolvedValue(e);
      const deps = makeDeps({ fetchEntry });

      handleRegistryEvent("Published", "a.dot", deps);
      // Async branch — wait for the fetchEntry resolution chain to settle.
      await vi.waitFor(() => expect(deps.applyDecision).toHaveBeenCalled());

      expect(fetchEntry).toHaveBeenCalledWith("a.dot");
      expect(deps.applyDecision).toHaveBeenCalledWith(e, "keep");
      expect(deps.backfillDetails).toHaveBeenCalledWith([e]);
    });

    it("applies remove + skips backfill when entry becomes private to non-owner", async () => {
      const e = entry("a.dot", "0xowner", VISIBILITY_PRIVATE);
      const fetchEntry = vi.fn().mockResolvedValue(e);
      const deps = makeDeps({
        fetchEntry,
        getCurrentUserAddr: () => "0xother",
      });

      handleRegistryEvent("VisibilityChanged", "a.dot", deps);
      await vi.waitFor(() => expect(deps.applyDecision).toHaveBeenCalled());

      expect(deps.applyDecision).toHaveBeenCalledWith(e, "remove");
      expect(deps.backfillDetails).not.toHaveBeenCalled();
    });

    it("ignores events for unknown domains (fetchEntry returns null)", async () => {
      const fetchEntry = vi.fn().mockResolvedValue(null);
      const deps = makeDeps({ fetchEntry });

      handleRegistryEvent("Published", "ghost.dot", deps);
      // Give the microtask queue a tick to settle without making any calls.
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.applyDecision).not.toHaveBeenCalled();
      expect(deps.backfillDetails).not.toHaveBeenCalled();
      expect(deps.removeDomain).not.toHaveBeenCalled();
    });
  });

  describe("Unpublished", () => {
    it("removes the domain immediately, no chain fetch", () => {
      const deps = makeDeps();
      handleRegistryEvent("Unpublished", "a.dot", deps);
      expect(deps.removeDomain).toHaveBeenCalledWith("a.dot");
      expect(deps.fetchEntry).not.toHaveBeenCalled();
    });
  });

  describe("Pinned / Unpinned", () => {
    it("refetches the pinned list on Pinned", () => {
      const deps = makeDeps();
      handleRegistryEvent("Pinned", "a.dot", deps);
      expect(deps.fetchPinnedApps).toHaveBeenCalled();
      // Doesn't touch entries or social counts — pin state lives in its own list.
      expect(deps.applyDecision).not.toHaveBeenCalled();
    });

    it("refetches the pinned list on Unpinned", () => {
      const deps = makeDeps();
      handleRegistryEvent("Unpinned", "a.dot", deps);
      expect(deps.fetchPinnedApps).toHaveBeenCalled();
    });
  });

  describe("Rated / RatingRemoved (legacy — UI ignores)", () => {
    it("is a no-op for Rated (rating UI removed in favour of star toggle)", () => {
      const deps = makeDeps();
      handleRegistryEvent("Rated", "a.dot", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).not.toHaveBeenCalled();
    });

    it("is a no-op for RatingRemoved", () => {
      const deps = makeDeps();
      handleRegistryEvent("RatingRemoved", "a.dot", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).not.toHaveBeenCalled();
    });
  });

  describe("Star / Mod / Deploy point events", () => {
    it("StarPointAwarded refreshes social counts + leaderboard", () => {
      const deps = makeDeps();
      handleRegistryEvent("StarPointAwarded", "a.dot", deps);
      expect(deps.refreshSocialCounts).toHaveBeenCalledWith("a.dot");
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
    });

    it("StarPointRefunded refreshes social counts + leaderboard", () => {
      const deps = makeDeps();
      handleRegistryEvent("StarPointRefunded", "a.dot", deps);
      expect(deps.refreshSocialCounts).toHaveBeenCalledWith("a.dot");
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
    });

    it("ModPointAwarded refreshes the source domain's social counts + leaderboard", () => {
      const deps = makeDeps();
      // For Mod events the dispatcher passes source_domain (extracted from the
      // SCALE payload), which is exactly the domain whose mod_count increased.
      handleRegistryEvent("ModPointAwarded", "parent.dot", deps);
      expect(deps.refreshSocialCounts).toHaveBeenCalledWith("parent.dot");
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
    });

    it("DeployPointAwarded refreshes the leaderboard only (Published already refreshed the entry)", () => {
      const deps = makeDeps();
      handleRegistryEvent("DeployPointAwarded", "a.dot", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
    });

    it("PlaygroundPublishPointAwarded refreshes the leaderboard only", () => {
      const deps = makeDeps();
      handleRegistryEvent("PlaygroundPublishPointAwarded", "a.dot", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
    });

    it("ModdablePointAwarded refreshes the leaderboard only", () => {
      const deps = makeDeps();
      handleRegistryEvent("ModdablePointAwarded", "a.dot", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
    });

    it("IdentityLinked refreshes the leaderboard and the per-account identity reads", () => {
      const deps = makeDeps();
      handleRegistryEvent("IdentityLinked", "", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
      expect(deps.refreshIdentities).toHaveBeenCalled();
    });

    it("IdentityCleared refreshes the leaderboard and the per-account identity reads", () => {
      const deps = makeDeps();
      handleRegistryEvent("IdentityCleared", "", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
      expect(deps.refreshIdentities).toHaveBeenCalled();
    });

    it("IdentityBonusAwarded refreshes the leaderboard and the per-account identity reads", () => {
      const deps = makeDeps();
      handleRegistryEvent("IdentityBonusAwarded", "", deps);
      expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
      expect(deps.refreshLeaderboard).toHaveBeenCalled();
      expect(deps.refreshIdentities).toHaveBeenCalled();
    });

  });

  it("exhaustively covers EVENT_NAMES (catches new events added to the contract)", () => {
    // If the contract grows a new event and we forget to update EVENT_NAMES
    // here, this test fails — keeping the reducer in sync with the contract.
    expect(EVENT_NAMES).toEqual([
      "Published",
      "Unpublished",
      "Rated",
      "RatingRemoved",
      "VisibilityChanged",
      "Pinned",
      "Unpinned",
      "DeployPointAwarded",
      "PlaygroundPublishPointAwarded",
      "ModdablePointAwarded",
      "ModPointAwarded",
      "StarPointAwarded",
      "StarPointRefunded",
      "IdentityLinked",
      "IdentityCleared",
      "IdentityBonusAwarded",
      "FaucetFailed",
    ]);
  });

  it("FaucetFailed is a safe no-op in the reducer (surfaced via the faucet tx, not here)", () => {
    const deps = makeDeps();
    handleRegistryEvent("FaucetFailed", "", deps);
    expect(deps.refreshSocialCounts).not.toHaveBeenCalled();
    expect(deps.refreshLeaderboard).not.toHaveBeenCalled();
    expect(deps.refreshIdentities).not.toHaveBeenCalled();
    expect(deps.fetchEntry).not.toHaveBeenCalled();
  });
});
