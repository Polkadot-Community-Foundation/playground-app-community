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
  runPublishFlow,
  publishFailureReason,
  ensureDotSuffix,
  type PublishClients,
  type PublishReporter,
  type PublishInput,
} from "./publishFlow";
import { VISIBILITY_PUBLIC } from "./registryTypes";

const VISIBILITY_PRIVATE = 0;

// ───────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────

describe("publishFailureReason", () => {
  it("returns 'both-failed' when neither side completed", () => {
    expect(publishFailureReason(false, false)).toBe("both-failed");
  });

  it("returns 'bulletin-failed' when only registry completed", () => {
    expect(publishFailureReason(false, true)).toBe("bulletin-failed");
  });

  it("returns 'registry-failed' when only bulletin completed", () => {
    expect(publishFailureReason(true, false)).toBe("registry-failed");
  });

  it("returns 'post-publish-failed' when both completed (e.g. setTimeout or unrelated throw)", () => {
    // Both legs report done but the flow still ended up in catch — pinpoints
    // failures that came after the parallel work, e.g. cleanup, completion
    // tracker errors. Keeps Sentry buckets clean.
    expect(publishFailureReason(true, true)).toBe("post-publish-failed");
  });
});

describe("ensureDotSuffix", () => {
  it("appends .dot when missing", () => {
    expect(ensureDotSuffix("myapp")).toBe("myapp.dot");
  });

  it("preserves an existing .dot suffix", () => {
    expect(ensureDotSuffix("myapp.dot")).toBe("myapp.dot");
  });

  it("trims whitespace before appending", () => {
    expect(ensureDotSuffix("  myapp  ")).toBe("myapp.dot");
  });

  it("doesn't append on a domain that has .dot but with whitespace", () => {
    expect(ensureDotSuffix(" myapp.dot ")).toBe("myapp.dot");
  });
});

// ───────────────────────────────────────────────────────────────────
// runPublishFlow — harness
// ───────────────────────────────────────────────────────────────────

interface Harness {
  clients: PublishClients;
  reporter: PublishReporter;
  storeCalls: Uint8Array[];
  publishCalls: Array<[string, string, number, string | null, boolean]>;
  events: Array<[string, ...unknown[]]>;
}

function makeHarness(opts: {
  cidMap?: (bytes: Uint8Array) => string;
  storeBehavior?: (bytes: Uint8Array) => Promise<void>;
  publishBehavior?: (
    d: string,
    cid: string,
    vis: number,
    moddedFrom: string | null,
    isModdable: boolean,
  ) => Promise<{ ok: boolean }>;
} = {}): Harness {
  const events: Array<[string, ...unknown[]]> = [];
  const storeCalls: Uint8Array[] = [];
  const publishCalls: Array<[string, string, number, string | null, boolean]> = [];

  const cidMap =
    opts.cidMap ?? ((bytes: Uint8Array) => `cid-${bytes.length}`);

  const clients: PublishClients = {
    calculateCid: vi.fn(async (bytes: Uint8Array) => ({
      toString: () => cidMap(bytes),
    })),
    storeBytes: vi.fn(async (bytes: Uint8Array) => {
      storeCalls.push(bytes);
      if (opts.storeBehavior) await opts.storeBehavior(bytes);
    }),
    publishToRegistry: vi.fn(async (d, cid, vis, moddedFrom, isModdable) => {
      publishCalls.push([d, cid, vis, moddedFrom, isModdable]);
      return opts.publishBehavior
        ? await opts.publishBehavior(d, cid, vis, moddedFrom, isModdable)
        : { ok: true };
    }),
    startBulletinSpan: vi.fn(async (_attrs, fn) => fn()),
  };

  const reporter: PublishReporter = {
    status: vi.fn((s) => events.push(["status", s])),
    message: vi.fn((m) => events.push(["message", m])),
    errorMessage: vi.fn((m) => events.push(["errorMessage", m])),
    start: vi.fn((opts) => events.push(["start", opts])),
    milestone: vi.fn((name) => events.push(["milestone", name])),
    complete: vi.fn(() => events.push(["complete"])),
    fail: vi.fn((reason, err) => events.push(["fail", reason, err])),
  };

  return { clients, reporter, storeCalls, publishCalls, events };
}

