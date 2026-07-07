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
 * Layer (b) — registry sorting-index tests.
 *
 * Exercises the v13 OrderedIndex maintenance for `get_top_starred` /
 * `get_top_modded` against a local revive-dev-node (or `cdm test`'s PPN):
 *   - star → `star_index` insert
 *   - mod publish → `mod_index` insert (per-(caller, source) dedupe holds)
 *   - multi-tier ordering: 3 starrers + 2 starrers + 1 starrer rank
 *     descending in get_top_starred
 *   - same shape for get_top_modded with distinct mod-publishers
 *   - unpublish drops and resets social counts; re-publish starts at zero
 *   - lazy backfill: `import_social_counts` updates counts but skips the
 *     index; the next live star promotes via `set_indexed_count`
 *   - pagination edge cases + dedupe / self-star reverts
 *
 * All scenarios are write-paths; the whole file is gated on `canWrite()`
 * (CONTRACT_RPC_URL or CDM_TEST set). Per TESTING_PLAN.md §Layer (b),
 * within-file isolation is serial-with-unique-domains: each `it` publishes
 * its own fresh domains so a half-failed test can't poison its siblings.
 * File-level freshness comes from the dev-node lifecycle (a single test
 * file runs against one dev-node process).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  WRITE_TX_OPTS,
  canWrite,
  destroyHandles,
  devAccount,
  ensureMapped,
  getHandles,
  type DevAccount,
} from "./setup";

// Per-run domain suffix so reruns against a persistent local chain don't
// trip the first-publish-only rule. Each test additionally suffixes the
// scenario label so domain strings stay unique even within a run.
const RUN = Date.now().toString(36);
const D = (label: string) => `sort-${RUN}-${label}.dot`;

const VISIBILITY_PUBLIC = 1;
const STAR_RECEIVED_XP = 10;
const MOD_RECEIVED_XP = 50;
const NO_OWNER = {
  isSome: false,
  value: "0x0000000000000000000000000000000000000000",
} as const;
const NO_MODDED_FROM = "" as const;
const FAKE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

// Multi-signer scenarios need distinct on-chain callers: per-(caller, domain)
// star dedupe blocks one signer from driving star_count > 1, and per-
// (caller, source_domain) mod dedupe gates mod_count the same way. Alice
// owns published domains and is the sudo signer; Bob / Charlie / Dave star
// and publish mods.
let alice: DevAccount;
let bob: DevAccount;
let charlie: DevAccount;
let dave: DevAccount;

// `cdm deploy --bootstrap --name local --suri //Alice` makes Alice the sudo,
// so Alice signs the cross-cutting setup txs. Per-call signer overrides
// switch to Bob / Charlie / Dave for the multi-caller paths.
function txAs(account: DevAccount) {
  return { ...WRITE_TX_OPTS, signer: account.signer, origin: account.ss58 };
}

function pageDomains(page: unknown): string[] {
  const entries = (page as { entries?: Array<{ domain: string }> })?.entries ?? [];
  return entries.map((e) => e.domain);
}

beforeAll(async () => {
  alice = devAccount("Alice", "//Alice");
  bob = devAccount("Bob", "//Bob");
  charlie = devAccount("Charlie", "//Charlie");
  dave = devAccount("Dave", "//Dave");

  // Map every non-deployer signer once. `cdm deploy --bootstrap --suri
  // //Alice` only maps Alice; without this, every Bob/Charlie/Dave .tx()
  // silently returns ok=false and downstream assertions see stale (zero)
  // counts. Skips on Paseo (all dev paths are mapped historically there)
  // and on suites that don't write.
  if (canWrite()) {
    for (const acct of [bob, charlie, dave]) {
      await ensureMapped(acct);
    }
  }
}, 60_000);

/// Await a state-mutating `.tx()` promise and fail loudly if the tx didn't
/// land. Without this wrapper, a tx that returns `ok: false` (e.g. the
/// dispatch came back `ContractReverted` after best-block inclusion) just
/// continues — the test then reads stale state and fails on a downstream
/// assertion 3 lines later, with no clue what actually broke. The wrapper
/// throws at the failing tx with the dispatch error attached, so the test
/// log points at the right line.
async function txOk(
  label: string,
  promise: Promise<unknown>,
): Promise<void> {
  const result = (await promise) as {
    ok?: boolean;
    txHash?: string;
    dispatchError?: unknown;
  };
  if (result?.ok === true) return;
  const dispatch = result?.dispatchError
    ? ` dispatchError=${JSON.stringify(
        result.dispatchError,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      )}`
    : "";
  throw new Error(
    `${label} returned ok=${String(result?.ok)} (hash=${result?.txHash ?? "n/a"})${dispatch}`,
  );
}

