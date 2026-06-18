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

// Route entry for the embedded site builder (/builder). Two states:
//
//   1. Landing (default) — a normal in-shell tab page where the user picks a
//      starting point (resume draft / template / blank mode). The playground
//      chrome (rail, ticker, mobile bottom nav) stays fully visible.
//   2. Editor takeover — once a starting point is picked, the fullscreen
//      builder mounts. The isolation seam: everything builder-specific lives
//      under .builder-root + a body class only the takeover sets, so the
//      playground shell is untouched when unmounted. The editor's Back tab
//      returns to the landing page.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import BuilderApp from "./BuilderApp.tsx";
import Landing from "./Landing.tsx";
import {
  deleteDraft,
  loadDrafts,
  restoreDraft,
  type BuilderEntry,
  type DraftRecord,
} from "./draft.ts";
import "./builder.css";

export default function BuilderTab() {
  const [entry, setEntry] = useState<BuilderEntry | null>(null);
  const [drafts, setDrafts] = useState(() => loadDrafts());
  // Delete acts IMMEDIATELY with an undo window — window.confirm is a
  // silent auto-decline on the mobile hosts (unwired JS dialogs), and the
  // act-then-undo pattern is better UX everywhere anyway. The undo renders
  // IN PLACE (the deleted card's slot), so `index` rides along.
  const [undoable, setUndoable] = useState<{
    record: DraftRecord;
    index: number;
  } | null>(null);
  const undoTimer = useRef<number | null>(null);
  const handleDelete = (record: DraftRecord, index: number) => {
    deleteDraft(record.id);
    setDrafts(loadDrafts());
    setUndoable({ record, index });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoable(null), 6000);
  };
  const handleUndo = () => {
    if (!undoable) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    restoreDraft(undoable.record);
    setDrafts(loadDrafts());
    setUndoable(null);
  };
  // Clicking "Site Builder" in the rail while the editor is open
  // re-navigates to /builder — same pathname, new history key. Treat it like the Back tab:
  // return to the landing. The draft is safe: BuilderApp's unmount cleanup
  // flushes it (dirty-gated) before the drafts reload below runs.
  const { key: locationKey } = useLocation();
  useEffect(() => {
    setEntry(null); // no-op on mount and on landing (already null)
  }, [locationKey]);
  // Re-read on every return to the landing so the draft cards reflect the
  // session that just exited (the editor flushes its draft before onExit).
  useEffect(() => {
    if (entry === null) setDrafts(loadDrafts());
  }, [entry]);

  if (!entry)
    return (
      <Landing
        drafts={drafts}
        onPick={setEntry}
        onDelete={handleDelete}
        undoable={undoable}
        onUndo={handleUndo}
      />
    );
  return (
    <EditorTakeover
      entry={entry}
      onExit={() => setEntry(null)}
      onSwitchEntry={setEntry}
    />
  );
}

function EditorTakeover({
  entry,
  onExit,
  onSwitchEntry,
}: {
  entry: BuilderEntry;
  onExit: () => void;
  onSwitchEntry: (next: BuilderEntry) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // ≤820px: playground's rail becomes a bottom bar that collides with the
    // builder's own bottom nav — builder.css hides it under this class.
    document.body.classList.add("is-builder-active");
    return () => document.body.classList.remove("is-builder-active");
  }, []);

  // Track the slice of the layout viewport obscured by mobile browser
  // chrome (ported from hello-playground's main.tsx — Firefox Android's
  // bottom URL bar overlays fixed content and is NOT in
  // env(safe-area-inset-bottom)). Scoped to the builder root element since
  // --vv-bottom only feeds builder.css rules.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = rootRef.current;
    if (!vv || !el) return;
    const update = () => {
      const obscured = window.innerHeight - (vv.offsetTop + vv.height);
      el.style.setProperty("--vv-bottom", `${Math.max(0, Math.round(obscured))}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // In a sandboxed iframe (dot.li web host) in-frame scrolls don't move the
  // URL bar — reserve a fixed safety margin instead (see builder.css).
  const inIframe = typeof window !== "undefined" && window.self !== window.top;

  return (
    <div ref={rootRef} className={`builder-root${inIframe ? " in-iframe" : ""}`}>
      {/* Keyed: the Simple → HTML fork swaps entries editor-to-editor, and
          BuilderApp reads its entry once via lazy state init. */}
      <BuilderApp key={entry.id} entry={entry} onExit={onExit} onSwitchEntry={onSwitchEntry} />
    </div>
  );
}
