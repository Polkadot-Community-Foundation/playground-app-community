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

import { test, expect } from "./fixtures.js";
import {
  publishDomain,
  unpublishDomain,
  getApp,
  computeMetadataCid,
  waitForUnpublish,
} from "./registry.js";

// Tests the contract's storage-removal correctness by exercising the full
// publish → unpublish lifecycle. A regression in the underlying `Mapping::remove`
// (e.g. fixed-key `set_storage_or_clear` not actually clearing a variable-length
// key) would slip past the publish path but show up here as either:
//   - getApp() still returning the old entry after unpublish, or
//   - re-publishing the same domain failing or returning stale metadata.
test.describe("unpublish flow (contract-level)", () => {
  // FIXME — uses Node-side `publishDomain` which routes through
  // BulletinClient.create({ environment: "paseo" }), and that client
  // requires a host transport (chain-client internally). In Node, it
  // throws `Host provider unavailable for chain`. Per TESTING_PLAN.md
  // §Relocations, this test is slated to move to Layer (b) — same
  // bug class (`Mapping::remove` storage clearing) but covered via
  // cargo test + revive-dev-node rather than iframe + Node-side write.
  // Fixme'd until the Layer (b) deploy harness lands.
  test.fixme("publish → unpublish → entry is gone, then re-publish wins with new metadata", async ({ throwaway }) => {
    const initial = {
      name: "Unpublish Test (initial)",
      description: "Published only to be unpublished.",
      repository: "https://github.com/paritytech/playground-app",
    };

    const initialCid = await publishDomain(throwaway.domain, initial);
    expect(initialCid).toBe(await computeMetadataCid(initial));

    const before = await getApp(throwaway.domain);
    expect(before, "publish must register the entry").not.toBeNull();
    expect(before!.metadataUri).toBe(initialCid);

    await unpublishDomain(throwaway.domain);

    // With the storage-remove bug, waitForUnpublish would time out here —
    // getApp keeps returning the entry after the (no-op) remove().
    await waitForUnpublish(throwaway.domain, 30_000);

    // Re-publish forces the contract through the "new entry" code path.
    // Storage truly being cleared (vs shadowed) is what makes this succeed
    // — with the original bug, stale state in adjacent maps could survive
    // even when metadata_uri reads as None.
    const updated = { ...initial, name: "Unpublish Test (re-published)" };
    const updatedCid = await publishDomain(throwaway.domain, updated);
    expect(updatedCid).toBe(await computeMetadataCid(updated));
    expect(updatedCid, "fresh metadata must produce a different CID").not.toBe(initialCid);

    const repub = await getApp(throwaway.domain);
    expect(repub, "re-publish must produce a queryable entry").not.toBeNull();
    expect(repub!.metadataUri).toBe(updatedCid);
  });
});

