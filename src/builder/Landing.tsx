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

// /builder landing page — rendered INSIDE the playground shell (rail, ticker,
// normal tab layout), so the fullscreen editor takeover only happens after
// the user commits to a starting point. The Instagram shape: launcher →
// picker → editor. Picking a template implies blocks mode (templates build
// SiteContent); Markdown and HTML start blank in their respective modes.
// Every start mints a fresh draft slot — existing drafts are never replaced,
// only explicitly deleted (capped at MAX_DRAFTS, blocked with a message).

import { useMemo, type ReactNode } from "react";
import BecomeBuilderCard from "../BecomeBuilderCard.tsx";
import { useOnboarding } from "../OnboardingProvider.tsx";
import { TEMPLATES } from "./templates.ts";
import { renderHtml } from "./template.ts";
import { iframesAllowed } from "./iframes.ts";
import { loadDeployedSites } from "./deployed.ts";
import { PopupLink } from "./LinkPopup.tsx";
import {
    draftHtml,
    draftTitle,
    newDraftId,
    MAX_DRAFTS,
    MODE_NAMES,
    type BuilderEntry,
    type DraftRecord,
} from "./draft.ts";

// Decorative source previews for the write-it-yourself cards (aria-hidden;
// the real copy lives in the card name/desc). Lines mirror what the blank
// starters actually open with.
const MD_SNIPPET = (
    <>
        <span className="builder-code-k"># Hello, world</span>
        <span>&nbsp;</span>
        <span>This is your page. Click</span>
        <span>anything to make it yours.</span>
        <span>&nbsp;</span>
        <span>
            <span className="builder-code-k">**Bold**</span>, lists, [links].
        </span>
    </>
);
const HTML_SNIPPET = (
    <>
        <span>
            <span className="builder-code-k">&lt;h1&gt;</span>Hello, world
            <span className="builder-code-k">&lt;/h1&gt;</span>
        </span>
        <span>
            <span className="builder-code-k">&lt;button&gt;</span>Click me
            <span className="builder-code-k">&lt;/button&gt;</span>
        </span>
        <span>&nbsp;</span>
        <span>{"h1 { color: "}<span className="builder-code-k">#e6007a</span>{"; }"}</span>
        <span>{'button.addEventListener("click", …)'}</span>
    </>
);

