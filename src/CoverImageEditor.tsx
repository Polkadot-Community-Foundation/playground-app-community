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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ErrorBanner from "./ErrorBanner.tsx";

// Hero is rendered at `aspect-ratio: 2 / 1` (see .detail-hero in App.css), so
// the crop window matches — anything else would be re-cropped by the browser
// at render time.
const COVER_ASPECT = 2;
// Adaptive encoding ladder: try each (width, quality) pair in order, stop on
// the first that fits MAX_OUTPUT_BYTES. The Polkadot Desktop host's
// `session.createTransaction` IPC has a hard message-size cap; a 33 KB
// extrinsic is empirically already over it (`createTransaction failed:
// message too big`). The cap sits somewhere below 32 KB raw payload, so we
// aim well under that and accept noticeably lower image quality as the
// price of the cover landing at all.
const ENCODE_STEPS: ReadonlyArray<{ width: number; quality: number }> = [
  { width: 800, quality: 0.55 },
  { width: 640, quality: 0.5 },
  { width: 480, quality: 0.45 },
  { width: 360, quality: 0.4 },
  { width: 256, quality: 0.35 },
  { width: 192, quality: 0.3 },
];
const MAX_OUTPUT_BYTES = 10 * 1024;
// Cap input file size before decoding — protects against accidentally picking
// a multi-hundred-megabyte camera-roll original.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Saving is a separate flag (not a Status variant) so a failed save can drop
// back to "editing" with the same image + crop intact — otherwise the user
// loses their pan/zoom and has to re-pick the file.
type Status =
  | { kind: "picking" }
  | { kind: "editing"; image: HTMLImageElement; objectUrl: string };

interface Props {
  /** Current cover URL (blob: URL or null) — shown as the empty-state preview. */
  currentCoverUrl: string | null;
  /** Async — upload to Bulletin + re-publish metadata. Resolves on success. */
  onSave: (coverBytes: Uint8Array) => Promise<void>;
  onClose: () => void;
  /**
   * Called when the save aborts because the user cancelled the host
   * permission dialog. The editor closes itself; the parent can surface a
   * short toast.
   */
  onCancelled?: (message: string) => void;
}

