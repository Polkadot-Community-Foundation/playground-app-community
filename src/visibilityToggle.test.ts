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
  runVisibilityToggle,
  type VisibilityToggleClients,
  type VisibilityToggleReporter,
} from "./visibilityToggle";
import { VISIBILITY_PUBLIC, type AppEntry } from "./registryTypes";

const VISIBILITY_PRIVATE = 0;

interface Harness {
  clients: VisibilityToggleClients;
  reporter: VisibilityToggleReporter;
  fetchedFor: string[];
  reporterEvents: Array<[string, ...unknown[]]>;
}

function makeHarness(opts: {
  setVisibilityBehavior?: (d: string, v: number) => Promise<{ ok: boolean }>;
  fetchEntryBehavior?: (d: string) => Promise<AppEntry | null>;
  isSigningRejection?: (err: unknown) => boolean;
} = {}): Harness {
  const fetchedFor: string[] = [];
  const reporterEvents: Array<[string, ...unknown[]]> = [];

  const clients: VisibilityToggleClients = {
    setVisibility: vi.fn(
      opts.setVisibilityBehavior ?? (async () => ({ ok: true })),
    ),
    fetchEntry: vi.fn(async (d) => {
      fetchedFor.push(d);
      return opts.fetchEntryBehavior
        ? await opts.fetchEntryBehavior(d)
        : { domain: d, owner: "0xowner", visibility: VISIBILITY_PUBLIC };
    }),
  };

  const reporter: VisibilityToggleReporter = {
    breadcrumb: vi.fn((o) => reporterEvents.push(["breadcrumb", o])),
    removeDomain: vi.fn((d) => reporterEvents.push(["removeDomain", d])),
    prependEntry: vi.fn((e) => reporterEvents.push(["prependEntry", e])),
    backfillDetails: vi.fn((es) => reporterEvents.push(["backfillDetails", es])),
    patchModEntry: vi.fn((d, v) => reporterEvents.push(["patchModEntry", d, v])),
    isSigningRejection: vi.fn(opts.isSigningRejection ?? (() => false)),
    captureException: vi.fn((err, tags) =>
      reporterEvents.push(["captureException", err, tags]),
    ),
  };

  return { clients, reporter, fetchedFor, reporterEvents };
}

describe("runVisibilityToggle — happy paths", () => {
  it("public flip: fetches the entry, prepends it, backfills details, no removeDomain", async () => {
    const h = makeHarness();
    await runVisibilityToggle("a.dot", VISIBILITY_PUBLIC, h.clients, h.reporter);

    expect(h.clients.setVisibility).toHaveBeenCalledWith("a.dot", VISIBILITY_PUBLIC);
    expect(h.clients.fetchEntry).toHaveBeenCalledWith("a.dot");
    expect(h.reporter.prependEntry).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "a.dot", visibility: VISIBILITY_PUBLIC }),
    );
    expect(h.reporter.backfillDetails).toHaveBeenCalled();
    expect(h.reporter.removeDomain).not.toHaveBeenCalled();
  });

  it("private flip: removes the domain, NO fetchEntry call (saves a chain read)", async () => {
    const h = makeHarness();
    await runVisibilityToggle("a.dot", VISIBILITY_PRIVATE, h.clients, h.reporter);

    expect(h.reporter.removeDomain).toHaveBeenCalledWith("a.dot");
    expect(h.clients.fetchEntry).not.toHaveBeenCalled();
    expect(h.reporter.prependEntry).not.toHaveBeenCalled();
    expect(h.reporter.backfillDetails).not.toHaveBeenCalled();
  });

  it("fires the breadcrumb BEFORE submitting the tx, with the correct visibility label", async () => {
    let breadcrumbAt = 0;
    let txAt = 0;
    let counter = 0;
    const h = makeHarness({
      setVisibilityBehavior: async () => {
        txAt = ++counter;
        return { ok: true };
      },
    });
    h.reporter.breadcrumb = vi.fn(() => {
      breadcrumbAt = ++counter;
    }) as VisibilityToggleReporter["breadcrumb"];

    await runVisibilityToggle("a.dot", VISIBILITY_PRIVATE, h.clients, h.reporter);

    expect(breadcrumbAt).toBeLessThan(txAt);
    expect(h.reporter.breadcrumb).toHaveBeenCalledWith({
      domain: "a.dot",
      visibility: "private",
    });
  });

  it("translates VISIBILITY_PUBLIC to breadcrumb 'public'", async () => {
    const h = makeHarness();
    await runVisibilityToggle("a.dot", VISIBILITY_PUBLIC, h.clients, h.reporter);
    expect(h.reporter.breadcrumb).toHaveBeenCalledWith({
      domain: "a.dot",
      visibility: "public",
    });
  });

  it("patches modEntry on public flip", async () => {
    const h = makeHarness();
    await runVisibilityToggle("a.dot", VISIBILITY_PUBLIC, h.clients, h.reporter);
    expect(h.reporter.patchModEntry).toHaveBeenCalledWith("a.dot", VISIBILITY_PUBLIC);
  });

  it("patches modEntry on private flip", async () => {
    const h = makeHarness();
    await runVisibilityToggle("a.dot", VISIBILITY_PRIVATE, h.clients, h.reporter);
    expect(h.reporter.patchModEntry).toHaveBeenCalledWith("a.dot", VISIBILITY_PRIVATE);
  });
});