afterAll(async () => {
  await destroyHandles();
});

describe("registry sorting indexes — write paths (local dev-node only)", () => {
  it.skipIf(!canWrite())("ABI surface exposes get_top_starred + get_top_modded", async () => {
    // Pre-flight: if the v13 redeploy hasn't shipped, every other test in
    // this describe block would fail with a confusing "method not on
    // contract" error. Surface that mode up-front.
    const { registry } = await getHandles();
    const reg = registry as unknown as Record<string, { query?: unknown; tx?: unknown }>;
    expect(typeof reg.getTopStarred?.query, "getTopStarred should be queryable").toBe(
      "function",
    );
    expect(typeof reg.getTopModded?.query, "getTopModded should be queryable").toBe(
      "function",
    );
    expect(typeof reg.getAppData?.query, "getAppData should be queryable").toBe(
      "function",
    );
    expect(typeof reg.star?.tx, "star should be a tx").toBe("function");
  });

  it.skipIf(!canWrite())("star inserts into star_index and remains indexed", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;
    const domain = D("star-roundtrip");

    await txOk("alice publishes domain", reg.publish.tx(
      domain,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      NO_MODDED_FROM,
      false,
      false,
      txAs(alice),
    ));

    // Pre-condition: count 0, domain not in the sorted view.
    expect(Number((await reg.getStarCount.query(domain)).value)).toBe(0);
    {
      const page = (await reg.getTopStarred.query(0, 100)).value;
      expect(pageDomains(page)).not.toContain(domain);
    }

    await txOk("bob stars domain", reg.star.tx(domain, txAs(bob)));
    expect(Number((await reg.getStarCount.query(domain)).value)).toBe(1);
    {
      const page = (await reg.getTopStarred.query(0, 100)).value;
      expect(pageDomains(page)).toContain(domain);
    }

    expect((await reg.hasStarred.query(bob.h160, domain)).value).toBe(true);
    expect(Number((await reg.getStarCount.query(domain)).value)).toBe(1);
    {
      const rows = (await reg.getAppData.query([domain], bob.h160)).value;
      expect(rows).toHaveLength(1);
      expect(rows[0].domain).toBe(domain);
      expect(Number(rows[0].star_count)).toBe(1);
      expect(Number(rows[0].mod_count)).toBe(0);
      expect(rows[0].has_starred).toBe(true);
    }
    {
      const page = (await reg.getTopStarred.query(0, 100)).value;
      expect(pageDomains(page)).toContain(domain);
    }
  });

  it.skipIf(!canWrite())("mod publish inserts into mod_index; per-caller dedupe holds", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;
    const source = D("mod-source");
    const mod1 = D("mod-1");
    const mod2 = D("mod-2");

    await txOk("alice publishes source", reg.publish.tx(
      source,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      NO_MODDED_FROM,
      false,
      false,
      txAs(alice),
    ));

    // Bob's first mod credits the source.
    await txOk("bob publishes mod1", reg.publish.tx(
      mod1,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      source,
      false,
      false,
      txAs(bob),
    ));
    expect(Number((await reg.getModCount.query(source)).value)).toBe(1);
    {
      const page = (await reg.getTopModded.query(0, 100)).value;
      expect(pageDomains(page)).toContain(source);
    }

    // Bob's SECOND mod of the same source is dedup'd by (caller, source).
    // mod_count stays at 1 and the index entry doesn't bump.
    await txOk("bob publishes mod2 (dedup target)", reg.publish.tx(
      mod2,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      source,
      false,
      false,
      txAs(bob),
    ));
    expect(Number((await reg.getModCount.query(source)).value)).toBe(1);
  });

  it.skipIf(!canWrite())("non-dev callers cannot spoof dev mode or owner override", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;
    const source = D("spoof-source");
    const spoofedMod = D("spoofed-mod");
    const spoofedOwner = D("spoofed-owner");

    await txOk("alice publishes source", reg.publish.tx(
      source,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      NO_MODDED_FROM,
      false,
      false,
      txAs(alice),
    ));
    const before = Number((await reg.getPoints.query(alice.h160)).value);

    // Bob is not the known dev signer. Claiming `is_dev_signer=true` is ignored:
    // the mod counts and awards exactly like a normal phone-mode publish.
    await txOk("bob publishes mod with spoofed dev flag", reg.publish.tx(
      spoofedMod,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      source,
      false,
      true,
      txAs(bob),
    ));

    expect(Number((await reg.getModCount.query(source)).value)).toBe(1);
    expect(Number((await reg.getPoints.query(alice.h160)).value)).toBe(
      before + MOD_RECEIVED_XP,
    );
    {
      const page = (await reg.getTopModded.query(0, 100)).value;
      expect(pageDomains(page)).toContain(source);
    }

    await expect(reg.publish.tx(
      spoofedOwner,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      { isSome: true, value: charlie.h160 },
      NO_MODDED_FROM,
      false,
      false,
      txAs(bob),
    )).rejects.toThrow();
  });

  it.skipIf(!canWrite())(
    "get_top_starred returns domains in descending star_count order",
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;
      const x = D("order-x");
      const y = D("order-y");
      const z = D("order-z");

      for (const dom of [x, y, z]) {
        await txOk(`alice publishes ${dom}`, reg.publish.tx(
          dom,
          FAKE_CID,
          VISIBILITY_PUBLIC,
          NO_OWNER,
          NO_MODDED_FROM,
          false,
          false,
          txAs(alice),
        ));
      }

      // X = 3 stars, Y = 2 stars, Z = 1 star.
      await txOk("bob stars x", reg.star.tx(x, txAs(bob)));
      await txOk("charlie stars x", reg.star.tx(x, txAs(charlie)));
      await txOk("dave stars x", reg.star.tx(x, txAs(dave)));
      await txOk("bob stars y", reg.star.tx(y, txAs(bob)));
      await txOk("charlie stars y", reg.star.tx(y, txAs(charlie)));
      await txOk("bob stars z", reg.star.tx(z, txAs(bob)));

      expect(Number((await reg.getStarCount.query(x)).value)).toBe(3);
      expect(Number((await reg.getStarCount.query(y)).value)).toBe(2);
      expect(Number((await reg.getStarCount.query(z)).value)).toBe(1);

      const page = (await reg.getTopStarred.query(0, 100)).value;
      const ours = pageDomains(page).filter((d) => d === x || d === y || d === z);
      expect(ours).toEqual([x, y, z]);
    },
  );

  it.skipIf(!canWrite())(
    "get_top_modded returns domains in descending mod_count order",
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;
      const m = D("mod-tier-m");
      const n = D("mod-tier-n");

      for (const dom of [m, n]) {
        await txOk(`alice publishes ${dom}`, reg.publish.tx(
          dom,
          FAKE_CID,
          VISIBILITY_PUBLIC,
          NO_OWNER,
          NO_MODDED_FROM,
          false,
          false,
          txAs(alice),
        ));
      }

      // M gets 2 mods (Bob + Charlie); N gets 1 (Dave).
      await txOk("bob mods m", reg.publish.tx(
        D("m-bob"),
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        m,
        false,
        false,
        txAs(bob),
      ));
      await txOk("charlie mods m", reg.publish.tx(
        D("m-charlie"),
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        m,
        false,
        false,
        txAs(charlie),
      ));
      await txOk("dave mods n", reg.publish.tx(
        D("n-dave"),
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        n,
        false,
        false,
        txAs(dave),
      ));

      expect(Number((await reg.getModCount.query(m)).value)).toBe(2);
      expect(Number((await reg.getModCount.query(n)).value)).toBe(1);

      const page = (await reg.getTopModded.query(0, 100)).value;
      const ours = pageDomains(page).filter((d) => d === m || d === n);
      expect(ours).toEqual([m, n]);
    },
  );

  it.skipIf(!canWrite())(
    "unpublish drops from both indexes and resets social counts",
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;
      const domain = D("drop-on-unpublish");
      const modder = D("drop-mod");

      await txOk("alice publishes domain", reg.publish.tx(
        domain,
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        NO_MODDED_FROM,
        false,
        false,
        txAs(alice),
      ));
      await txOk("bob stars domain", reg.star.tx(domain, txAs(bob)));
      await txOk("charlie publishes modder", reg.publish.tx(
        modder,
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        domain,
        false,
        false,
        txAs(charlie),
      ));
      expect(Number((await reg.getStarCount.query(domain)).value)).toBe(1);
      expect(Number((await reg.getModCount.query(domain)).value)).toBe(1);
      const beforeUnpublish = Number((await reg.getPoints.query(alice.h160)).value);

      await txOk("alice unpublishes domain", reg.unpublish.tx(domain, txAs(alice)));

      // App-scoped social XP is removed from the owner; deploy XP remains.
      expect(Number((await reg.getPoints.query(alice.h160)).value)).toBe(
        beforeUnpublish - STAR_RECEIVED_XP - MOD_RECEIVED_XP,
      );
      expect(Number((await reg.getStarCount.query(domain)).value)).toBe(0);
      expect(Number((await reg.getModCount.query(domain)).value)).toBe(0);
      {
        const starred = (await reg.getTopStarred.query(0, 100)).value;
        expect(pageDomains(starred)).not.toContain(domain);
        const modded = (await reg.getTopModded.query(0, 100)).value;
        expect(pageDomains(modded)).not.toContain(domain);
      }
    },
  );

  it.skipIf(!canWrite())(
    "re-publish after unpublish starts with reset social counts",
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;
      const domain = D("restore-on-republish");

      await txOk("alice publishes domain", reg.publish.tx(
        domain,
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        NO_MODDED_FROM,
        false,
        false,
        txAs(alice),
      ));
      // Build up real stars so the restore path has something to reinsert.
      await txOk("bob stars domain", reg.star.tx(domain, txAs(bob)));
      await txOk("charlie stars domain", reg.star.tx(domain, txAs(charlie)));
      expect(Number((await reg.getStarCount.query(domain)).value)).toBe(2);

      await txOk("alice unpublishes domain", reg.unpublish.tx(domain, txAs(alice)));
      {
        const starred = (await reg.getTopStarred.query(0, 100)).value;
        expect(pageDomains(starred)).not.toContain(domain);
      }

      await txOk("alice re-publishes domain", reg.publish.tx(
        domain,
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        NO_MODDED_FROM,
        false,
        false,
        txAs(alice),
      ));
      expect(Number((await reg.getStarCount.query(domain)).value)).toBe(0);
      {
        const starred = (await reg.getTopStarred.query(0, 100)).value;
        expect(pageDomains(starred)).not.toContain(domain);
      }
    },
  );

  it.skipIf(!canWrite())(
    "import_social_counts updates counts but bypasses indexes (lazy backfill)",
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;
      const domain = D("lazy-import");

      await txOk("alice publishes lazy-import", reg.publish.tx(
        domain,
        FAKE_CID,
        VISIBILITY_PUBLIC,
        NO_OWNER,
        NO_MODDED_FROM,
        false,
        false,
        txAs(alice),
      ));
      await txOk("alice imports star_count=99", reg.importSocialCounts.tx(
        [{ domain, star_count: 99, mod_count: 0 }],
        txAs(alice),
      ));
      expect(Number((await reg.getStarCount.query(domain)).value)).toBe(99);
      {
        const starred = (await reg.getTopStarred.query(0, 100)).value;
        // Lazy: import doesn't touch the index, so a 99-star domain is
        // invisible to get_top_starred until something re-touches the
        // maintenance path.
        expect(pageDomains(starred)).not.toContain(domain);
      }

      // A live star then promotes via set_indexed_count: it reads cur=99
      // from counts, attempts index.remove(MAX-99, domain) — a silent no-op
      // because that entry was never written — then inserts (MAX-100,
      // domain). The end state matches the count, no double-entry.
      await txOk("bob stars lazy-import", reg.star.tx(domain, txAs(bob)));
      expect(Number((await reg.getStarCount.query(domain)).value)).toBe(100);
      {
        const starred = (await reg.getTopStarred.query(0, 100)).value;
        expect(pageDomains(starred)).toContain(domain);
      }
    },
  );

  it.skipIf(!canWrite())("double-star by the same caller reverts", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;
    const domain = D("dedupe-star");

    await txOk("alice publishes dedupe-star", reg.publish.tx(
      domain,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      NO_MODDED_FROM,
      false,
      false,
      txAs(alice),
    ));
    await txOk("bob stars (first)", reg.star.tx(domain, txAs(bob)));
    await expect(reg.star.tx(domain, txAs(bob))).rejects.toThrow();
    // Underlying count must not move on the rejected attempt.
    expect(Number((await reg.getStarCount.query(domain)).value)).toBe(1);
  });

  it.skipIf(!canWrite())("self-star (caller == owner) reverts", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;
    const domain = D("self-star");

    // Alice owns; Alice attempts to star → SelfStarForbidden.
    await txOk("alice publishes self-star", reg.publish.tx(
      domain,
      FAKE_CID,
      VISIBILITY_PUBLIC,
      NO_OWNER,
      NO_MODDED_FROM,
      false,
      false,
      txAs(alice),
    ));
    await expect(reg.star.tx(domain, txAs(alice))).rejects.toThrow();
    expect(Number((await reg.getStarCount.query(domain)).value)).toBe(0);
  });

  it.skipIf(!canWrite())("get_top_starred pagination edge cases", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;

    // limit == 0 short-circuits to an empty slice (OrderedIndex::range
    // returns nothing when limit == 0; see CLAUDE.md invariant).
    const zeroLimit = (await reg.getTopStarred.query(0, 0)).value as {
      entries?: unknown[];
    };
    expect(zeroLimit.entries ?? []).toEqual([]);

    // Offset past the end of the sorted set returns empty without throwing.
    const offEnd = (await reg.getTopStarred.query(1_000_000, 10)).value as {
      entries?: unknown[];
    };
    expect(offEnd.entries ?? []).toEqual([]);
  });
});
