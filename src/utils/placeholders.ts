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

// Deterministic per-app fill for the card image area / detail hero when an app
// has no icon. Reuses the existing --cat-* palette (no new colors); same idea
// as profileHueForAccount in utils/username.ts.
const CARD_COLORS = [
  "var(--cat-social)",
  "var(--cat-chat)",
  "var(--cat-site)",
  "var(--cat-utility)",
  "var(--cat-gaming)",
  "var(--cat-marketplace)",
  "var(--cat-irl)",
] as const;

export function cardColorForDomain(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  return CARD_COLORS[Math.abs(hash) % CARD_COLORS.length];
}