describe("runVisibilityToggle — boundary cases", () => {
  it("public flip where fetchEntry returns null: skips prepend + backfill (no crash)", async () => {
    // Transient indexer lag: tx succeeds but the read can't see the row yet.
    // Don't throw — let the chain event subscription pick it up later.
    const h = makeHarness({ fetchEntryBehavior: async () => null });
    await expect(
      runVisibilityToggle("a.dot", VISIBILITY_PUBLIC, h.clients, h.reporter),
    ).resolves.toBeUndefined();
    expect(h.reporter.prependEntry).not.toHaveBeenCalled();
    expect(h.reporter.backfillDetails).not.toHaveBeenCalled();
    // patchModEntry still fires — the user's local state should match what
    // they just clicked, even if the chain read lags.
    expect(h.reporter.patchModEntry).toHaveBeenCalled();
  });

  it("throws when setVisibility returns ok=false (and captures to telemetry)", async () => {
    const h = makeHarness({
      setVisibilityBehavior: async () => ({ ok: false }),
    });
    await expect(
      runVisibilityToggle("a.dot", VISIBILITY_PRIVATE, h.clients, h.reporter),
    ).rejects.toThrow(/setVisibility tx returned ok=false/);
    expect(h.reporter.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      { action: "set-visibility", domain: "a.dot" },
    );
    // ok=false ≠ user rejection — should report, then re-throw.
    expect(h.reporter.removeDomain).not.toHaveBeenCalled();
  });
});

describe("runVisibilityToggle — error handling", () => {
  it("swallows signing-rejection errors silently (no telemetry, no throw)", async () => {
    // User cancelled the wallet prompt — that's a normal UX event, not a bug.
    // The flow must NOT report it to Sentry and must NOT re-throw, because
    // re-throwing would surface a "Something went wrong" UI for what was
    // an intentional cancel.
    const cancelErr = new Error("User cancelled");
    const h = makeHarness({
      setVisibilityBehavior: async () => {
        throw cancelErr;
      },
      isSigningRejection: (err) => err === cancelErr,
    });

    await expect(
      runVisibilityToggle("a.dot", VISIBILITY_PRIVATE, h.clients, h.reporter),
    ).resolves.toBeUndefined();

    expect(h.reporter.captureException).not.toHaveBeenCalled();
    expect(h.reporter.removeDomain).not.toHaveBeenCalled();
  });

  it("reports + re-throws non-rejection errors", async () => {
    const realErr = new Error("RPC timeout");
    const h = makeHarness({
      setVisibilityBehavior: async () => {
        throw realErr;
      },
    });

    await expect(
      runVisibilityToggle("a.dot", VISIBILITY_PRIVATE, h.clients, h.reporter),
    ).rejects.toBe(realErr);
    expect(h.reporter.captureException).toHaveBeenCalledWith(realErr, {
      action: "set-visibility",
      domain: "a.dot",
    });
  });

  it("a fetchEntry throw on public flip propagates (does NOT silently swallow)", async () => {
    // The setVisibility tx already succeeded; if the post-tx read fails, the
    // user needs to see the error — silently swallowing would leave state
    // out of sync with no signal.
    const h = makeHarness({
      fetchEntryBehavior: async () => {
        throw new Error("RPC fell over");
      },
    });
    await expect(
      runVisibilityToggle("a.dot", VISIBILITY_PUBLIC, h.clients, h.reporter),
    ).rejects.toThrow("RPC fell over");
  });
});
