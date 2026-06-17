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
import { render, cleanup, waitFor } from "@testing-library/react";

// Mock surface MUST be set BEFORE importing the module under test:
//
// 1) `./contracts.ts` has a module-load side effect — its top-level
//    `contractsReady` IIFE calls `getChainAPI(CHAIN)` at import time, which
//    throws "Host provider unavailable" outside Polkadot Desktop/Mobile.
//    Vitest runs in Node, so importing `bulletin.ts` (which imports
//    `signerManager` from `./contracts.ts`) would blow up at module load.
//    Stub `./contracts.ts` so only the symbols `bulletin.ts` reads are
//    defined; everything else is null.
//
// 2) `@parity/product-sdk-cloud-storage.CloudStorageClient.create` reaches into the
//    container-only Bulletin SDK. Stub it so tests control `fetchBytes`
//    behaviour per-case. Defined inside the mock factory because `vi.mock`
//    is hoisted above any module-level `const` — outer-scope captures
//    fail with "cannot access X before initialization".
//
// 3) `URL.createObjectURL` doesn't exist on happy-dom's stripped Blob API.
//    Stub it to return a deterministic synthetic URL.
vi.mock("./contracts.ts", () => ({
  signerManager: {
    getState: () => ({ selectedAccount: null }),
    subscribe: () => () => {},
  },
}));

// fetchBytes spy captured via `vi.hoisted` — survives the mock hoist.
// Vitest hoists `vi.mock` ABOVE any module-level statements, so naive
// outer-scope `const` references in the factory hit a TDZ error. Using
// `vi.hoisted` puts the value on the same hoist level so the factory
// can read it AND the tests can reprogram it per-case.
const { fetchBytesSpy } = vi.hoisted(() => ({
  fetchBytesSpy: vi.fn<(cid: string) => Promise<Uint8Array>>(),
}));

vi.mock("@parity/product-sdk-cloud-storage", () => ({
  CloudStorageClient: {
    create: vi.fn(() => Promise.resolve({ fetchBytes: fetchBytesSpy })),
  },
  createLazySigner: vi.fn(() => null),
}));

// `useIconUrl` and `getBulletinClient` import after the mocks are in place.
import { useIconUrl } from "./bulletin";

// Render helper — a Sentinel component that calls the hook and exposes its
// return via data-attribute so tests can read it from the DOM.
function Sentinel({ cid }: { cid: string | undefined }) {
  const url = useIconUrl(cid);
  return <div data-testid="sentinel" data-url={url ?? ""} />;
}

