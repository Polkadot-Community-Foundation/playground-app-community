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

// Production = @w3s. Local dev / staging-test = @staging.
//
// The pvm `cdm = "@w3s/playground-registry"` annotation in lib.rs decides
// where new builds publish to. For UI testing against a fresh staging
// deploy whose ABI hasn't shipped to @w3s yet, set
// `VITE_PLAYGROUND_REGISTRY_PACKAGE=@staging/playground-registry` in
// `.env.local`. Without that override the frontend resolves to @w3s and
// will throw `Cannot read properties of undefined (reading 'tx')` for any
// method the deployed @w3s contract doesn't expose.
const REGISTRY_PACKAGE_OVERRIDE = (import.meta as unknown as { env: Record<string, string | undefined> })
  .env?.VITE_PLAYGROUND_REGISTRY_PACKAGE;
export const PLAYGROUND_REGISTRY_CONTRACT: "@w3s/playground-registry" | "@staging/playground-registry" =
  REGISTRY_PACKAGE_OVERRIDE === "@staging/playground-registry"
    ? "@staging/playground-registry"
    : "@w3s/playground-registry";
export const LIVE_CONTRACTS = [PLAYGROUND_REGISTRY_CONTRACT] as const;