export default function CoverImageEditor({ currentCoverUrl, onSave, onClose, onCancelled }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "picking" });
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Display-space transform applied to the image inside the crop window.
  // Scale is multiplicative on top of the "cover" baseline fit; offset is
  // measured in CSS pixels of the crop window.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Measured size of the crop window. Re-measured on resize so the editor
  // stays correct if the modal is narrow on mobile.
  const [cropSize, setCropSize] = useState<{ w: number; h: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const cropElRef = useRef<HTMLDivElement | null>(null);

  // Revoke the temporary object URL when the editor unmounts or a new file is
  // picked — otherwise we leak one blob URL per file the user previews.
  useEffect(() => {
    return () => {
      if (status.kind === "editing") URL.revokeObjectURL(status.objectUrl);
    };
  }, [status]);

  // Measure the crop window. Layout effect so the first paint with an image
  // has the right dimensions; ResizeObserver keeps it correct on resize.
  useLayoutEffect(() => {
    const el = cropElRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setCropSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status.kind]);

  // Cover-fit baseline: image just fills the crop window short axis. Display
  // scale = (baseline ratio) * (user-controlled scale).
  const image = status.kind === "editing" ? status.image : null;
  const baseRatio =
    cropSize && image
      ? Math.max(cropSize.w / image.naturalWidth, cropSize.h / image.naturalHeight)
      : 0;
  const fittedW = image ? image.naturalWidth * baseRatio : 0;
  const fittedH = image ? image.naturalHeight * baseRatio : 0;
  const dispW = fittedW * scale;
  const dispH = fittedH * scale;

  // Clamp pan so the scaled image never reveals empty space inside the crop
  // window. With cover-fit baseline, scale >= 1 always means dispW >= cropW
  // (likewise H), so the allowed range is half the overflow on each axis.
  const clampOffset = useCallback(
    (next: { x: number; y: number }, s: number) => {
      if (!cropSize) return next;
      const w = fittedW * s;
      const h = fittedH * s;
      const maxX = Math.max(0, (w - cropSize.w) / 2);
      const maxY = Math.max(0, (h - cropSize.h) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y)),
      };
    },
    [cropSize, fittedW, fittedH],
  );

  const handlePick = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setErrorMessage("Pick a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setErrorMessage("Image is too large. Keep it under 20 MB.");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setErrorMessage(null);
      setStatus({ kind: "editing", image: img, objectUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setErrorMessage("Couldn't read that image.");
    };
    img.src = objectUrl;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (status.kind !== "editing") return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { startX, startY, baseX, baseY } = dragRef.current;
    setOffset(clampOffset({ x: baseX + (e.clientX - startX), y: baseY + (e.clientY - startY) }, scale));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onScaleChange = (next: number) => {
    setScale(next);
    setOffset(o => clampOffset(o, next));
  };

  const encodeAt = async (width: number, quality: number): Promise<Uint8Array> => {
    if (status.kind !== "editing" || !cropSize) {
      throw new Error("No image to crop");
    }
    const height = width / COVER_ASPECT;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    // Translate display-space pan/scale into source-image-space crop coords:
    // 1 display px = (1 / displayScale) source px, where
    // displayScale = (fittedW / naturalWidth) * scale = baseRatio * scale.
    const displayScale = baseRatio * scale;
    const sw = cropSize.w / displayScale;
    const sh = cropSize.h / displayScale;
    // At offset=(0,0) the centre of the source image is at the centre of the
    // crop window. Positive offset.x shifts the displayed image right, which
    // means the crop window is reading from further LEFT in the source — so
    // sx subtracts (offset / displayScale).
    const sx = (status.image.naturalWidth - sw) / 2 - offset.x / displayScale;
    const sy = (status.image.naturalHeight - sh) / 2 - offset.y / displayScale;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(status.image, sx, sy, sw, sh, 0, 0, width, height);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/jpeg", quality),
    );
    return new Uint8Array(await blob.arrayBuffer());
  };

  const renderToBytes = async (): Promise<Uint8Array> => {
    // Adaptive ladder: walk smaller/lower-quality variants until one fits.
    // Logs every step's size so we can tighten the budget if the host keeps
    // rejecting. Falls back to the smallest variant if every step is over
    // budget — the tx may still get rejected, but the surfaced error is the
    // host's, not ours.
    let last: Uint8Array | null = null;
    for (const step of ENCODE_STEPS) {
      const bytes = await encodeAt(step.width, step.quality);
      const fits = bytes.byteLength <= MAX_OUTPUT_BYTES;
      last = bytes;
      if (fits) return bytes;
    }
    return last ?? (await encodeAt(ENCODE_STEPS[ENCODE_STEPS.length - 1].width, ENCODE_STEPS[ENCODE_STEPS.length - 1].quality));
  };

  const handleSave = async () => {
    if (status.kind !== "editing") return;
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const bytes = await renderToBytes();
      await onSave(bytes);
    } catch (err) {
      // A cancelled host permission dialog is a user gesture, not a failure —
      // dismiss the editor and let the parent surface a short toast instead
      // of keeping the modal open in an unrecoverable state.
      if (err instanceof Error && (err.name === "PermissionDeniedError" || err.name === "InsufficientFundsError")) {
        setIsSaving(false);
        onCancelled?.(err.message);
        onClose();
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : "Failed to save cover image.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal cover-editor-modal"
        onClick={e => e.stopPropagation()}
        data-testid="cover-editor-modal"
        data-status={status.kind}
        data-saving={isSaving ? "true" : "false"}
      >
        <h2>Edit cover image</h2>

        {errorMessage && (
          <ErrorBanner message={errorMessage} compact testid="cover-editor-error" />
        )}

        {status.kind === "editing" ? (
          <>
            <div
              ref={cropElRef}
              className="cover-editor-crop"
              data-testid="cover-editor-crop"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                src={status.objectUrl}
                alt=""
                draggable={false}
                className="cover-editor-image"
                style={{
                  width: dispW,
                  height: dispH,
                  // Centre the image then add user pan. -50% resolves against
                  // the image's own size (width/height set above), so this is
                  // pure CSS centring with the pan added in pixels.
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                }}
              />
            </div>
            <div className="cover-editor-controls">
              <label className="cover-editor-zoom-label">
                <span>Zoom</span>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.01}
                  value={scale}
                  onChange={e => onScaleChange(Number(e.target.value))}
                  data-testid="cover-editor-zoom"
                />
              </label>
              <label className="btn btn-ghost cover-editor-replace">
                Replace image
                <input
                  type="file"
                  accept={ACCEPTED_TYPES.join(",")}
                  style={{ display: "none" }}
                  onChange={e => handlePick(e.target.files?.[0])}
                />
              </label>
            </div>
          </>
        ) : (
          <div
            className="cover-editor-empty"
            style={
              currentCoverUrl
                ? { backgroundImage: `url(${currentCoverUrl})` }
                : undefined
            }
            data-testid="cover-editor-empty"
          >
            <label className="btn btn-publish cover-editor-pick">
              {currentCoverUrl ? "Choose a new image" : "Choose an image"}
              <input
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                style={{ display: "none" }}
                onChange={e => handlePick(e.target.files?.[0])}
              />
            </label>
            <p className="cover-editor-hint">
              JPEG, PNG, or WebP. Cropped to a 2:1 banner.
            </p>
          </div>
        )}

        <div className="modal-actions">
          <button
            className="btn btn-ghost"
            onClick={onClose}
            data-testid="cover-editor-cancel"
          >
            Cancel
          </button>
          <button
            className="btn btn-publish"
            onClick={handleSave}
            disabled={status.kind !== "editing" || isSaving}
            data-testid="cover-editor-save"
          >
            {isSaving ? "Saving..." : "Save cover"}
          </button>
        </div>
      </div>
    </div>
  );
}
