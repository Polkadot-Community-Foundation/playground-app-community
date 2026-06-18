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
 * Layer (b) — sorting-index load test.
 *
 * Drives the registry to the Summit-scale target (150 apps × 400 stars by
 * default) on a single fresh deploy, surfacing any state-dependent
 * `ContractTrapped` failure in `star()` / `set_indexed_count` /
 * `award_points` at the exact tx that breaks. Sibling of `sorting.test.ts`
 * — that file owns small unit-shaped scenarios; this one owns scale.
 *
 * Configure via env:
 *   LOAD_APPS   number of domains alice publishes        (default 30)
 *   LOAD_STARS  total stars cast by bob / charlie / dave (default 80)
 *
 * Cost (waitFor: "finalized" on PPN, ~30s per tx):
 *   - Default 30/80:  ~55 min for 110 txs
 *   - Summit 150/400: ~4.6 hours for 550 txs
 *
 * The work is split across signers to avoid a single account churning
 * nonces faster than PPN can finalize:
 *   - alice publishes the APPS (sequential, nonce growth contained)
 *   - bob → charlie → dave round-robin the STARS so no one signer does
 *     more than ceil(STARS/3) consecutive ops
 *
 * Star distribution: `i`-th star targets `apps[i % APPS]` from
 * `signers[floor(i / APPS)]`. With 3 dev signers and APPS apps the max
 * unique-pair budget is `3 * APPS` — STARS must not exceed this (the test
 * asserts up-front so the surprise lands here, not 3 hours in).
 *
 * Skips on Paseo by default. Set `STAGING_SURI=<funded mnemonic-or-//suri>`
 * to run against `@staging/playground-registry` on Paseo Next: the SURI's
 * bare-root account becomes the `Alice` publisher, and `//Bob` /
 * `//Charlie` / `//Dave` derivations of that SURI are auto-funded +
 * auto-mapped by `ensureMapped` before they sign. When `STAGING_SURI` is
 * absent, the test runs only when a local PPN target is configured.
 *
 * `submitWithRetry` wraps every mutation: retries up to 4 times on
 * transient `Stale` or timeout errors (PPN finalization is non-
 * deterministic), throws on contract reverts / traps so the failing test
 * points at the real bug.
 * 
 * LOAD_APPS=5 LOAD_STARS=10 STAGING_SURI="$(node -e "process.stdout.write(require(require('os').homedir()+'/.cdm/accounts.json').paseo.mnemonic)")" pnpm test:contract sorting-load
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import {
  WRITE_TX_OPTS,
  canWrite,
  destroyHandles,
  devAccount,
  ensureMapped,
  getHandles,
  type DevAccount,
} from "./setup";

/// Best-block tx options: faster than finalized (one block of latency
/// instead of full finalization, which on PPN can be 30s–17min variable).
/// The trade-off is occasional `InvalidTransaction::Stale` when PAPI's
/// nonce read (from finalized state) hasn't caught up to a recently-
/// included tx. `submitWithRetry` below handles that by re-submitting.
///
/// `timeoutMs` is the wait for best-block inclusion before
/// `submitWithRetry` retries. 60s was too tight against Paseo Next's
/// block-production variance — caused false-positive retries that landed
/// the same tx twice, leaving star #N+1 to revert with `AlreadyStarred`
/// against the duplicated state. 180s leaves room for one slow block
/// without spuriously retrying. If a real timeout fires at 180s, that's
/// genuinely stuck and worth investigating, not a transient.
const FAST_TX_OPTS = {
  gasLimit: WRITE_TX_OPTS.gasLimit,
  storageDepositLimit: WRITE_TX_OPTS.storageDepositLimit,
  waitFor: "best-block" as const,
  timeoutMs: 180_000,
} as const;

const APPS = Number(process.env.LOAD_APPS ?? "30");
const STARS = Number(process.env.LOAD_STARS ?? "80");
// Allow large overrides without surprises further in: max STARS at
// `3 * APPS` (every dev signer stars every app at most once).
if (STARS > 3 * APPS) {
  throw new Error(
    `LOAD_STARS=${STARS} exceeds 3 * LOAD_APPS=${APPS} = ${3 * APPS}. ` +
      `Each (signer, domain) pair can be starred at most once; ` +
      `STARS must satisfy STARS <= 3 * APPS.`,
  );
}

