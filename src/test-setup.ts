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
 * Vitest global setup — runs once per test worker before any test file.
 *
 * - `jest-dom` matchers extend expect() with .toBeInTheDocument(),
 *   .toHaveAttribute(), etc.
 * - happy-dom doesn't ship an IntersectionObserver; useIntersectionObserver
 *   tests stub it directly per-test rather than relying on a global.
 * - `localStorage`/`sessionStorage` are polyfilled below (see note).
 */

import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// ---------------------------------------------------------------------------
// Web Storage polyfill
//
// Node >=22 ships an EXPERIMENTAL built-in `localStorage`/`sessionStorage`
// global, gated behind `--localstorage-file=<path>`. Run without that flag
// (as Vitest does) it resolves to a non-functional empty object — no
// `getItem`/`setItem`/`clear` — and it SHADOWS the `Storage` happy-dom would
// otherwise install on the test window. The symptom is every
// `localStorage.clear()` throwing `localStorage.clear is not a function`
// (see issue #423). We install a real in-memory Storage here, overriding the
// built-in, so storage-backed code (the resources gate snapshot,
// useTaskProgress, snapshotCache, builder drafts) is actually exercised.
// ---------------------------------------------------------------------------

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    // Match the DOM contract: keys and values are coerced to strings.
    this.store.set(String(key), String(value));
  }
}

function installStorage(name: "localStorage" | "sessionStorage"): void {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

installStorage("localStorage");
installStorage("sessionStorage");

// Reset between tests so state never leaks across files in a shared worker
// (most suites also clear in their own beforeEach; this is the safety net).
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