// Coarse relative time for draft cards — drafts are touched on the scale of
// minutes-to-days, so anything finer is noise.
function timeAgo(ts: number): string {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

// One starting-point card. div + stretched button, not a plain <button>: an
// iframe is interactive content and can't nest inside a button. The thumbnail
// iframe is fully sandboxed (no scripts) — pixels only.
interface Thumb {
    html: string;
    /** Site accent for the no-iframe fallback strip (Polkadot Mobile's
     *  webview forbids iframe creation — see iframes.ts). */
    accent: string;
}

function StartCard({
    thumb,
    htmlKey,
    snippet,
    name,
    desc,
    onClick,
    onDelete,
    disabled,
    modifier,
    testid,
}: {
    /** Rendered document + theme for the thumbnail; omit for text-only cards. */
    thumb?: Thumb;
    /** Remounts the thumbnail iframe when it changes. Browsers differ on
     *  whether updating srcdoc re-navigates an EXISTING iframe — a fresh
     *  element always loads. Key draft cards on their updatedAt. */
    htmlKey?: string;
    /** Source-flavored thumbnail (code lines) for the write-it-yourself
     *  cards — same frame as the live thumbs, but showing what you WRITE
     *  rather than what renders. */
    snippet?: ReactNode;
    name: string;
    desc: string;
    onClick: () => void;
    /** Renders a small × control above the stretched button (draft cards). */
    onDelete?: () => void;
    disabled?: boolean;
    modifier?: string;
    testid?: string;
}) {
    const noIframe = !iframesAllowed();
    return (
        <div
            className={[
                "builder-card",
                thumb || snippet ? "builder-card-thumbed" : "",
                thumb && noIframe ? "builder-card-spined" : "",
                disabled ? "is-disabled" : "",
                modifier ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {thumb &&
                (noIframe ? (
                    // No-iframe hosts (Polkadot Mobile) can't render a live
                    // preview; a left accent spine hints at the site theme
                    // without a stray top strip or wasted vertical height.
                    <div
                        className="builder-card-spine"
                        aria-hidden="true"
                        style={{ background: thumb.accent }}
                    />
                ) : (
                    <div className="builder-thumb" aria-hidden="true">
                        <iframe
                            key={htmlKey}
                            srcDoc={thumb.html}
                            sandbox=""
                            tabIndex={-1}
                            loading="lazy"
                            title={`${name} preview`}
                        />
                    </div>
                ))}
            {snippet && (
                <div className="builder-thumb builder-thumb-code" aria-hidden="true">
                    {snippet}
                </div>
            )}
            <button
                type="button"
                className="builder-card-button"
                onClick={onClick}
                disabled={disabled}
                data-testid={testid}
            >
                <span className="builder-card-name">{name}</span>
                <span className="builder-card-desc">{desc}</span>
            </button>
            {onDelete && (
                <button
                    type="button"
                    className="builder-card-delete"
                    onClick={onDelete}
                    aria-label={`Delete draft "${name}"`}
                    title="Delete draft"
                >
                    ×
                </button>
            )}
        </div>
    );
}

export default function Landing({
    drafts,
    onPick,
    onDelete,
    undoable,
    onUndo,
}: {
    drafts: DraftRecord[];
    onPick: (entry: BuilderEntry) => void;
    onDelete: (record: DraftRecord, index: number) => void;
    /** A just-deleted draft: its grid slot renders the in-place Undo card. */
    undoable: { record: DraftRecord; index: number } | null;
    onUndo: () => void;
}) {
    // Read once per landing mount (the landing remounts on every return
    // from the editor, so a fresh deploy shows up immediately).
    const deployedSites = useMemo(loadDeployedSites, []);

    // Draft thumbnails render through the same pipeline the editor's
    // preview/deploy use — the card always shows exactly what's saved.
    const draftPreviews = useMemo(
        () =>
            drafts.map((r) => ({
                html: draftHtml(r.draft),
                accent: r.draft.content.accentColor,
            })),
        [drafts],
    );
    // Template thumbnails: build() mints fresh block ids per call, but these
    // instances are preview-only — picking a card calls build() anew.
    const templatePreviews = useMemo(
        () =>
            TEMPLATES.map((t) => {
                const content = t.build();
                return {
                    html: renderHtml(content),
                    accent: content.accentColor,
                };
            }),
        [],
    );
    const atCap = drafts.length >= MAX_DRAFTS;
    // Same onboarding gate as the Apps banner: prompt the connected user to
    // become a builder until they are one; hidden once revealed.
    const { account, hasIdentity, startBecomeBuilder } = useOnboarding();
    const showBecomeBuilder = !!account && !hasIdentity;
    // Intervene early: starting a fresh build (template / blank) while not yet a
    // builder opens the Become-a-builder flow instead of the editor, rather than
    // waiting to block at deploy. Resuming an existing draft is left alone —
    // deploy still gates it.
    const needsBuilder = !!account && !hasIdentity;
    const startBuild = (entry: BuilderEntry) => {
        if (needsBuilder) {
            startBecomeBuilder();
            return;
        }
        onPick(entry);
    };
    return (
        <div className="tab builder-tab">
            {showBecomeBuilder && <BecomeBuilderCard />}
            <header className="tab-header">
                <h1 className="tab-title">Site builder</h1>
                <p className="tab-lead">
                    Build and launch your own decentralised website, right here
                    in the playground. Start from a template, or jump straight
                    into Markdown or HTML.
                </p>
            </header>
            {(drafts.length > 0 || undoable) && (
                <section className="builder-section">
                    <h2 className="builder-section-title">Continue building</h2>
                    <div className="builder-grid">
                        {(() => {
                            const cards = drafts.map((r, i) => (
                                <StartCard
                                    key={r.id}
                                    thumb={draftPreviews[i]}
                                    htmlKey={`${r.id}:${r.updatedAt}`}
                                    name={draftTitle(r.draft)}
                                    desc={
                                        MODE_NAMES[r.draft.mode] +
                                        (r.updatedAt > 0 ? ` · ${timeAgo(r.updatedAt)}` : "")
                                    }
                                    onClick={() =>
                                        onPick({ kind: "resume", id: r.id, draft: r.draft })
                                    }
                                    onDelete={() => onDelete(r, i)}
                                    modifier="builder-card-resume"
                                    testid="builder-resume"
                                />
                            ));
                            if (undoable) {
                                // The deleted card's own slot becomes the undo
                                // affordance — the user's eyes are already there.
                                cards.splice(
                                    Math.min(undoable.index, cards.length),
                                    0,
                                    <div
                                        key="undo-slot"
                                        className="builder-card builder-card-undo"
                                        role="status"
                                    >
                                        <span className="builder-card-undo-title">
                                            "{draftTitle(undoable.record.draft)}" deleted
                                        </span>
                                        <button type="button" onClick={onUndo}>
                                            Undo
                                        </button>
                                    </div>,
                                );
                            }
                            return cards;
                        })()}
                    </div>
                    {atCap && (
                        <p className="builder-note">
                            Draft limit reached ({MAX_DRAFTS}). Delete a draft
                            to start a new one.
                        </p>
                    )}
                </section>
            )}
            <section className="builder-section">
                <h2 className="builder-section-title">Start from a layout</h2>
                <div className="builder-grid">
                    {TEMPLATES.map((t, i) => (
                        <StartCard
                            key={t.id}
                            thumb={templatePreviews[i]}
                            name={t.name}
                            desc={t.description}
                            disabled={atCap}
                            onClick={() =>
                                startBuild({ kind: "template", id: newDraftId(), template: t })
                            }
                        />
                    ))}
                </div>
            </section>
            <section className="builder-section">
                <h2 className="builder-section-title">Or build it yourself</h2>
                <div className="builder-grid">
                    <StartCard
                        snippet={MD_SNIPPET}
                        name="Markdown"
                        desc="Plain-text editing with the same site design."
                        disabled={atCap}
                        onClick={() =>
                            startBuild({ kind: "blank", id: newDraftId(), mode: "markdown" })
                        }
                    />
                    <StartCard
                        snippet={HTML_SNIPPET}
                        name="HTML"
                        desc="CodePen-style HTML, CSS & JS panes."
                        disabled={atCap}
                        onClick={() =>
                            startBuild({ kind: "blank", id: newDraftId(), mode: "html" })
                        }
                    />
                </div>
            </section>
            {deployedSites.length > 0 && (
                <section className="builder-section" aria-label="Your deployed sites">
                    <h2 className="builder-section-title">Your sites</h2>
                    <div className="builder-sites-cloud">
                        {deployedSites.map((site) => (
                            <PopupLink
                                key={site.domain}
                                className="builder-site-chip"
                                href={site.url}
                            >
                                {site.domain}.dot
                            </PopupLink>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
