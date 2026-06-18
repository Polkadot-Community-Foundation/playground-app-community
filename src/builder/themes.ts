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

// Curated theme combos for the "Shuffle" button. The whole point: a user
// shouldn't have to dial in accent + background + text + font by hand. Each
// combo here is hand-picked so the accent reads against its background and the
// font fits the mood — hit Shuffle a few times and every stop looks deliberate.
//
// Pure data + a picker (no React, no DOM) so vitest can import it and the
// editor can apply a combo in a single state update.

/** The styling fields Shuffle sets at once. A subset of SiteContent — the
 *  blocks are never touched, only the page theme. `textColor` is left unset
 *  when the auto contrast color is the right call for the background. */
export interface ThemeCombo {
    accentColor: string;
    background: string;
    fontFamily: string;
    /** Override body color; omit to let the renderer auto-pick for contrast. */
    textColor?: string;
}

// Ordered loosely dark → light. Fonts are drawn from FONT_OPTIONS (template.ts)
// so a shuffled font always matches one the Font menu can show as active.
export const THEME_COMBOS: readonly ThemeCombo[] = [
    // Polkadot — the default, pink on near-black.
    { accentColor: "#e6007a", background: "#0b0d12", fontFamily: "system-ui" },
    // Terminal — phosphor green on black, monospaced. Cypherpunk house style.
    { accentColor: "#22c55e", background: "#0b0d12", fontFamily: "'Courier New', monospace" },
    // Acid — chartreuse on ink, mono. Loud but readable.
    { accentColor: "#a3e635", background: "#111111", fontFamily: "'Courier New', monospace" },
    // Cyber — cyan on deep slate.
    { accentColor: "#06b6d4", background: "#0f172a", fontFamily: "system-ui" },
    // Synthwave — magenta on midnight indigo.
    { accentColor: "#d946ef", background: "#1e1b4b", fontFamily: "system-ui" },
    // Ember — amber on deep purple (the Event template's mood).
    { accentColor: "#f59e0b", background: "#2d1f3f", fontFamily: "system-ui" },
    // Klein — electric blue on black.
    { accentColor: "#3b82f6", background: "#0b0d12", fontFamily: "Impact, sans-serif" },
    // Teal deck — teal on green-black.
    { accentColor: "#14b8a6", background: "#134e4a", fontFamily: "system-ui" },
    // Manuscript — sepia ink on warm paper, serif (the Blog template's mood).
    { accentColor: "#6b4423", background: "#f7f3ed", fontFamily: "Georgia, serif" },
    // Editorial — crimson on bone, serif.
    { accentColor: "#b91c1c", background: "#faf7f2", fontFamily: "Georgia, serif" },
    // Blueprint — indigo on cool sky.
    { accentColor: "#4f46e5", background: "#dbeafe", fontFamily: "system-ui" },
    // Newsprint — black on white, mono, dark text for that document look.
    { accentColor: "#0b0d12", background: "#ffffff", fontFamily: "'Courier New', monospace", textColor: "#111111" },
    // Bubblegum — hot pink on electric cyan, Comic Sans. Maximum playground energy.
    { accentColor: "#ff2d95", background: "#00e5ff", fontFamily: "'Comic Sans MS', cursive", textColor: "#14002b" },
    // Hazard — ink on hi-vis yellow, Impact. Construction-tape loud.
    { accentColor: "#18181b", background: "#facc15", fontFamily: "Impact, sans-serif", textColor: "#18181b" },
];

/** Pick a combo different from the one currently applied, so repeated taps
 *  always produce a visible change. `current` is matched on accent+background+
 *  font (the fields Shuffle owns); anything else just returns combo 0+. With a
 *  single combo it would loop forever, so that degenerate case returns it. */
export function pickRandomTheme(current: ThemeCombo): ThemeCombo {
    if (THEME_COMBOS.length <= 1) return THEME_COMBOS[0];
    const same = (c: ThemeCombo) =>
        c.accentColor === current.accentColor &&
        c.background === current.background &&
        c.fontFamily === current.fontFamily;
    let next = THEME_COMBOS[Math.floor(Math.random() * THEME_COMBOS.length)];
    while (same(next)) {
        next = THEME_COMBOS[Math.floor(Math.random() * THEME_COMBOS.length)];
    }
    return next;
}
