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

import { describe, it, expect } from "vitest";
import { TAGS } from "../registryTypes";
import { FILTER_TAGS, SITE, UNTAGGED, filterBucket } from "./appsFilter";

describe("appsFilter — filter buckets", () => {
  it("offers every publishable category except site, plus Untagged", () => {
    // The browse filter drops `site` (it has its own standalone toggle) and
    // appends the Untagged pseudo-tag; the canonical TAGS set (used by the
    // publish/builder pickers) is untouched.
    expect(FILTER_TAGS).toEqual([...TAGS.filter(t => t !== SITE), UNTAGGED]);
    expect(FILTER_TAGS.length).toBe(TAGS.length); // -1 for site, +1 for untagged
    // `site` is still a canonical, publishable tag — just not a filter pill.
    expect((TAGS as readonly string[]).includes(SITE)).toBe(true);
    expect((FILTER_TAGS as readonly string[]).includes(SITE)).toBe(false);
    // The pseudo-tag must never be a publishable category.
    expect((TAGS as readonly string[]).includes(UNTAGGED)).toBe(false);
  });

  it("still buckets a site app as `site` even though it has no pill", () => {
    // The standalone Sites toggle relies on filterBucket reporting `site` so the
    // predicate can include/exclude site cards.
    expect(filterBucket("site")).toBe(SITE);
    expect(filterBucket("SITE")).toBe(SITE);
  });

  it("keeps a recognised tag in its own bucket (case-insensitively)", () => {
    for (const tag of TAGS) {
      expect(filterBucket(tag)).toBe(tag);
    }
    expect(filterBucket("UTILITY")).toBe("utility");
  });

  it("buckets a missing or empty tag as UNTAGGED", () => {
    // This is the regression guard: untagged apps must land in a bucket of
    // their own, so toggling a real category off can't make them vanish.
    expect(filterBucket(undefined)).toBe(UNTAGGED);
    expect(filterBucket("")).toBe(UNTAGGED);
    expect(filterBucket("   ")).toBe(UNTAGGED); // whitespace isn't a category
  });

  it("buckets an unrecognised free-form tag as UNTAGGED", () => {
    // `tag` is free-form in metadata; anything that isn't a selectable category
    // (e.g. a legacy or CLI-set value) rides the Untagged pill rather than
    // disappearing whenever any other category is toggled off.
    expect(filterBucket("defi")).toBe(UNTAGGED); // the removed legacy category
    expect(filterBucket("something-custom")).toBe(UNTAGGED);
  });
});
