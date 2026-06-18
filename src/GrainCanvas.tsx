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

import { useRef, useEffect } from "react";
import { useIsMobile } from "./utils";

/**
 * Static procedural grain — paints once on mount, repaints on resize.
 * Ported from the playground-dapp-store mockup's noise_bg.js.
 *
 * Skipped on mobile: the mobile host webview composites mix-blend-mode
 * incorrectly, so the grain + lighten-blend stack can't be trusted there.
 * The page falls back to the flat #04040A body background (App.css).
 */

type NoiseOptions = {
  shape: "round" | "square";
  size: number;
  density: number;
  intensity: number;
  bg: string;
  fg: string;
  alpha: number;
  variance: number;
  mono: number;
  seed: number;
};

const DEFAULT_OPTIONS: NoiseOptions = {
  shape: "round",
  size: 6,
  density: 1,
  intensity: 0.1,
  bg: "#111111",
  fg: "#555555",
  alpha: 0.1,
  variance: 1,
  mono: 1,
  seed: 42,
};

function mulberry32(seed: number) {
  let s = (seed | 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function renderNoise(canvas: HTMLCanvasElement, opts: NoiseOptions) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  if (!W || !H) return;

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, W, H);

  const fg = hexToRgb(opts.fg);
  const rand = mulberry32(opts.seed);
  const baseA = opts.alpha * opts.intensity;

  let r = fg.r, g = fg.g, b = fg.b;
  if (opts.mono > 0) {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = Math.round(r * (1 - opts.mono) + lum * opts.mono);
    g = Math.round(g * (1 - opts.mono) + lum * opts.mono);
    b = Math.round(b * (1 - opts.mono) + lum * opts.mono);
  }

  const area = W * H;
  const particleArea = Math.max(1, Math.PI * opts.size * opts.size);
  const count = Math.min(2_000_000, Math.floor((area / particleArea) * opts.density));

  const size = opts.size;
  const half = size / 2;
  const isRound = opts.shape === "round";

  const BUCKETS = 16;
  const maxA = Math.min(1, baseA * (1 + opts.variance));
  const buckets: number[][] = Array.from({ length: BUCKETS }, () => []);

  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const jitter = 1 + (rand() * 2 - 1) * opts.variance;
    const a = Math.max(0, Math.min(1, baseA * jitter));
    const bIdx = Math.min(BUCKETS - 1, Math.floor((a / (maxA || 1)) * BUCKETS));
    buckets[bIdx].push(x, y);
  }

  for (let bi = 0; bi < BUCKETS; bi++) {
    const arr = buckets[bi];
    if (!arr.length) continue;
    const a = ((bi + 0.5) / BUCKETS) * maxA;
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;

    if (isRound && size >= 1.5) {
      ctx.beginPath();
      for (let j = 0; j < arr.length; j += 2) {
        const x = arr[j];
        const y = arr[j + 1];
        ctx.moveTo(x + half, y);
        ctx.arc(x, y, half, 0, Math.PI * 2);
      }
      ctx.fill();
    } else {
      for (let j = 0; j < arr.length; j += 2) {
        ctx.fillRect(arr[j] - half, arr[j + 1] - half, size, size);
      }
    }
  }
}

export default function GrainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isMobile) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const paint = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      renderNoise(canvas, DEFAULT_OPTIONS);
    };

    paint();

    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(paint, 120);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (t) clearTimeout(t);
    };
  }, [isMobile]);

  if (isMobile) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
}
