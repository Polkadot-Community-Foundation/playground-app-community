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

import { Link } from "react-router-dom";
import { BUILD_TIME, VERSION } from "./config";
import { NAV_ITEMS } from "./navItems";

// Footer category cloud. Each clickable chip is one of the canonical publish
// TAGS (src/App.tsx) so the link filters the Apps grid correctly; `tag` is the
// lowercase value carried in the ?cat= param + data-cat, `label` is the
// pretty-cased display string, `subs` are non-clickable flavour descriptors.
const CAT_CLOUD: Array<{ tag: string; label: string; subs: string[] }> = [
  { tag: "gaming", label: "Gaming", subs: ["arcade", "puzzle", "pvp", "leaderboard"] },
  { tag: "social", label: "Social", subs: ["vote", "poll", "members-only", "broadcast", "video"] },
  { tag: "chat", label: "Chat", subs: ["bot", "group", "channel"] },
  { tag: "irl", label: "IRL", subs: ["scavenger", "venue", "loyalty"] },
  { tag: "utility", label: "Utility", subs: ["p2p", "qr", "tools"] },
  { tag: "site", label: "Sites", subs: ["portfolio", "flyer", "link-in-bio"] },
  { tag: "marketplace", label: "Marketplace", subs: ["auction", "swap", "predicton"] },
];

/**
 * Shared site footer. Rendered at the bottom of both the Playground and About
 * tabs (the category cloud links into the Apps tab, the meta line carries the
 * build stamp).
 */
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-col footer-col-cats">
          <div className="cat-cloud">
            {CAT_CLOUD.map(({ tag, label, subs }) => (
              <span key={tag} className="cat-cloud-group">
                <Link className="cat-chip" data-cat={tag} to={`/apps?cat=${tag}`}>
                  {label}
                </Link>
                {subs.map((sub) => (
                  <span key={sub} className="cat-chip sub-tag">
                    {sub}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
        <div className="footer-col footer-col-meta">
          <p className="footer-meta">playground · web3 summit 2026</p>
          <p className="footer-meta">
            {BUILD_TIME
              ? `${VERSION} · built ${new Date(BUILD_TIME).toLocaleString()}`
              : `${VERSION} · local development build`}
          </p>
          <nav className="footer-nav" aria-label="Footer">
            {NAV_ITEMS.map((item) => (
              <Link key={item.to} className="footer-link" to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
