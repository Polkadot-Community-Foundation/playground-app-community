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

import { NavLink, useLocation } from "react-router-dom";
import { NAV_ITEMS, type NavItem } from "./navItems";

export default function LeftRail() {
  const path = useLocation().pathname;
  const isActive = (i: NavItem) =>
    path === i.to || (i.activePrefixes?.some((p) => path.startsWith(p)) ?? false);

  return (
    <nav className="left-rail" aria-label="Primary">
      {NAV_ITEMS.filter((i) => !i.railHidden).map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={`nav-item${isActive(item) ? " active" : ""}`}
            onClick={() => {
              // Tapping the tab you're already on drops anchor: smooth-scroll
              // back to the top instead of a no-op re-navigation.
              if (isActive(item)) window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            data-testid={item.testid}
            aria-label={item.label}
            title={item.label}
          >
            <Icon size={22} aria-hidden="true" />
            <span className="nav-label">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
