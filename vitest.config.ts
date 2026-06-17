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

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two Vitest projects:
//   - "unit"     — Layer (c)+(d). happy-dom. No chain. <2s. Runs on `pnpm test`.
//   - "contract" — Layer (b). node env. Talks to Paseo (read) / localhost
//                  revive-dev-node (write). Opt-in via `pnpm test:contract`.
//
// Both use `*.test.ts(x)`; Playwright keeps `*.spec.ts`. No glob collision.
//
// See e2e/TESTING_PLAN.md for the full 4-layer model.
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: ["node_modules", "dist", "e2e", "target"],
    css: false,
    // Layers (b)/(c)/(d) MUST NOT retry: per TESTING_PLAN.md "Retry policy",
    // these are pure / local-state tests where a flake → green retry would
    // hide a real bug (state-isolation issues at Layer b; component bugs
    // at c/d). Vitest's default is already 0; pinning it explicitly so it
    // can't drift without someone reading this comment.
    retry: 0,
    projects: [
      {
        plugins: [react()],
        test: {
          name: "unit",
          environment: "happy-dom",
          globals: true,
          setupFiles: ["./src/test-setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "contract",
          environment: "node",
          globals: true,
          include: ["tests/contract/**/*.test.ts"],
          // Paseo round-trip latency ~200-500ms; contract reads can chain
          // multiple calls per test. Write-path tests against a local PPN
          // chain ~5-10 finalized-block txs per test, each ~6s of block
          // production — 120s gives them headroom without masking real
          // stalls.
          // With waitFor: "finalized" each tx takes 20-40s on PPN
          // depending on chain load; multi-tier ordering tests run ~9 txs
          // in series so 600s is the right ceiling. Hook timeout matches —
          // the registry beforeAll publishes one fixture finalized-tx
          // that easily exceeds the 10s default.
          testTimeout: 600_000,
          hookTimeout: 120_000,
          // Serialize across files. The contract suite drives a SHARED
          // chain — every test file submits txs through the same set of
          // dev signers (Alice in particular). Vitest's default per-file
          // forks would have two workers each query Alice's
          // `System.Account.nonce`, both sign with the same nonce, and
          // one would land with `InvalidTransaction::Stale`. The unit
          // project (`environment: happy-dom`, no chain) keeps the
          // default parallel forks.
          //
          // `singleFork: true` on a forks pool runs every file in this
          // project in the same worker process, serially — equivalent to
          // the root-level `fileParallelism: false` but scoped here.
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
    ],
  },
});