/// Number of foundational, mod-source apps published by Alice up-front
/// (moddable=true, owned by Alice). The remaining APPS - FOUNDATION_COUNT
/// apps are published by bob/charlie/dave with `modded_from` pointing at
/// one of the foundationals. Capped at 3 so the deterministic mod schedule
/// (Bob/Charlie/Dave each contribute one mod per foundational, dedupe per
/// (modder, src)) maps cleanly to the 3 voter accounts.
const FOUNDATION_COUNT = Math.min(3, Math.max(1, Math.floor(APPS / 3)));

const RUN = Date.now().toString(36);
const D = (label: string) => `load-${RUN}-${label}.dot`;

const VISIBILITY_PUBLIC = 1;
const NO_OWNER = {
  isSome: false,
  value: "0x0000000000000000000000000000000000000000",
} as const;
const NO_MODDED_FROM = "" as const;
const FAKE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

let alice: DevAccount;
let bob: DevAccount;
let charlie: DevAccount;
let dave: DevAccount;

function txAs(account: DevAccount) {
  return { ...FAST_TX_OPTS, signer: account.signer, origin: account.ss58 };
}

/// Some load-test failures are transient (chain nonce-read lag → Stale,
/// or chopsticks subscription drops → timeout). Retry up to N times with
/// a short backoff before giving up.
///
/// `dryRunOnFail` is invoked when `.tx()` fails with a non-retryable
/// error (typically a `ContractReverted` / `ContractTrapped` from the
/// dispatch path). The SDK's `TxDispatchError` doesn't carry the revert
/// bytes — `dispatchError.value` is `undefined` for `ContractReverted` —
/// so we dry-run the same call via `.query()` (which DOES surface the
/// revert payload) and inline the result in the thrown error message.
/// Callers should pass the matching `.query(...)` with the right
/// `origin` so the dry-run reflects what the actual signer would see.
async function submitWithRetry(
  label: string,
  build: () => Promise<unknown>,
  dryRunOnFail?: () => Promise<{ success?: boolean; value?: unknown }>,
  maxAttempts = 4,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = (await build()) as { ok?: boolean; txHash?: string };
      if (result?.ok === true) return;
      lastErr = new Error(
        `${label} returned ok=${String(result?.ok)} (hash=${result?.txHash ?? "n/a"})`,
      );
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? String(err);
      // Stale + timeout are the two transient classes worth retrying.
      // Contract reverts (ContractReverted / ContractTrapped) are
      // deterministic and not worth retrying — they propagate. Wrap with
      // the label so the failure points at the exact (mod / star / publish)
      // step instead of a bare SDK trace.
      if (!/Stale|timed out/i.test(msg)) {
        let revertInfo = "";
        if (dryRunOnFail) {
          try {
            const dry = await dryRunOnFail();
            const valueStr = JSON.stringify(dry.value, (_k, v) =>
              typeof v === "bigint" ? v.toString() : v,
            );
            revertInfo = ` | dry-run: success=${dry.success}, value=${valueStr}`;
          } catch (dryErr) {
            revertInfo = ` | dry-run threw: ${(dryErr as Error).message}`;
          }
        }
        throw new Error(`${label} failed: ${msg}${revertInfo}`, { cause: err });
      }
    }
    if (attempt < maxAttempts) {
      process.stderr.write(
        `  [load] ${label} attempt ${attempt} failed, retrying...\n`,
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

beforeAll(async () => {
  alice = devAccount("Alice", "//Alice");
  bob = devAccount("Bob", "//Bob");
  charlie = devAccount("Charlie", "//Charlie");
  dave = devAccount("Dave", "//Dave");
  // Print every signer's SS58 + H160 so the operator can fund them up-front
  // when running against staging. Always printed (cheap, useful for local
  // debugging too).
  for (const acct of [alice, bob, charlie, dave]) {
    process.stderr.write(
      `  [load] ${acct.name.padEnd(8)} ss58=${acct.ss58}  h160=${acct.h160}\n`,
    );
  }
  if (canWrite()) {
    for (const acct of [bob, charlie, dave]) {
      await ensureMapped(acct);
    }
  }
}, 60_000);

afterAll(async () => {
  await destroyHandles();
});

describe("registry sorting indexes — load (local dev-node only)", () => {
  it.skipIf(!canWrite())(
    `${APPS} apps × ${STARS} stars`,
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;
      const modders: DevAccount[] = [bob, charlie, dave];

      // Track each domain's on-chain owner H160 so the star scheduler can
      // skip self-stars. Foundationals are owned by Alice; mod-publishes
      // are owned by their publisher (NO_OWNER → caller).
      const domains: string[] = [];
      const owners: string[] = [];

      // 1. Foundation phase: Alice publishes FOUNDATION_COUNT moddable
      //    source apps. These are the mod-graph roots — every subsequent
      //    publish picks one of these as `modded_from`.
      const publishStarted = Date.now();
      for (let i = 0; i < FOUNDATION_COUNT; i++) {
        const domain = D(`app-${i}`);
        domains.push(domain);
        owners.push(alice.h160);
        const txStart = Date.now();
        process.stderr.write(`  [load] publish #${i} (foundation) ${domain} by Alice...\n`);
        await submitWithRetry(
          `publish #${i} ${domain}`,
          () =>
            reg.publish.tx(
              domain,
              FAKE_CID,
              VISIBILITY_PUBLIC,
              NO_OWNER,
              NO_MODDED_FROM,
              true, // is_moddable
              false,
              txAs(alice),
            ),
          () =>
            reg.publish.query(
              domain,
              FAKE_CID,
              VISIBILITY_PUBLIC,
              NO_OWNER,
              NO_MODDED_FROM,
              true,
              false,
              { origin: alice.ss58 },
            ),
        );
        const dt = ((Date.now() - txStart) / 1000).toFixed(1);
        const total = ((Date.now() - publishStarted) / 1000).toFixed(0);
        process.stderr.write(`  [load] publish #${i} done in ${dt}s (cumulative ${total}s)\n`);
      }

      // 2. Mod phase: bob/charlie/dave publish the remaining
      //    (APPS - FOUNDATION_COUNT) apps. Mods are scheduled
      //    deterministically so foundation[0] gets up to 3 unique modders,
      //    foundation[1] up to 2, foundation[2] up to 1 — producing the
      //    [3,2,1,0,…] mod_count distribution that exercises mod_index
      //    sort. Triangular slot count K*(K+1)/2 = 6 for K=3; mod-phase
      //    apps beyond that publish with no modded_from. The
      //    (caller, modded_from) dedupe in the contract enforces these
      //    caps regardless of how many publishes a single modder makes.
      const TRIANGULAR_SLOTS: Array<{ foundation: number; modderIdx: number }> = [];
      for (let f = 0; f < FOUNDATION_COUNT; f++) {
        const modsForThis = FOUNDATION_COUNT - f; // 3, 2, 1 for K=3
        for (let m = 0; m < modsForThis; m++) {
          TRIANGULAR_SLOTS.push({ foundation: f, modderIdx: m });
        }
      }
      for (let i = FOUNDATION_COUNT; i < APPS; i++) {
        const slotIdx = i - FOUNDATION_COUNT;
        const slot = TRIANGULAR_SLOTS[slotIdx]; // may be undefined past triangular
        const modder = slot ? modders[slot.modderIdx] : modders[slotIdx % modders.length];
        const moddedFrom = slot ? domains[slot.foundation] : NO_MODDED_FROM;
        const domain = D(`app-${i}`);
        domains.push(domain);
        owners.push(modder.h160);
        const txStart = Date.now();
        const label = moddedFrom
          ? `${domain} by ${modder.name} (mod of ${moddedFrom})`
          : `${domain} by ${modder.name} (no mod)`;
        process.stderr.write(`  [load] publish #${i} (mod) ${label}...\n`);
        await submitWithRetry(
          `publish #${i} ${domain}`,
          () =>
            reg.publish.tx(
              domain,
              FAKE_CID,
              VISIBILITY_PUBLIC,
              NO_OWNER,
              moddedFrom,
              false, // is_moddable
              false,
              txAs(modder),
            ),
          () =>
            reg.publish.query(
              domain,
              FAKE_CID,
              VISIBILITY_PUBLIC,
              NO_OWNER,
              moddedFrom,
              false,
              false,
              { origin: modder.ss58 },
            ),
        );
        const dt = ((Date.now() - txStart) / 1000).toFixed(1);
        const total = ((Date.now() - publishStarted) / 1000).toFixed(0);
        process.stderr.write(`  [load] publish #${i} done in ${dt}s (cumulative ${total}s)\n`);
      }

      // 3. Star phase: build a non-uniform target distribution. Weight
      //    each app by `(APPS - i)` so app 0 attracts the most stars,
      //    app APPS-1 the fewest. Cap per app at the number of non-owner
      //    voters available (3 for foundationals, 2 for mod-publishes).
      //    Adjust to match `STARS` exactly by topping up the head /
      //    trimming the tail.
      const voters: DevAccount[] = [bob, charlie, dave];
      const maxPerApp = owners.map(
        (ownerH160) => voters.filter((v) => v.h160 !== ownerH160).length,
      );
      const totalWeight = (APPS * (APPS + 1)) / 2;
      const targets = domains.map((_, i) =>
        Math.min(maxPerApp[i], Math.round((STARS * (APPS - i)) / totalWeight)),
      );
      let sum = targets.reduce((a, b) => a + b, 0);
      for (let i = 0; sum < STARS && i < APPS; i++) {
        while (targets[i] < maxPerApp[i] && sum < STARS) {
          targets[i]++;
          sum++;
        }
      }
      for (let i = APPS - 1; sum > STARS && i >= 0; i--) {
        while (targets[i] > 0 && sum > STARS) {
          targets[i]--;
          sum--;
        }
      }
      process.stderr.write(
        `  [load] star targets per app: [${targets.join(", ")}] sum=${sum}\n`,
      );

      // Build the (voter, domain) pair list. For each app, pick the
      // first `targets[i]` non-owner voters.
      const starPlan: Array<{ voter: DevAccount; domain: string }> = [];
      for (let i = 0; i < APPS; i++) {
        const eligible = voters.filter((v) => v.h160 !== owners[i]);
        for (let j = 0; j < targets[i]; j++) {
          starPlan.push({ voter: eligible[j], domain: domains[i] });
        }
      }

      const starsStarted = Date.now();
      for (let i = 0; i < starPlan.length; i++) {
        const { voter, domain } = starPlan[i];
        const txStart = Date.now();
        process.stderr.write(`  [load] star #${i} ${voter.name}→${domain}...\n`);
        await submitWithRetry(
          `star #${i} ${voter.name}→${domain}`,
          () => reg.star.tx(domain, txAs(voter)),
          () => reg.star.query(domain, { origin: voter.ss58 }),
        );
        const dt = ((Date.now() - txStart) / 1000).toFixed(1);
        const total = ((Date.now() - starsStarted) / 1000).toFixed(0);
        process.stderr.write(`  [load] star #${i} done in ${dt}s (cumulative ${total}s)\n`);
      }

      // 4. Spot-check both read paths at the post-load scale. Capture the
      //    full query result so we see `success: false` / proof exhaustion
      //    clearly rather than a generic `top.total of undefined` crash.
      for (const method of ["getTopStarred", "getTopModded"] as const) {
        const readStart = Date.now();
        const result = await (reg as any)[method].query(0, 10);
        const readMs = Date.now() - readStart;
        process.stderr.write(
          `  [load] ${method}(0, 10): ${readMs}ms success=${result.success}\n`,
        );
        if (result.gasRequired) {
          const g = result.gasRequired as {
            ref_time: bigint;
            proof_size: bigint;
          };
          process.stderr.write(
            `  [load]   gasRequired: ref_time=${String(g.ref_time)} proof_size=${String(g.proof_size)}\n`,
          );
        }
        if (!result.success) {
          process.stderr.write(
            `  [load]   error: ${JSON.stringify(result.value, (_k, v) =>
              typeof v === "bigint" ? v.toString() : v,
            )}\n`,
          );
          throw new Error(
            `${method}(0, 10) failed at scale APPS=${APPS} STARS=${STARS}: ` +
              `success=false. Likely proof_size exhaustion at ${APPS} domains.`,
          );
        }
        const top = result.value as {
          total: number;
          entries: Array<{ domain: string }>;
        };
        process.stderr.write(
          `  [load]   total=${top.total} entries=[${top.entries.map((e) => e.domain).join(", ")}]\n`,
        );
      }
    },
    // Per-tx ~30s on PPN finalized → 4h for the Summit-scale 550-tx run.
    // Headroom for slower chains or bigger numbers via env override.
    14_400_000,
  );
});