function baseInput(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    domain: "myapp",
    name: "My App",
    visibility: VISIBILITY_PUBLIC,
    iconBytes: null,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────
// runPublishFlow — happy path
// ───────────────────────────────────────────────────────────────────

describe("runPublishFlow — happy path", () => {
  it("returns ok with the computed CID + domain", async () => {
    const h = makeHarness();
    const result = await runPublishFlow(baseInput(), h.clients, h.reporter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fullDomain).toBe("myapp.dot");
      expect(result.metadataCid).toMatch(/^cid-/);
    }
  });

  it("appends .dot to the domain", async () => {
    const h = makeHarness();
    await runPublishFlow(baseInput({ domain: "raw" }), h.clients, h.reporter);
    expect(h.publishCalls[0][0]).toBe("raw.dot");
  });

  it("preserves an explicit .dot suffix without doubling", async () => {
    const h = makeHarness();
    await runPublishFlow(
      baseInput({ domain: "raw.dot" }),
      h.clients,
      h.reporter,
    );
    expect(h.publishCalls[0][0]).toBe("raw.dot");
  });

  it("passes visibility through to publishToRegistry", async () => {
    const h = makeHarness();
    await runPublishFlow(
      baseInput({ visibility: VISIBILITY_PRIVATE }),
      h.clients,
      h.reporter,
    );
    expect(h.publishCalls[0][2]).toBe(VISIBILITY_PRIVATE);
  });

  it("uploads ONLY metadata when no icon is provided", async () => {
    const h = makeHarness();
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(h.storeCalls).toHaveLength(1);
  });

  it("uploads icon then metadata when icon is provided", async () => {
    const h = makeHarness();
    const iconBytes = new Uint8Array([1, 2, 3]);
    await runPublishFlow(
      baseInput({ iconBytes }),
      h.clients,
      h.reporter,
    );
    expect(h.storeCalls).toHaveLength(2);
    expect(h.storeCalls[0]).toEqual(iconBytes);
  });

  it("embeds the computed icon CID in the metadata JSON", async () => {
    const h = makeHarness({
      cidMap: (bytes) => (bytes.length === 3 ? "iconCID" : "metaCID"),
    });
    await runPublishFlow(
      baseInput({ iconBytes: new Uint8Array([1, 2, 3]) }),
      h.clients,
      h.reporter,
    );
    // Second storeBytes call is metadata; decode JSON and check icon_cid.
    const metadataBytes = h.storeCalls[1];
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    expect(metadata.icon_cid).toBe("iconCID");
  });

  it("collapses empty/whitespace optional fields to undefined in metadata", async () => {
    const h = makeHarness();
    await runPublishFlow(
      baseInput({
        description: "   ",
        repository: "",
        tag: "",
      }),
      h.clients,
      h.reporter,
    );
    const metadata = JSON.parse(new TextDecoder().decode(h.storeCalls[0]));
    expect(metadata.description).toBeUndefined();
    expect(metadata.repository).toBeUndefined();
    expect(metadata.tag).toBeUndefined();
  });

  it("trims the domain + name", async () => {
    const h = makeHarness();
    await runPublishFlow(
      baseInput({ domain: "  spaced  ", name: "  Spaced App  " }),
      h.clients,
      h.reporter,
    );
    expect(h.publishCalls[0][0]).toBe("spaced.dot");
    const metadata = JSON.parse(new TextDecoder().decode(h.storeCalls[0]));
    expect(metadata.name).toBe("Spaced App");
  });
});

// ───────────────────────────────────────────────────────────────────
// runPublishFlow — telemetry / reporter contract
// ───────────────────────────────────────────────────────────────────

