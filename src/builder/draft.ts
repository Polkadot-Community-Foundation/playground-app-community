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

// Draft persistence + editor entry points. Pure logic (no React) so the
// landing page can read the draft without mounting the editor, and vitest
// can import it without a DOM. Extracted from BuilderApp.tsx when the
// landing page took over template/mode selection.

import {
    assembleDocument,
    DEFAULT_CONTENT,
    escapeHtml,
    renderHtml,
    type Block,
    type SiteContent,
} from "./template.ts";
import { blocksToMarkdown, renderMarkdownHtml } from "./markdown.ts";
import type { Template } from "./templates.ts";

// Modes are chosen on the landing page and fixed for the session, with one
// exception: blocks ("Simple") can FORK to html — the conversion opens as a
// new draft and the Simple original is kept. No transition mutates or loses
// anything.
export type EditorMode = "blocks" | "markdown" | "html";

export const MODE_NAMES: Record<EditorMode, string> = {
    blocks: "Simple",
    markdown: "Markdown",
    html: "HTML",
};

// Draft autosave: the full editing state, debounced into localStorage so a
// refresh/crash never loses work. Undo history is session-only by design.
// A LIST of drafts, so starting a new layout never clobbers existing work.
const STORAGE_KEY = "site-builder.drafts.v1";

// Bounds the landing page's draft list, not storage (drafts are KBs — images
// live on Bulletin as URLs). At the cap the landing BLOCKS new starts with an
// explicit message; nothing is ever silently evicted.
export const MAX_DRAFTS = 10;

export interface Draft {
    mode: EditorMode;
    content: SiteContent;
    markdownText: string;
    htmlText: string;
    cssText: string;
    jsText: string;
}

export interface DraftRecord {
    id: string;
    /** Last save, ms epoch — orders the landing list, newest first. */
    updatedAt: number;
    draft: Draft;
}

/** How the editor is entered from the /builder landing page. `id` is the draft
 *  slot the session autosaves into — minted fresh for template/blank starts,
 *  so a new start never touches existing drafts. */
export type BuilderEntry =
    | { kind: "resume"; id: string; draft: Draft }
    | { kind: "template"; id: string; template: Template }
    | { kind: "blank"; id: string; mode: Exclude<EditorMode, "blocks"> };

export function newDraftId(): string {
    return makeBlockId();
}

export function makeBlockId(): string {
    return Math.random().toString(36).slice(2, 10);
}

// localStorage is user-writable and schema versions drift — a draft block
// missing a required string field crashed render (escapeHtml(undefined)),
// and unknown block types rendered as "undefined". Keep only blocks that
// match the model, defaulting the per-block strings; theme fields default
// to the blank template's values. Corrupt-beyond-JSON records are dropped
// by loadDrafts' validation instead.
function sanitizeContent(c: SiteContent): SiteContent {
    const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
    const blocks: Block[] = (Array.isArray(c.blocks) ? c.blocks : [])
        .filter((b): b is Block => !!b && typeof b === "object" && typeof b.type === "string")
        .flatMap((b): Block[] => {
            const id = str(b.id) || makeBlockId();
            switch (b.type) {
                case "heading":
                case "paragraph":
                    return [{ id, type: b.type, text: str(b.text) }];
                case "link":
                    return [{ ...b, id, label: str(b.label), url: str(b.url) }];
                case "image":
                    return [{ ...b, id, url: str(b.url), alt: str(b.alt) }];
                case "divider":
                    return [{ id, type: "divider" }];
                default:
                    return []; // unknown type — drop rather than render "undefined"
            }
        });
    return {
        ...c,
        accentColor: str(c.accentColor, "#e6007a"),
        background: str(c.background, "#0b0d12"),
        fontFamily: str(c.fontFamily, "system-ui"),
        blocks,
    };
}

// A draft from storage: shape-gate plus defaulting the text panes
// (user-writable storage — never trust a field exists).
function validateDraft(d: unknown): Draft | null {
    if (!d || typeof d !== "object") return null;
    const draft = d as Draft;
    if (!draft.content || !Array.isArray(draft.content.blocks)) return null;
    if (!["blocks", "markdown", "html"].includes(draft.mode)) return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    return {
        mode: draft.mode,
        content: sanitizeContent(draft.content),
        markdownText: str(draft.markdownText),
        htmlText: str(draft.htmlText),
        cssText: str(draft.cssText),
        jsText: str(draft.jsText),
    };
}

