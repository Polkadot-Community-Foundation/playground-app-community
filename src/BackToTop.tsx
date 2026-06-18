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

import type { ReactNode } from "react";
import { ArrowUp } from "lucide-react";

/**
 * Bottom-of-list "back to top" band for the long, infinite-scroll views
 * (Apps, Leaderboard). The button borrows the footer category-cloud typeface
 * (uppercase `--font-code`) so it reads as part of the page chrome. Scrolls the
 * window — the SPA shell scrolls the document, not an inner container.
 *
 * `children` are rendered as extra actions alongside the back-to-top button —
 * style them with the shared `.back-to-top-btn` class to stay consistent.
 */
export default function BackToTop({ note, children }: { note?: string; children?: ReactNode }) {
  return (
    <div className="back-to-top">
      {note && <p className="back-to-top-note">{note}</p>}
      <div className="back-to-top-actions">
        <button
          type="button"
          className="back-to-top-btn"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <ArrowUp size={15} strokeWidth={2.5} />
          Back to top
        </button>
        {children}
      </div>
    </div>
  );
}
