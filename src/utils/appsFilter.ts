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

// Pure category-filter logic for the Apps grid. Lives in a `.ts` (no React, no
// chain deps) so vitest can exercise it directly — same convention as
// scaleDecode.ts / placeholders.ts.

import { TAGS } from "../registryTypes.ts";

// Pseudo-category for apps whose metadata carries no recognised TAG (no tag at
// all, or a free-form value that isn't a selectable category). It is NOT a real
// metadata tag — never published, never offered in the publish/builder pickers
// — it exists only so the grid filter can treat "uncategorised" as a
// first-class bucket with its own pill. Without it, turning ANY single category
// off would silently drop every untagged app (strict-include leaves them with
// no bucket of their own).
export const UNTAGGED = "untagged";

// The reserved category for static `.dot` deploys (Site Builder auto-assigns it).
// It stays a canonical TAG and a real bucket, but is NOT a selectable category
// pill — sites are surfaced through their own standalone "Show sites" toggle
// instead (see the `siteOn` state in AppsTab), which is ON by default. The
// footer's sites-only view still selects this bucket directly.
export const SITE = "site";

// Every selectable filter pill, in render order. `TAGS` stays the canonical set
// of publishable categories; `site` is split out into its own toggle (so it's
// filtered out here), and the pseudo-tag is appended on the browse/filter side.
export const FILTER_TAGS = [...TAGS.filter(t => t !== SITE), UNTAGGED] as const;

/**
 * Map an app's raw metadata tag onto the filter bucket that owns it: a
 * recognised TAG keeps its own bucket; everything else (empty or unrecognised)
 * falls into UNTAGGED. Every app maps to exactly one bucket, so a card can only
 * be hidden by turning off the pill it actually belongs to — untagged apps
 * survive until the Untagged pill itself is cleared.
 */
export function filterBucket(tag?: string): string {
  const t = (tag ?? "").toLowerCase();
  return (TAGS as readonly string[]).includes(t) ? t : UNTAGGED;
}