/** All drafts, newest first. Malformed records are dropped, not fatal. */
export function loadDrafts(): DraftRecord[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const list: unknown = JSON.parse(raw);
        if (!Array.isArray(list)) return [];
        return list
            .flatMap((r): DraftRecord[] => {
                if (!r || typeof r !== "object") return [];
                const rec = r as DraftRecord;
                if (typeof rec.id !== "string" || !rec.id) return [];
                const draft = validateDraft(rec.draft);
                if (!draft) return [];
                const updatedAt = typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
                return [{ id: rec.id, updatedAt, draft }];
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        // Unavailable storage (private mode, sandbox) or corrupt JSON.
        return [];
    }
}

/** Upsert one draft slot. Loading first re-validates the whole list, so a
 *  corrupt sibling record gets dropped here rather than resaved forever. */
export function saveDraft(id: string, draft: Draft): void {
    try {
        const records = loadDrafts().filter((r) => r.id !== id);
        records.unshift({ id, updatedAt: Date.now(), draft });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
        // Storage full/unavailable — autosave is best-effort.
    }
}

/** Re-insert a deleted draft with its ORIGINAL timestamp — the undo half
 *  of delete-with-undo (the mobile hosts silently auto-decline
 *  window.confirm, so deletes act immediately and undo is the safety net). */
export function restoreDraft(record: DraftRecord): void {
    try {
        const records = loadDrafts().filter((r) => r.id !== record.id);
        records.push(record);
        records.sort((a, b) => b.updatedAt - a.updatedAt);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
        // best-effort
    }
}

export function deleteDraft(id: string): void {
    try {
        const records = loadDrafts().filter((r) => r.id !== id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
        // best-effort
    }
}

/** The draft's page title for the landing page's resume card. Display-only:
 *  no entity decoding, first heading wins, same h1–h3 rule as titleFromHtml. */
export function draftTitle(d: Draft): string {
    const fallback = "Untitled page";
    switch (d.mode) {
        case "blocks": {
            for (const b of d.content.blocks) {
                if (b.type === "heading") return b.text.trim() || fallback;
            }
            return fallback;
        }
        case "markdown": {
            const m = d.markdownText.match(/^#{1,3}\s+(.+)$/m);
            return m?.[1].trim() || fallback;
        }
        case "html": {
            const m = d.htmlText.match(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/i);
            const text = m ? m[2].replace(/<[^>]*>/g, "").trim() : "";
            return text || fallback;
        }
    }
}

/** The draft rendered as the same standalone document the editor's preview
 *  and deploy consume (BuilderApp's currentHtml, switched on the saved mode).
 *  Feeds the landing page's resume-card thumbnail. */
export function draftHtml(d: Draft): string {
    switch (d.mode) {
        case "blocks":
            return renderHtml(d.content);
        case "markdown":
            return renderMarkdownHtml(d.markdownText, d.content);
        case "html":
            return assembleDocument({
                title: escapeHtml(draftTitle(d)),
                css: d.cssText,
                bodyHtml: d.htmlText,
                js: d.jsText,
            });
    }
}

// Blank HTML start: a small working document across all three panes. The CSS
// sets background/color EXPLICITLY — the preview iframe is transparent when
// the document paints no background, so an unstyled page would render its
// default black text straight onto the app's dark canvas. The JS is the
// minimal proof the script pane runs.
const STARTER_HTML = `<h1>Hello, world</h1>
<p>This is your page. Edit the HTML, CSS, and JS panes.</p>
<button id="greet">Click me</button>
<p id="output"></p>
`;
const STARTER_CSS = `body {
    margin: 0;
    padding: 64px 24px;
    background: #0b0d12;
    color: #f5f5f5;
    font-family: system-ui, sans-serif;
    line-height: 1.5;
}
h1 {
    color: #e6007a;
}
button {
    padding: 10px 20px;
    border: 0;
    border-radius: 999px;
    background: #e6007a;
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
}
button:hover {
    opacity: 0.85;
}
`;
const STARTER_JS = `const button = document.getElementById("greet");
const output = document.getElementById("output");
let clicks = 0;
button.addEventListener("click", () => {
    clicks += 1;
    output.textContent = \`Hello! You clicked \${clicks} time\${clicks === 1 ? "" : "s"}.\`;
});
`;

/** Initial editing state for an entry picked on the landing page. Blank
 *  markdown seeds from DEFAULT_CONTENT exactly like the in-editor convert
 *  path, so both routes into markdown start from the same document. */
export function initialStateForEntry(entry: BuilderEntry): Draft {
    switch (entry.kind) {
        case "resume":
            return entry.draft;
        case "template":
            return {
                mode: "blocks",
                content: entry.template.build(),
                markdownText: "",
                htmlText: "",
                cssText: "",
                jsText: "",
            };
        case "blank":
            return entry.mode === "markdown"
                ? {
                      mode: "markdown",
                      content: DEFAULT_CONTENT,
                      markdownText: blocksToMarkdown(DEFAULT_CONTENT),
                      htmlText: "",
                      cssText: "",
                      jsText: "",
                  }
                : {
                      mode: "html",
                      content: DEFAULT_CONTENT,
                      markdownText: "",
                      htmlText: STARTER_HTML,
                      cssText: STARTER_CSS,
                      jsText: STARTER_JS,
                  };
    }
}
