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

const SCRAMBLE_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";

export function useScrambleText(
  target: string,
  ref: RefObject<HTMLElement | null>,
): void {
  const lastTarget = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastTarget.current === target) return;
    lastTarget.current = target;

    const current = el.textContent ?? "";
    const len = Math.max(current.length, target.length);
    const padCurrent = current.padEnd(len, " ");
    const padTarget = target.padEnd(len, " ");
    const state = padCurrent.split("");
    const timers: ReturnType<typeof setTimeout>[] = [];

    const render = () => {
      el.textContent = state.join("");
    };

    for (let i = 0; i < len; i++) {
      if (padCurrent[i] === padTarget[i]) continue;
      const startDelay = Math.random() * 420;
      const cycles = 3 + Math.floor(Math.random() * 6);
      const cycleMs = 15;
      for (let c = 0; c < cycles; c++) {
        timers.push(
          setTimeout(() => {
            state[i] =
              SCRAMBLE_CHARSET[
                Math.floor(Math.random() * SCRAMBLE_CHARSET.length)
              ];
            render();
          }, startDelay + c * cycleMs),
        );
      }
      timers.push(
        setTimeout(() => {
          state[i] = padTarget[i];
          render();
        }, startDelay + cycles * cycleMs),
      );
    }

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [target, ref]);
}
