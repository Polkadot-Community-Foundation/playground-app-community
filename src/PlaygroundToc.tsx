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

import { useEffect, useState } from "react";
import { scrollToSection } from "./utils";

/**
 * Table-of-contents entries, in the order they appear on the page. `level: 1`
 * marks an entry nested under the preceding top-level heading (the five quest
 * steps sit under "Earn XP").
 */
export const TOC_ITEMS: Array<{ id: string; label: string; level?: number }> = [
  { id: "xp-prizes", label: "XP & Prizes" },
  { id: "earn-xp", label: "Earn XP" },
  { id: "username", label: "Username", level: 1 },
  { id: "dot-site", label: "Launch a .dot site", level: 1 },
  { id: "tutorial", label: "Build a game with our tutorial", level: 1 },
  { id: "mod", label: "Mod an app", level: 1 },
  { id: "get-modded", label: "Get your app modded", level: 1 },
  { id: "stars", label: "Give and receive stars", level: 1 },
  { id: "where-next", label: "Keep climbing" },
];

/**
 * Sticky right-rail table of contents. Clicking an item scrolls the matching
 * section into view imperatively (so repeat clicks to the same target keep
 * working); a scrollspy highlights whichever section is currently in view.
 */
export default function PlaygroundToc() {
  const [activeId, setActiveId] = useState<string>(TOC_ITEMS[0].id);
  // "Top" is active (and the section scrollspy yields) while near the page top,
  // above the first observed section.
  const [atTop, setAtTop] = useState(true);

  useEffect(() => {
    const onScroll = () => setAtTop(window.scrollY < 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const sections = TOC_ITEMS.map((t) => document.getElementById(t.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (sections.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  const jump = (id: string) => scrollToSection(id);

  return (
    <nav className="playground-toc" aria-label="On this page">
      <p className="playground-toc-head">On this page</p>
      <ul className="playground-toc-list">
        <li>
          <a
            href="#top"
            className={`toc-link${atTop ? " active" : ""}`}
            aria-current={atTop ? "true" : undefined}
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Top
          </a>
        </li>
        {TOC_ITEMS.map((t) => {
          const active = !atTop && activeId === t.id;
          return (
            <li key={t.id}>
              <a
                href={`#${t.id}`}
                className={`toc-link${t.level ? " toc-link--nested" : ""}${active ? " active" : ""}`}
                aria-current={active ? "true" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  jump(t.id);
                }}
              >
                {t.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
