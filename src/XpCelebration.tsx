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

// XP celebration: a megaphone "announce" card with a confetti burst behind it.
// Portaled to document.body so it isn't clipped by whatever panel triggered it.
// Centered on the builder canvas (.builder-root) when present — on desktop that
// canvas is inset by the left rail + shell gutter, so viewport centering would
// drift left — and falls back to full-viewport centering on every other route
// (where .builder-root doesn't exist). Fired whenever the connected user earns
// XP: the App-level registry-event listener maps each award event to an amount
// + label (see src/xpCelebration.ts). Honours prefers-reduced-motion by dropping
// the confetti. Dismisses on any tap/keypress; an optional autoDismissMs also
// clears it after a delay (used for passively-arriving awards so an unprompted
// pop doesn't block the screen indefinitely).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Megaphone } from "lucide-react";

// Festive palette (brand pink + a Polkadot-ish spread). Hardcoded rather than
// var(--accent) because the portal renders on document.body, outside the
// .builder-root theme scope where that variable is defined.
const COLORS = ["#e6007a", "#00b2ff", "#56f39a", "#ffd23f", "#7b4dff", "#ff7a59"];
// Confetti are pixel-art sprites: sizes snap to a pixel grid (multiples of the
// 4px base unit) so every piece reads as a chunky 8-bit block, never a smooth
// dot. Motion is stepped (see App.css) to match the retro feel.
const PIXEL_SIZES = [8, 12, 16];
const PIECE_COUNT = 52;

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

interface Piece {
    dx: number;
    dy: number;
    rot: number;
    delay: number;
    color: string;
    w: number;
    h: number;
}

interface Rect {
    top: number;
    left: number;
    width: number;
    height: number;
}

// The builder canvas box in viewport coords, or null if it can't be measured
// (then we fall back to full-viewport centering).
function measureBuilderRect(): Rect | null {
    if (typeof document === "undefined") return null;
    const el = document.querySelector(".builder-root");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function XpCelebration({
    xp,
    onDone,
    label = "Site deployed!",
    autoDismissMs,
}: {
    xp: number;
    onDone: () => void;
    /** Headline under the XP figure — what the user just earned XP for. */
    label?: string;
    /** When set, the overlay self-dismisses after this many ms (tap/key still
     *  dismiss immediately). Used for passively-arriving awards. */
    autoDismissMs?: number;
}) {
    const reduced = useMemo(
        () =>
            typeof window !== "undefined" &&
            !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
        [],
    );

    // Each piece bursts outward from the card centre at a random angle, biased
    // upward so it arcs up then rains down (the keyframe adds gravity).
    const pieces = useMemo<Piece[]>(() => {
        if (reduced) return [];
        return Array.from({ length: PIECE_COUNT }, () => {
            const angle = Math.random() * Math.PI * 2;
            const dist = 140 + Math.random() * 340;
            // Quantise rotation to 90° steps — pixel sprites tumble in
            // quarter-turns, they don't smoothly spin.
            const quarter = Math.floor((Math.random() - 0.5) * 8) * 90;
            return {
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist - 130,
                rot: quarter,
                delay: Math.round((Math.random() * 200) / 40) * 40,
                color: pick(COLORS),
                w: pick(PIXEL_SIZES),
                h: pick(PIXEL_SIZES),
            };
        });
    }, [reduced]);

    // Track the builder canvas so the card stays centered on it as the window
    // resizes (the overlay persists until dismissed, so layout can change).
    const [rect, setRect] = useState<Rect | null>(() => measureBuilderRect());
    useEffect(() => {
        const update = () => setRect(measureBuilderRect());
        update();
        window.addEventListener("resize", update);
        const vv = window.visualViewport;
        vv?.addEventListener("resize", update);
        vv?.addEventListener("scroll", update);
        return () => {
            window.removeEventListener("resize", update);
            vv?.removeEventListener("resize", update);
            vv?.removeEventListener("scroll", update);
        };
    }, []);

    // Persist until the user interacts — dismiss on any key. (Click/tap is
    // handled by the backdrop's onPointerDown, which also swallows that first
    // click so it doesn't fall through to a button underneath.)
    useEffect(() => {
        const onKey = () => onDone();
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onDone]);

    // Optional self-dismiss — for awards that pop unprompted while the user is
    // doing something else, so the overlay doesn't sit there eating their tap.
    useEffect(() => {
        if (autoDismissMs === undefined) return;
        const t = window.setTimeout(() => onDone(), autoDismissMs);
        return () => window.clearTimeout(t);
    }, [autoDismissMs, onDone]);

    const stageStyle: CSSProperties = rect
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : { inset: 0 };

    return createPortal(
        // Full-viewport backdrop catches the dismiss click anywhere on screen;
        // the stage inside is sized to the builder canvas for centering.
        <div
            className="xp-celebration"
            role="status"
            aria-live="polite"
            onPointerDown={() => onDone()}
        >
            <div className="xp-celebration-stage" style={stageStyle}>
                <div className="xp-celebration-burst" aria-hidden="true">
                    {pieces.map((p, i) => (
                        <span
                            key={i}
                            className="xp-confetti"
                            style={
                                {
                                    "--dx": `${p.dx}px`,
                                    "--dy": `${p.dy}px`,
                                    "--rot": `${p.rot}deg`,
                                    "--delay": `${p.delay}ms`,
                                    background: p.color,
                                    width: `${p.w}px`,
                                    height: `${p.h}px`,
                                } as CSSProperties
                            }
                        />
                    ))}
                </div>
                <div className="xp-celebration-card">
                    <span className="xp-celebration-icon" aria-hidden="true">
                        <Megaphone size={30} />
                    </span>
                    <p className="xp-celebration-amount">+{xp} XP</p>
                    <p className="xp-celebration-label">{label}</p>
                </div>
            </div>
        </div>,
        document.body,
    );
}
