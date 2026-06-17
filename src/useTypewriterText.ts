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

import { useEffect, useRef, type RefObject } from "react";

export function useTypewriterText(
  target: string,
  ref: RefObject<HTMLElement | null>,
  charDelay = 11,
): void {
  const fired = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || fired.current) return;

    el.textContent = "";
    const timers: ReturnType<typeof setTimeout>[] = [];

    const run = () => {
      fired.current = true;
      for (let i = 0; i < target.length; i++) {
        timers.push(
          setTimeout(() => {
            el.textContent = target.slice(0, i + 1);
          }, i * charDelay),
        );
      }
    };

    if (typeof IntersectionObserver === "undefined") {
      run();
      return () => {
        timers.forEach(clearTimeout);
      };
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            io.disconnect();
            run();
            break;
          }
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [target, ref, charDelay]);
}
