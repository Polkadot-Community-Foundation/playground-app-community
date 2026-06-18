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

import { Suspense, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { lazyRetry } from "./lazyRetry.ts";

describe("lazyRetry", () => {
  it("imports once when the chunk loads on the first try", async () => {
    let calls = 0;
    const C = lazyRetry(() => {
      calls++;
      return Promise.resolve({ default: () => <span>loaded</span> });
    });
    render(
      <Suspense fallback={<span>loading</span>}>
        <C />
      </Suspense>,
    );
    expect(await screen.findByText("loaded")).toBeInTheDocument();
    // No retry on success — a healthy import must not be re-fetched.
    expect(calls).toBe(1);
  });

  it("retries a transient import failure and renders on the next attempt", async () => {
    // Mirrors the real bug: the chunk fetch blips once over the host transport,
    // then succeeds. Without the retry this would reject straight to the
    // boundary; with it, the second attempt resolves and the user never sees
    // the failure. Tiny delay so the test doesn't wait on the real backoff.
    let calls = 0;
    const C = lazyRetry(
      () => {
        calls++;
        return calls < 2
          ? Promise.reject(new Error("Failed to fetch dynamically imported module"))
          : Promise.resolve({ default: () => <span>recovered</span> });
      },
      2,
      1,
    );
    render(
      <Suspense fallback={<span>loading</span>}>
        <C />
      </Suspense>,
    );
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("treats a HUNG import as a failure and retries instead of hanging forever", async () => {
    // The core robustness fix: the host transport hangs rather than errors on a
    // bad chunk fetch, so a plain import() never settles and Suspense shows its
    // fallback forever ("requires app restart"). The per-attempt timeout must
    // convert that hang into a rejection so the retry path runs. First attempt
    // never resolves; second resolves. Tiny timeout + backoff to keep it fast.
    let calls = 0;
    const C = lazyRetry(
      () => {
        calls++;
        return calls < 2
          ? new Promise<{ default: () => ReactElement }>(() => {}) // never settles
          : Promise.resolve({ default: () => <span>unhung</span> });
      },
      2, // retries
      1, // delayMs
      10, // timeoutMs — fire the deadline fast
    );
    render(
      <Suspense fallback={<span>loading</span>}>
        <C />
      </Suspense>,
    );
    expect(await screen.findByText("unhung")).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});