beforeEach(() => {
  fetchBytesSpy.mockReset();
  // Each test gets a fresh URL.createObjectURL counter so cache hits vs
  // misses are observable.
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:test/${++n}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useIconUrl", () => {
  it("returns null when cid is undefined (no fetch)", () => {
    // Without a cid, no fetch should fire — the hook bails before
    // calling fetchIconUrl. Catches the regression where the guard is
    // dropped and we accidentally request bytes for `undefined`.
    const { getByTestId } = render(<Sentinel cid={undefined} />);
    expect(getByTestId("sentinel").getAttribute("data-url")).toBe("");
    expect(fetchBytesSpy).not.toHaveBeenCalled();
  });

  it("resolves to a blob URL after a successful fetch", async () => {
    // Happy path: cid provided, bytes returned, URL.createObjectURL fires,
    // hook re-renders with the URL. The waitFor handles the async
    // state-update — the hook doesn't return the URL synchronously since
    // the fetch is in a useEffect.
    fetchBytesSpy.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));

    const { getByTestId } = render(<Sentinel cid="bafk-happy" />);
    await waitFor(() => {
      expect(getByTestId("sentinel").getAttribute("data-url")).toMatch(/^blob:test\//);
    });
    expect(fetchBytesSpy).toHaveBeenCalledTimes(1);
    expect(fetchBytesSpy).toHaveBeenCalledWith("bafk-happy");
  });

  it("returns null when fetchBytes rejects (simulated CloudStorageHostUnavailableError)", async () => {
    // Out-of-host path — fetchBytes throws CloudStorageHostUnavailableError.
    // bulletin.ts catches inside its try/catch and returns null. This is
    // the graceful-degradation contract that lets the grid render
    // placeholder icons instead of crashing the whole product. Without
    // this, the container-only-by-design SDK would surface as a white
    // screen for laptop users opening playground.dot.
    fetchBytesSpy.mockRejectedValueOnce(
      new Error("CloudStorageHostUnavailableError: not in host"),
    );

    const { getByTestId } = render(<Sentinel cid="bafk-no-host" />);
    // Give the rejected promise a microtask to settle through the .catch.
    await waitFor(() => {
      expect(fetchBytesSpy).toHaveBeenCalledTimes(1);
    });
    // After rejection the hook stays at null — never throws upstream.
    expect(getByTestId("sentinel").getAttribute("data-url")).toBe("");
  });

  it("hits the cache on second request for the same cid (single fetch)", async () => {
    // Module-level _iconBlobCache memoises by cid. A second request for
    // the same cid (whether from the same render or a fresh one) must
    // not re-fetch — Bulletin reads are expensive. Catches the
    // regression where the cache key changes (e.g. someone keys on
    // `${cid}-${something}` accidentally) and every cache lookup misses.
    fetchBytesSpy.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { getByTestId, unmount } = render(<Sentinel cid="bafk-cached" />);
    await waitFor(() => {
      expect(getByTestId("sentinel").getAttribute("data-url")).toMatch(/^blob:test\//);
    });
    expect(fetchBytesSpy).toHaveBeenCalledTimes(1);

    unmount();

    // Second mount with the same cid — should be served from cache, not
    // re-fetched. The first-time path is in-flight-coalesced in
    // bulletin.ts via the `_iconInFlight` map; this second request
    // goes through the resolved cache.
    const second = render(<Sentinel cid="bafk-cached" />);
    // Initial sync render reads cache synchronously via useState
    // initializer — so the URL is set on first paint without waiting.
    expect(second.getByTestId("sentinel").getAttribute("data-url"))
      .toMatch(/^blob:test\//);
    expect(fetchBytesSpy).toHaveBeenCalledTimes(1);
  });

  it("fetches distinct cids independently and caches each", async () => {
    // Two different cids → two fetchBytes calls, two distinct URLs.
    // Catches the regression where cache keys collide across cids
    // (the cache lookup would return the wrong icon for cid B).
    fetchBytesSpy.mockResolvedValue(new Uint8Array([1]));

    const a = render(<Sentinel cid="bafk-aaa" />);
    await waitFor(() => {
      expect(a.getByTestId("sentinel").getAttribute("data-url")).toMatch(/^blob:test\//);
    });
    const urlA = a.getByTestId("sentinel").getAttribute("data-url");
    a.unmount();

    const b = render(<Sentinel cid="bafk-bbb" />);
    await waitFor(() => {
      expect(b.getByTestId("sentinel").getAttribute("data-url")).toMatch(/^blob:test\//);
    });
    const urlB = b.getByTestId("sentinel").getAttribute("data-url");

    expect(urlA).not.toBe(urlB);
    expect(fetchBytesSpy).toHaveBeenCalledTimes(2);
  });

  it("does not setState after the component unmounts mid-fetch", async () => {
    // The hook captures a `cancelled` flag in useEffect cleanup. If the
    // component unmounts BEFORE the fetch promise resolves, the resolved
    // setUrl call must not fire on the dead component — React warns
    // about that in dev mode and the test should produce no "state
    // update on unmounted component" warnings. Catches a regression
    // where someone removes the cancelled guard.
    //
    // Timing note: fetchIconUrl awaits getBulletinClient() FIRST and
    // only THEN calls fetchBytes. The fetchBytes mock won't be invoked
    // synchronously after render() — we have to await the in-flight
    // chain reaching fetchBytes before unmounting, otherwise resolveFetch
    // is never captured and the test races itself.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveFetch: ((bytes: Uint8Array) => void) | undefined;
    fetchBytesSpy.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );

    const { unmount } = render(<Sentinel cid="bafk-cancelled" />);

    // Wait until the hook's chain has actually reached fetchBytes (the
    // mock above captures resolveFetch when called). vi.waitFor polls.
    await vi.waitFor(() => {
      expect(resolveFetch).toBeDefined();
    });

    // Unmount BEFORE resolving — simulates user navigating away mid-fetch.
    unmount();
    resolveFetch!(new Uint8Array([1, 2, 3]));
    // Give the (now no-op) resolution a microtask to land.
    await new Promise((r) => setTimeout(r, 0));

    // No React warning about setState on unmounted component.
    const setStateWarnings = consoleErrorSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("unmounted") || s.includes("set state"));
    expect(setStateWarnings).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });
});
