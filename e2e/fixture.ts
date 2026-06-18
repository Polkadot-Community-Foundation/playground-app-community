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
 * The shared read-only fixture domain used by browse/detail/rate tests.
 *
 * `playground-e2e-app.dot` is a domain WE own — published by `setup.ts`
 * on first run via `registry.publish()`, signed by the SIGNER (the funder
 * in CI). Subsequent runs find it already registered and skip the publish.
 *
 * Owning the fixture means we can assert on exact metadata strings
 * (`fixture-metadata.json`) and the tag-filter test gets meaningful input.
 *
 * Caveat: the first publish requires the SIGNER to be a funded,
 * h160-mapped account. Locally (//Alice fallback) this won't succeed;
 * rely on CI to do the initial publish, then local runs find it
 * registered.
 */
export const FIXTURE_DOMAIN = "playground-e2e-app.dot";
