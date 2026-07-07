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

// Client-side image optimizer, applied to EVERY upload. The page never
// displays an image wider than 640 CSS px (the content column), so anything
// beyond 1280px (2× DPR) is wasted on-chain bytes — downscale to that cap,
// re-encode, and keep shrinking if the byte budget still overflows.
//
// Format choice preserves transparency:
//   - opaque images   → JPEG q0.8 (best photo compression)
//   - transparent     → WebP q0.8 (alpha + lossy) where the browser can encode
//                       it; otherwise PNG (Safari/WebKit can't encode WebP) —
//                       lossless, fitted by the scale loop alone.
// Images that already fit both caps pass through untouched.

/** Largest useful dimension: the 640px content column at 2× DPR. */
export const MAX_IMAGE_DIMENSION = 1280;

const INITIAL_QUALITY = 0.8;
const MIN_QUALITY = 0.4;
const MIN_SCALE = 0.05;
const QUALITY_STEP = 0.1;
const SCALE_STEP = 0.8;

async function loadImage(file: File): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`Could not decode ${file.name}`));
            img.src = url;
        });
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function encodeCanvas(
    canvas: HTMLCanvasElement,
    type: string,
    quality: number,
): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("Canvas encode failed"))),
            type,
            quality,
        );
    });
}

function hasAlpha(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

const EXTENSIONS: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/png": ".png",
};

export interface ResizeResult {
    bytes: Uint8Array;
    filename: string;
    originalBytes: number;
    finalBytes: number;
    scale: number;
    quality: number;
}

export async function resizeImageToFit(
    file: File,
    maxBytes: number,
    maxDimension = MAX_IMAGE_DIMENSION,
): Promise<ResizeResult> {
    const img = await loadImage(file);
    const largest = Math.max(img.naturalWidth, img.naturalHeight);
    const fitScale = largest > maxDimension ? maxDimension / largest : 1;

    // Already fits both caps — pass through untouched (preserves the original
    // format exactly; no generational loss).
    if (fitScale === 1 && file.size <= maxBytes) {
        return {
            bytes: new Uint8Array(await file.arrayBuffer()),
            filename: file.name,
            originalBytes: file.size,
            finalBytes: file.size,
            scale: 1,
            quality: 1,
        };
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const draw = (scale: number, fillWhite: boolean) => {
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (fillWhite) {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };

    // Pick the output format once, from the actual pixels.
    draw(fitScale, false);
    let format = "image/jpeg";
    if (hasAlpha(ctx, canvas.width, canvas.height)) {
        const probe = await encodeCanvas(canvas, "image/webp", INITIAL_QUALITY);
        // Browsers that can't encode WebP (Safari) hand back PNG here.
        format = probe.type === "image/webp" ? "image/webp" : "image/png";
    }
    const lossy = format !== "image/png";

    let scale = fitScale;
    let quality = INITIAL_QUALITY;

    while (true) {
        draw(scale, format === "image/jpeg");
        const blob = await encodeCanvas(canvas, format, quality);
        if (blob.size <= maxBytes) {
            return {
                bytes: new Uint8Array(await blob.arrayBuffer()),
                filename: file.name.replace(/\.[^.]+$/, "") + EXTENSIONS[format],
                originalBytes: file.size,
                finalBytes: blob.size,
                scale,
                quality: lossy ? quality : 1,
            };
        }

        if (lossy && quality > MIN_QUALITY + 1e-6) {
            quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
            continue;
        }
        scale *= SCALE_STEP;
        quality = INITIAL_QUALITY;
        if (scale < MIN_SCALE) {
            throw new Error(
                `Could not compress image under ${maxBytes.toLocaleString()} bytes ` +
                    `(stuck at scale ${(scale / SCALE_STEP).toFixed(2)}, ` +
                    `last size ${blob.size.toLocaleString()})`,
            );
        }
    }
}
