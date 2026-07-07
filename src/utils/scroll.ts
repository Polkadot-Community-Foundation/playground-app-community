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
 * Smooth-scroll a journey section into view by element id. Called imperatively
 * on each click (quest CTAs, the TOC) so repeat clicks to the same target keep
 * working — routing this through a `?section=` param + watching effect breaks
 * on the second click because the param value is unchanged. Deferred so a
 * freshly-laid-out hero island has settled before we measure the target.
 */
export function scrollToSection(id: string): void {
  // Collapsed journey sections listen for this and expand before the deferred
  // scroll below measures the target — a deep link must never land on a
  // collapsed card (see useSectionDisclosure).
  window.dispatchEvent(new CustomEvent("pg:open-section", { detail: id }));
  window.setTimeout(() => {
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);
}
