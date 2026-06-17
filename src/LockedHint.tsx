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

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useOnboarding } from "./OnboardingProvider";

type Props = {
  onClose: () => void;
  /** The element the hint hangs off — clicks inside it don't dismiss. */
  anchorRef: RefObject<HTMLElement | null>;
};

/**
 * The gentle "become a builder first" nudge. A popover (same shell as
 * {@link ModPopup}) anchored to whatever the user tapped while locked out — a
 * star button or a blocked journey card. Rendered through a portal to <body> so
 * no transformed card / overflow ancestor can clip it: it's viewport-`fixed` at
 * the anchor's rect on every screen size — the nudge always points at whatever
 * was tapped rather than detaching to a bottom sheet (`.popup:not(.locked-hint)`
 * in App.css excludes it from the mobile bottom-sheet rule). Pass an `anchorRef`
 * to the element it hangs off (also used to keep clicks inside it from
 * dismissing). The portal breaks CSS inheritance, so the `--journey-hue` tint is
 * copied off the anchor's computed style onto the popover explicitly.
 */
export default function LockedHint({ onClose, anchorRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { startBecomeBuilder } = useOnboarding();
  // A viewport-fixed position computed from the anchor's rect (null until
  // measured), on every screen size — the nudge always points at whatever was
  // tapped rather than detaching to a bottom sheet. The hint is portaled to
  // <body>, so `position: fixed` is the viewport — no transformed card /
  // overflow ancestor can clip or trap it.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // The journey tint, lifted off the anchor since the portal severs inheritance.
  const [hue, setHue] = useState<string>("");

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor) {
      setHue(getComputedStyle(anchor).getPropertyValue("--journey-hue").trim());
    }
  }, [anchorRef]);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const node = ref.current;
      const w = node?.offsetWidth ?? 280;
      const h = node?.offsetHeight ?? 0;
      const margin = 8;
      let left = a.left;
      const maxLeft = window.innerWidth - w - margin;
      if (left > maxLeft) left = maxLeft;
      if (left < margin) left = margin;
      let top = a.bottom + 8;
      // Flip above the button if the popover would overflow the bottom edge.
      if (h && top + h > window.innerHeight - margin) {
        const above = a.top - 8 - h;
        top = above >= margin ? above : Math.max(margin, window.innerHeight - h - margin);
      }
      setPos({ top, left });
    };
    update();
    // Capture-phase scroll catches any scrolling ancestor, not just the window.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="popup locked-hint is-open"
      role="dialog"
      aria-label="Become a builder"
      onClick={(e) => e.stopPropagation()}
      data-testid="locked-hint"
      style={
        {
          ...(hue ? { "--journey-hue": hue } : {}),
          ...(pos ? { position: "fixed", top: pos.top, left: pos.left } : {}),
        } as CSSProperties
      }
    >
      <div className="popup-body">
        <p>Become a builder to enter the competition.</p>
        <button
          type="button"
          className="popup-cta locked-hint-cta"
          onClick={(e) => {
            e.stopPropagation();
            startBecomeBuilder();
            onClose();
          }}
          data-testid="locked-hint-start"
        >
          Start <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