describe("runPublishFlow — reporter contract", () => {
  it("fires start with hasIcon=true when iconBytes provided", async () => {
    const h = makeHarness();
    await runPublishFlow(
      baseInput({ iconBytes: new Uint8Array([1]) }),
      h.clients,
      h.reporter,
    );
    expect(h.reporter.start).toHaveBeenCalledWith({
      hasIcon: true,
      visibility: "public",
      hasTag: false,
    });
  });

  it("translates visibility number to journey 'public' / 'private' string", async () => {
    const h1 = makeHarness();
    await runPublishFlow(
      baseInput({ visibility: VISIBILITY_PRIVATE }),
      h1.clients,
      h1.reporter,
    );
    expect(h1.reporter.start).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "private" }),
    );

    const h2 = makeHarness();
    await runPublishFlow(
      baseInput({ visibility: VISIBILITY_PUBLIC }),
      h2.clients,
      h2.reporter,
    );
    expect(h2.reporter.start).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "public" }),
    );
  });

  it("transitions status preparing → uploading → done on success", async () => {
    const h = makeHarness();
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    const statusCalls = (h.reporter.status as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(statusCalls).toEqual(["preparing", "uploading", "done"]);
  });

  it("fires the milestone sequence (metadata-prepared, bulletin-uploaded, registry-published)", async () => {
    const h = makeHarness();
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    const milestones = (h.reporter.milestone as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(milestones).toEqual([
      "metadata-prepared",
      "bulletin-uploaded",
      "registry-published",
    ]);
  });

  it("calls complete (and NOT fail) on success", async () => {
    const h = makeHarness();
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(h.reporter.complete).toHaveBeenCalledOnce();
    expect(h.reporter.fail).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────
// runPublishFlow — failure modes
// ───────────────────────────────────────────────────────────────────

describe("runPublishFlow — failure modes", () => {
  it("returns ok=false with reason='bulletin-failed' when only Bulletin throws", async () => {
    const h = makeHarness({
      storeBehavior: async () => {
        throw new Error("upload failed");
      },
    });
    const result = await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bulletin-failed");
    expect(h.reporter.fail).toHaveBeenCalledWith(
      "bulletin-failed",
      expect.any(Error),
    );
  });

  it("returns ok=false with reason='registry-failed' when only Registry throws", async () => {
    const h = makeHarness({
      publishBehavior: async () => {
        throw new Error("revert");
      },
    });
    const result = await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("registry-failed");
  });

  it("returns ok=false with reason='registry-failed' when Registry returns !ok", async () => {
    const h = makeHarness({
      publishBehavior: async () => ({ ok: false }),
    });
    const result = await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("registry-failed");
  });

  it("returns ok=false with reason='both-failed' when both legs throw", async () => {
    const h = makeHarness({
      storeBehavior: async () => {
        throw new Error("upload failed");
      },
      publishBehavior: async () => {
        throw new Error("revert");
      },
    });
    const result = await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("both-failed");
  });

  it("sets a user-facing error message when an Error is thrown", async () => {
    const h = makeHarness({
      storeBehavior: async () => {
        throw new Error("Bulletin chain refused the deposit");
      },
    });
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(h.reporter.errorMessage).toHaveBeenCalledWith(
      "Bulletin chain refused the deposit",
    );
  });

  it("falls back to a generic message when something non-Error is thrown", async () => {
    const h = makeHarness({
      storeBehavior: async () => {
        throw "raw string";
      },
    });
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(h.reporter.errorMessage).toHaveBeenCalledWith("Something went wrong");
  });

  it("sets status='error' on failure and does NOT call complete()", async () => {
    const h = makeHarness({
      publishBehavior: async () => ({ ok: false }),
    });
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    expect(h.reporter.status).toHaveBeenLastCalledWith("error");
    expect(h.reporter.complete).not.toHaveBeenCalled();
  });

  it("does NOT call milestone('registry-published') when registry leg fails", async () => {
    const h = makeHarness({
      publishBehavior: async () => ({ ok: false }),
    });
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    const milestones = (h.reporter.milestone as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(milestones).not.toContain("registry-published");
  });

  it("does NOT call milestone('bulletin-uploaded') when bulletin leg fails", async () => {
    const h = makeHarness({
      storeBehavior: async () => {
        throw new Error("upload failed");
      },
    });
    await runPublishFlow(baseInput(), h.clients, h.reporter);
    const milestones = (h.reporter.milestone as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(milestones).not.toContain("bulletin-uploaded");
  });
});

// ───────────────────────────────────────────────────────────────────
// runPublishFlow — parallelism
// ───────────────────────────────────────────────────────────────────

describe("runPublishFlow — parallelism", () => {
  it("starts both bulletin upload and registry publish before either finishes", async () => {
    // We hold both legs open until manual release, then assert each was
    // entered before we resolved the other. This locks in the parallel
    // behaviour — a serial implementation would only enter the second after
    // the first resolves.
    let bulletinStarted = false;
    let registryStartedBeforeBulletinFinished = false;
    let releaseBulletin!: () => void;
    let releaseRegistry!: () => void;

    const bulletinGate = new Promise<void>((res) => {
      releaseBulletin = res;
    });
    const registryGate = new Promise<void>((res) => {
      releaseRegistry = res;
    });

    const h = makeHarness({
      storeBehavior: async () => {
        bulletinStarted = true;
        await bulletinGate;
      },
      publishBehavior: async () => {
        // If this fires while bulletin is still pending, parallelism is real.
        if (bulletinStarted) registryStartedBeforeBulletinFinished = true;
        await registryGate;
        return { ok: true };
      },
    });

    const flowPromise = runPublishFlow(baseInput(), h.clients, h.reporter);
    // Yield a few microtasks so both legs enter.
    await new Promise((r) => setTimeout(r, 0));

    expect(registryStartedBeforeBulletinFinished).toBe(true);

    releaseBulletin();
    releaseRegistry();
    await flowPromise;
  });
});
