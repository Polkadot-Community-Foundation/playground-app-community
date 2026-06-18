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

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * `React.lazy` with a couple of automatic retries on import failure.
 *
 * Code-split chunks are fetched over the Polkadot host transport (Bulletin /
 * `polkadot://`), where an individual fetch occasionally blips. Plain
 * `React.lazy` rejects on the FIRST failure, so the chunk's Suspense boundary
 * shows "Something went wrong" even though a manual refresh would have loaded
 * it fine. Re-attempting the import after a short backoff lets such a transient
 * failure self-heal in place — no reload, no visible error.
 *
 * A failed module FETCH (network error) is not cached by the browser as a
 * permanent rejection, so re-invoking the factory genuinely re-requests the
 * chunk. Genuine version skew (the hashed chunk no longer exists in the current
 * deployment) keeps failing, exhausts the retries, and falls through to
 * `main.tsx`'s `vite:preloadError` handler, which reloads to pick up the new
 * manifest. So this complements the reload path rather than replacing it.
 */
// `ComponentType<any>` mirrors React's own `lazy()` signature — narrowing to
// `unknown` would reject components that declare required props.
export function lazyRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  retries = 2,
  delayMs = 500,
  timeoutMs = 15_000,
): LazyExoticComponent<T> {
  return lazy(() => attempt(factory, retries, delayMs, timeoutMs));
}

function attempt<R>(
  factory: () => Promise<R>,
  retries: number,
  delayMs: number,
  timeoutMs: number,
): Promise<R> {
  // Race each import against a timeout that REJECTS. The host transport
  // (Bulletin / polkadot://) tends to HANG rather than error on a bad fetch —
  // a plain `import()` then never settles, `.catch` never fires, and the
  // Suspense boundary shows its fallback forever (the "requires app restart"
  // symptom). Converting a hang into a rejection feeds the existing retry →
  // boundary → vite:preloadError reload path so the load can self-heal.
  return withImportTimeout(factory(), timeoutMs).catch((err: unknown) => {
    if (retries <= 0) throw err;
    return new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(() =>
      // Exponential-ish backoff so a brief host hiccup has time to clear.
      attempt(factory, retries - 1, delayMs * 2, timeoutMs),
    );
  });
}

function withImportTimeout<R>(promise: Promise<R>, ms: number): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Chunk import timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
