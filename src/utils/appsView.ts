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

// Apps-grid view density preference. Persisted in localStorage so a user's
// choice sticks; on first access (no stored value) we seed a view from the
// current time so the default varies across cold starts, then persist it.

export type AppsView = "1col" | "2col" | "thin";

const KEY = "playground:apps-view";
const MODES: AppsView[] = ["1col", "2col", "thin"];

function isAppsView(v: unknown): v is AppsView {
  return v === "1col" || v === "2col" || v === "thin";
}

export function loadAppsView(): AppsView {
  try {
    const saved = localStorage.getItem(KEY);
    if (isAppsView(saved)) return saved;
  } catch {
    /* private mode / quota — fall through to a fresh pick */
  }
  const pick = MODES[Date.now() % MODES.length];
  saveAppsView(pick);
  return pick;
}

export function saveAppsView(view: AppsView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* private mode / quota — ignored */
  }
}
