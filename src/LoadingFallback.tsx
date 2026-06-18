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

import { useEffect, useState, type CSSProperties } from "react";

// Suspense fallback for lazy-loaded routes/chunks. A bare `fallback={null}`
// turns a slow or hung chunk fetch (common on congested conference wifi /
// the host transport, which hangs rather than errors) into a permanent blank
// screen with no signal at all. This fallback always shows a spinner, and —
// via progressive disclosure — adds a calm "still loading, try reloading"
// hint once a load runs long, without alarming on the common fast path.
//
// We intentionally do NOT render a Reload button: inside the Polkadot host a
// page cannot reload itself (window.location.reload(), location.assign(), and
// hostApi.navigateTo() are all no-ops under the polkadot:// scheme), so a
// button would silently do nothing there. A plain-language "try reloading the
// page" hint works everywhere — the user reloads via whatever their host /
// browser offers (pull-to-refresh, reopen, Cmd/Ctrl+R).
//
// `compact` renders an inline-sized variant (no 60vh, smaller spinner/text) for
// fallbacks shown inside a panel rather than as a full route — e.g. the builder
// code editor, which previously used a plain "Loading editor…" div with no
// timer and no signal. `label` overrides the pre-grace "Loading…" line.
export function LoadingFallback({
  graceMs = 8_000,
  label = "Loading…",
  compact = false,
}: {
  graceMs?: number;
  label?: string;
  compact?: boolean;
}) {
  // After the grace period, escalate from a bare spinner to a gentle hint. Most
  // loads finish well before this, so the hint only appears when something is
  // actually slow.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), graceMs);
    return () => clearTimeout(t);
  }, [graceMs]);

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontFamily: "ui-monospace, monospace",
    textAlign: "center",
    minHeight: compact ? "auto" : "60vh",
    gap: compact ? "0.6rem" : "1rem",
    padding: compact ? "1rem" : "2rem",
    fontSize: compact ? 13 : undefined,
  };
  const spinnerSize = compact ? 20 : 28;

  return (
    <div role="status" aria-live="polite" style={containerStyle}>
      <span
        className="lf-spinner"
        aria-hidden="true"
        style={{ width: spinnerSize, height: spinnerSize }}
      />
      <style>{
        // Spinner styling lives here (not inline) so the reduced-motion media
        // query can override it — an inline animation can't be overridden.
        ".lf-spinner{" +
          "display:block;" +
          "border:3px solid rgba(255,255,255,0.2);" +
          "border-top-color:#e6007a;" +
          "border-radius:50%;" +
          "animation:lf-spin 0.8s linear infinite;" +
        "}" +
        "@keyframes lf-spin{to{transform:rotate(360deg)}}" +
        // Honour reduced-motion: keep a slow turn (so it still reads as "busy",
        // not frozen/broken) rather than a fast spin.
        "@media (prefers-reduced-motion: reduce){.lf-spinner{animation-duration:2.4s}}"
      }</style>
      <p style={{ margin: 0, opacity: 0.6 }}>{label}</p>
      {slow && (
        <p
          style={{
            margin: 0,
            opacity: 0.7,
            maxWidth: 300,
            fontSize: compact ? 12 : 13,
            lineHeight: 1.5,
          }}
        >
          This is taking longer than usual. If it doesn't load, try reloading the page.
        </p>
      )}
    </div>
  );
}
