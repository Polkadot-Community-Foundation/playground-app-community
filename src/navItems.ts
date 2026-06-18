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

import { Gamepad2, Compass, Hammer, Trophy, User, Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Single source of truth for the app's primary navigation. Consumed by the
 * left rail (`LeftRail.tsx`) and the site footer (`SiteFooter.tsx`). `railHidden`
 * items appear only in the footer — e.g. About, which we keep reachable without
 * crowding the rail.
 */
export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  testid: string;
  /** NavLink exact-match active (the root route only). */
  end?: boolean;
  /** Also active when the current path starts with one of these prefixes. */
  activePrefixes?: string[];
  /** Shown only in the footer, hidden from the left rail. */
  railHidden?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Playground", icon: Gamepad2, testid: "nav-playground", end: true },
  { to: "/apps", label: "Apps", icon: Compass, testid: "nav-apps", activePrefixes: ["/apps/"] },
  { to: "/builder", label: "Site Builder", icon: Hammer, testid: "nav-builder" },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy, testid: "nav-leaderboard" },
  // `end` + no activePrefixes: /profile/<name> is someone's PUBLIC profile
  // (there's no self-redirect — even your own name routes to the read-only
  // view), so only the exact /profile path lights the tab. Without `end`,
  // NavLink's own default "active" class matches the /profile prefix.
  { to: "/profile", label: "Profile", icon: User, testid: "nav-profile", end: true },
  { to: "/about", label: "About", icon: Info, testid: "nav-about", railHidden: true },
];
