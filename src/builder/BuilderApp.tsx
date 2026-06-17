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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Code, Dices, Eye, Palette, Pencil, Redo2, Rocket, Sparkles, Undo2, X } from "lucide-react";
import { Editable } from "./Editable.tsx";
import { pickRandomTheme, type ThemeCombo } from "./themes.ts";
import { lazyRetry } from "../utils/lazyRetry.ts";
import { LoadingFallback } from "../LoadingFallback.tsx";

// Lazy: CodeMirror is its own chunk, fetched only when md/html mode is opened.
// lazyRetry re-attempts on a transient host-transport fetch failure so opening
// the editor doesn't fall to the error boundary on a single blip.
const CodeEditor = lazyRetry(() => import("./CodeEditor.tsx"));
import type { EditorHandle } from "./CodeEditor.tsx";
import {
    assembleDocument,
    DEFAULT_CONTENT,
    DEFAULT_FONT_SIZE,
    escapeHtml,
    FONT_OPTIONS,
    renderHtml,
    renderHtmlParts,
    imageShape,
    descriptionFromHtml,
    firstImageCidFromHtml,
    imageSize,
    isPlaceholderImageUrl,
    siteColors,
    validateUrl,
    type Block,
    type ImageShape,
    type ImageVariant,
    type SiteContent,
    type TextAlign,
} from "./template.ts";
// Chain-stack modules (deploy/preflight/store) are imported statically:
// a dynamic import() here means fetching a chunk through the Bulletin
// gateway mid-flow — right after the user signs — and one flaky gateway
// response kills the deploy. Their heavy deps (polkadot-api, viem,
// descriptors) sit in shared chunks the app core loads anyway, so the
// only real cost is ~16 KB joining the builder chunk.
import { deployFull, type DeploySuccess } from "./deploy.ts";
import { publishSiteToRegistry, type RegistryListing } from "./registry.ts";
import { runPreflight, validateLabel, type PreflightReport } from "./preflight.ts";
import { resetAssetHubClient } from "./chain.ts";
import { deployButtonState } from "./deployButton.ts";
import { checkBusyClearDelay } from "./checkVisibility.ts";
import { stepForDeployStatus, stepForUploadStatus } from "./deployStatus.ts";
import { checkBulletinAuthorization, resetBuilderBulletinClient, storeBytes } from "./store.ts";
import { deriveDomain } from "./derive-domain.ts";
import { easedStepProgress, PROGRESS_TAU_MS } from "./progress.ts";
import { VISIBILITY_PRIVATE, VISIBILITY_PUBLIC } from "../registryTypes.ts";
import {
    type ActiveAccount,
    connectHostAccount,
    ensureAccountReady,
    getDevAccount,
    useHostAccount,
} from "./account.ts";
import { LISTING_DESC_MAX, LISTING_NAME_MAX, MAX_TX_BYTES } from "./limits.ts";
import { useOnboarding } from "../OnboardingProvider.tsx";
import { CheckIcon, CopyIcon } from "../icons.tsx";
import {
    encodeIpfsContenthash,
    readContentHashFinalized,
} from "./dotns/content-hash.ts";
import { recordDeployedSite } from "./deployed.ts";
import { iframesAllowed } from "./iframes.ts";
import { copyText } from "./clipboard.ts";
import { hostLinkForm, PopupLink } from "./LinkPopup.tsx";
import { BULLETIN_FAUCET_URL } from "./config.ts";
import { PLAYGROUND_DOTNS_ID, VERSION } from "../config.ts";
import { MAX_IMAGE_DIMENSION, resizeImageToFit } from "./image-resize.ts";
import {
    initialStateForEntry,
    loadDrafts,
    makeBlockId,
    newDraftId,
    saveDraft,
    MAX_DRAFTS,
    type BuilderEntry,
    type Draft,
    type EditorMode,
} from "./draft.ts";
import { renderMarkdownHtml } from "./markdown.ts";

type View = "edit" | "preview" | "deploy";
// One open menu at a time — a single state slot makes overlap impossible.
type ActionMenu = "colors" | "font" | "add";
// HTML mode is CodePen-style: three panes assembled into one document.
type HtmlPane = "html" | "css" | "js";
const PANE_GLYPHS: Record<HtmlPane, string> = { html: "<>", css: "{}", js: "JS" };

// Decode HTML entities (&#39; &amp; …) to plain text. The blocks renderer
// entity-encodes heading text, so anything extracted from rendered markup
// must be decoded before non-HTML use — "sveta&#39;s" fed to deriveDomain
// turned into "sveta-39-s". textarea innerHTML never executes content.
function decodeEntities(s: string): string {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
}

// Title for assembled pane documents and the auto-name seed: the first
// <h1>–<h3>'s text in document order, falling back to the same default the
// blocks renderer uses. Returns DECODED plain text — escape it again before
// embedding in markup (assembleDocument's title contract).
function titleFromHtml(body: string): string {
    const m = body.match(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/i);
    const text = m ? decodeEntities(m[2].replace(/<[^>]*>/g, "")).trim() : "";
    return text || "hello";
}
// Builder-side extension: the registry listing is layered on top of the
// DotNS/Bulletin deploy in BuilderApp (deploy.ts stays chain-publish-free).
// `registryListed` tracks the public Apps-grid listing, not the auto-private
// My Apps entry. `registryListed: false` with a `registryError` marks a
// non-fatal public-listing miss — the site is live, it just didn't make the
// public Apps grid.
type DeployResult = DeploySuccess & {
    registryListed?: boolean;
    registryError?: string | null;
    /** Whether launch XP actually landed (first three deploys only; 4th+ = 0). */
    xpAwarded?: boolean;
};

interface ProgressStep {
    readonly id: string;
    readonly label: string;
}

const DEPLOY_STEPS: readonly ProgressStep[] = [
    { id: "prepare", label: "Prepare" },
    { id: "bulletin", label: "Store" },
    { id: "account", label: "Account" },
    { id: "name", label: "Name" },
    { id: "commit", label: "Reserve" },
    { id: "wait", label: "Wait" },
    { id: "register", label: "Register" },
    { id: "link", label: "Link" },
];

const UPLOAD_STEPS: readonly ProgressStep[] = [
    { id: "prepare", label: "Prepare" },
    { id: "sign", label: "Sign" },
    { id: "broadcast", label: "Broadcast" },
    { id: "in-block", label: "In Block" },
    { id: "finalized", label: "Finalized" },
];

// Steps whose transaction the user must approve on their phone (host accounts
// prompt per signed tx). When one is the active step, StepProgress surfaces a
// "check your phone" hint so the user doesn't read the pause as a stall and
// reach for the back button mid-deploy.
//
// Commit / Register / Link are the DotNS + contenthash txs — a guaranteed
// prompt on every deploy. Commit also covers the one-time `map_account`: it
// runs inside the commit phase and reports under the "DotNS register:" status,
// so it lands on this step rather than its own.
//
// Prepare (the host allowance grant via `ensureAccountReady`) and Store (the
// Bulletin upload's PreimageSubmit grant) each prompt at most ONCE per session
// and are silent after. We can't tell from the client whether the prompt will
// actually fire — `requestPermission` / `ensureSignerReady` return success
// whether they prompted or returned a cached grant — so we hint on them
// unconditionally: a brief, harmless over-show on later deploys beats
// stranding a first-session user who really does need to approve on their
// phone and sees only a stalled-looking step.
//
// Deliberately NOT included: "account" and "name" are read-only owner-H160 /
// availability dry-runs (getEvmAddress / checkDomainAvailability) — no
// signature, no prompt. ("account" was previously listed here by mistake.)
const DEPLOY_PHONE_STEPS: ReadonlySet<string> = new Set([
    "prepare",
    "bulletin",
    "commit",
    "register",
    "link",
]);
const UPLOAD_PHONE_STEPS: ReadonlySet<string> = new Set(["sign"]);


// Upload retry floor: halve the byte budget per size-shaped rejection, give
// up below this (a sub-32 KB image failing means something else is wrong).
const MIN_SIGN_BUDGET = 32 * 1024;

// Add-menu entries. Link and Button are presented as two separate components
// (a Button is a pill-styled link under the hood — no toggle between them).
const BLOCK_PRESETS = {
    heading: () => ({ id: makeBlockId(), type: "heading", text: "Heading" }),
    paragraph: () => ({ id: makeBlockId(), type: "paragraph", text: "Write something here…" }),
    link: () => ({ id: makeBlockId(), type: "link", label: "Link text", url: "https://" }),
    button: () => ({
        id: makeBlockId(),
        type: "link",
        variant: "pill",
        label: "Button text",
        url: "https://",
    }),
    image: () => ({ id: makeBlockId(), type: "image", url: "https://", alt: "" }),
    divider: () => ({ id: makeBlockId(), type: "divider" }),
} satisfies Record<string, () => Block>;
type BlockPreset = keyof typeof BLOCK_PRESETS;

export default function App({
    entry,
    onExit,
    onSwitchEntry,
}: {
    /** Starting point picked on the /builder landing page. The component is
     *  keyed on entry.id by the route, so it remounts per entry and reading
     *  the entry once via lazy state init is sound. */
    entry: BuilderEntry;
    onExit: () => void;
    /** Swap the session to another entry (the Simple → HTML fork). */
    onSwitchEntry: (next: BuilderEntry) => void;
}) {
    const [init] = useState(() => initialStateForEntry(entry));
    const [content, setContent] = useState<SiteContent>(init.content);
    const [mode, setMode] = useState<EditorMode>(init.mode);
    const [markdownText, setMarkdownText] = useState(init.markdownText);
    // HTML mode panes: body markup, stylesheet, script — CodePen-style.
    const [htmlText, setHtmlText] = useState(init.htmlText);
    const [cssText, setCssText] = useState(init.cssText);
    const [jsText, setJsText] = useState(init.jsText);
    const [htmlPane, setHtmlPane] = useState<HtmlPane>("html");
    const [view, setView] = useState<View>("edit");
    const [domain, setDomain] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [deployStep, setDeployStep] = useState<number | null>(null);
    const [result, setResult] = useState<DeployResult | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);
    // Opt-in registry listing (post-deploy, host accounts only). `listing` is
    // the in-flight flag; `listStatus` mirrors the publish sub-steps under the
    // button. The XP confetti is fired app-wide by the registry-event listener
    // (see src/App.tsx + src/xpCelebration.ts) when the DeployPointAwarded event
    // lands, so the builder no longer triggers it locally.
    const [listing, setListing] = useState(false);
    const [listStatus, setListStatus] = useState<string | null>(null);
    // "List in Apps" metadata panel: opening it prefills name/description from
    // the deployed site and defaults the tag to "social"; the user confirms or
    // edits, then publishes. Icon/cover are auto-derived (not shown).
    const [listModalOpen, setListModalOpen] = useState(false);
    const [listName, setListName] = useState("");
    const [listDescription, setListDescription] = useState("");
    // Raw technical text (revert hex / dispatch JSON) shown ONLY inside the
    // logs modal — never inline. Null = modal closed.
    const [logsText, setLogsText] = useState<string | null>(null);
    // "Choosing a .dot name" rules modal.
    const [nameRulesOpen, setNameRulesOpen] = useState(false);
    // Subtle "Details" toggle on the checklist — swaps the friendly per-row
    // text for the technical numbers (bytes, balance, tiers).
    const [showCheckDetails, setShowCheckDetails] = useState(false);
    const [openMenu, setOpenMenu] = useState<ActionMenu | null>(null);
    // Which structured block (link/button/image) has its bottom sheet open.
    const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
    const toggleMenu = (menu: ActionMenu) =>
        setOpenMenu((prev) => (prev === menu ? null : menu));

    // Signer state — playground's logged-in product account by default
    // (signerManager auto-connects on app load), with the wallet-less dev
    // account behind an explicit toggle as the no-account fallback.
    const [useDevAccount, setUseDevAccount] = useState(false);
    const [ownedError, setOwnedError] = useState<string | null>(null);
    /** Advisory remaining byte allowance — null when unknown. */
    const [maxStoreBytes, setMaxStoreBytes] = useState<number | null>(null);
    /** Distinct from the budget: false = CHECKED and unauthorized. For dev
     *  accounts that's a hard stop (faucet); for the host account the
     *  allowance is provisioned by ensureAccountReady at deploy time. */
    const [bulletinAuthorized, setBulletinAuthorized] = useState<boolean | null>(null);

    const devAccount = useMemo(() => getDevAccount(), []);
    const { account: hostAccount, connecting: resolvingOwned } = useHostAccount();
    const activeAccount: ActiveAccount | null = useDevAccount ? devAccount : hostAccount;
    // Routes an under-funded host deploy to the in-app "Collect resources" flow.
    const { startBecomeBuilder } = useOnboarding();
    const handleHostSignIn = async () => {
        setOwnedError(null);
        try {
            // Surfaces the host connect dialog; useHostAccount picks up the
            // resulting account reactively via signerManager's subscription.
            await connectHostAccount();
        } catch (cause) {
            setOwnedError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    useEffect(() => {
        const address = activeAccount?.address;
        const source = activeAccount?.source;
        if (!address) {
            setMaxStoreBytes(null);
            setBulletinAuthorized(null);
            return;
        }
        let cancelled = false;
        checkBulletinAuthorization(address)
            .then((auth) => {
                if (cancelled) return;
                // Host accounts get their allowance provisioned on demand at
                // deploy time, so "unauthorized" is only a hard signal for dev.
                setBulletinAuthorized(source === "dev" ? auth.authorized : null);
                setMaxStoreBytes(
                    auth.authorized && auth.remainingBytes > 0n
                        ? Number(auth.remainingBytes)
                        : null,
                );
            })
            .catch(() => {
                if (!cancelled) {
                    setMaxStoreBytes(null);
                    setBulletinAuthorized(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [activeAccount?.address, activeAccount?.source]);

    // Foreground recovery: backgrounding the WebView (the Android photo-picker
    // or a faucet round-trip) can wedge the builder's chain + Bulletin sockets —
    // the OS suspends them without firing a close event, so queries neither
    // resolve nor reject and the transport never auto-reconnects. Dropping the
    // memoized clients when the tab returns to the foreground makes the NEXT
    // query dial a fresh socket. The rebuild is lazy (these only null a cache),
    // so a brief tab-flip over a healthy socket costs nothing until something
    // actually queries. `visibilitychange → visible` (not `focus`) is the
    // precise background→foreground signal, so a healthy socket isn't discarded
    // on a mere window refocus. This automates the reset the manual re-check
    // already does (see runCheck) so a deploy resumed after a phone approval
    // doesn't hang on a dead socket.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            resetAssetHubClient();
            resetBuilderBulletinClient();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);

    // ── Deploy pre-flight ────────────────────────────────────────────────
    // The auto-derived label has random padding, so it's generated ONCE per
    // session and shown in the field — the name the checklist verifies is
    // byte-for-byte the name deployFull registers.
    const [autoLabel, setAutoLabel] = useState<string | null>(null);
    const [preflight, setPreflight] = useState<PreflightReport | null>(null);
    const [preflightBusy, setPreflightBusy] = useState(false);
    // Distinguishes "checks errored" from "checks not applicable" (signed
    // out / no label) — the section must not silently vanish in the former.
    const [preflightFailed, setPreflightFailed] = useState(false);
    // Open state for the "You need more resources" explainer modal, shown when
    // the user taps "Get more resources" on a funds shortfall.
    const [resourcesModalOpen, setResourcesModalOpen] = useState(false);
    // The label the last completed check ran for. Used to detect staleness:
    // when the user edits the name after a pass, checkFresh becomes false and
    // the button reverts to "Check name".
    const [checkedLabel, setCheckedLabel] = useState<string | null>(null);
    const [copiedAddress, setCopiedAddress] = useState(false);
    const effectiveLabel = domain.trim().replace(/\.dot$/i, "") || autoLabel || "";

    // The single HTML source of truth — preview and deploy both consume this,
    // so they stay mode-agnostic. Declared before its first synchronous
    // consumer (the sizeBytes memo below) — a const arrow is in the temporal
    // dead zone until this line runs, so any render-time caller above it would
    // throw "Cannot access 'currentHtml' before initialization" on mount.
    // `interactive` is false only for the live preview iframe, so the baked
    // playground.dot credit doesn't navigate while you're still in the builder
    // (matching the inert blocks-mode footer). Deploy/size/listing all use the
    // default (true) — the real, host-aware badge ships in the artifact.
    const currentHtml = (interactive = true): string => {
        switch (mode) {
            case "blocks":
                return renderHtml(content);
            case "markdown":
                return renderMarkdownHtml(markdownText, content, interactive);
            case "html":
                return assembleDocument({
                    title: escapeHtml(titleFromHtml(htmlText)),
                    css: cssText,
                    bodyHtml: htmlText,
                    js: jsText,
                });
        }
    };

    // Intentionally narrow deps: derive once, on the first visit to the
    // deploy view, from whatever the content is at that moment. Seed from
    // the page's <h1> text (uniform across all three modes) — NOT the raw
    // document, whose first bytes are doctype boilerplate.
    useEffect(() => {
        if (view === "deploy" && !autoLabel) {
            const derived = deriveDomain(titleFromHtml(currentHtml()));
            setAutoLabel(derived);
            // Pre-populate the editable name field with the derived label so
            // the user sees one input with real, editable text (not a greyed
            // placeholder + a separate preview line). Clearing it falls back to
            // autoLabel via effectiveLabel, so deploy still works when blank.
            setDomain((d) => d || derived);
        }
    }, [view, autoLabel]); // eslint-disable-line react-hooks/exhaustive-deps

    // Derive checkFresh: true only when the last completed check ran for the
    // current name. Editing the name after a pass invalidates this.
    const checkFresh = checkedLabel !== null && checkedLabel === effectiveLabel;

    // Local, network-free pre-checks. These are deterministic and free, so
    // they run on every render (no RPC) and hard-block Deploy — a flaky
    // network can never affect them, and they catch the two guaranteed-failure
    // cases (oversized tx / malformed name) instantly without a round-trip.
    // The size byte count is memoized on the content-bearing state so we don't
    // re-encode the document on unrelated re-renders.
    const sizeBytes = useMemo(
        () => new TextEncoder().encode(currentHtml()).length,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [mode, content, markdownText, htmlText, cssText, jsText],
    );
    const sizeError = sizeBytes > MAX_TX_BYTES;
    // Only validate a non-empty name; an empty name is handled by hasName.
    const nameFormatError = effectiveLabel ? validateLabel(effectiveLabel) : null;
    const localOk = !sizeError && nameFormatError === null;

    // Explicit user-initiated name check. Replaces the old debounced auto-run
    // effect. The user clicks "Check name" (or "Check again") to run once.
    // The explicit click is also the recovery mechanism — no background focus/
    // visibility listeners needed. If the previous attempt errored, reset the
    // wedged socket first before reconnecting.
    //
    // NOT memoized: runCheck is only ever a JSX click handler (never an effect
    // /memo dependency), so a stable identity buys nothing — and a useCallback
    // would pin a stale `currentHtml` closure. currentHtml depends on content,
    // which changes in the edit view without touching activeAccount/
    // effectiveLabel; a memoized runCheck would then check OUTDATED content
    // (e.g. miss an oversized image added after the last name change). A plain
    // function re-closes over the current content on every render.
    const runCheck = () => {
        if (!activeAccount || !effectiveLabel) return;
        // Capture the label at the time the user clicked — record this same
        // value on both success and failure paths to keep staleness detection
        // consistent even if the user edits the name mid-check.
        const label = effectiveLabel;
        // A RE-check almost always follows the user leaving the app and coming
        // back — most often to a faucet, after a "fail" verdict told them to top
        // up funds or storage. Leaving (especially backgrounding the WebView)
        // can silently wedge the chain sockets, leaving every query pending
        // forever (see resetAssetHubClient / resetBuilderBulletinClient). The
        // old guard reset ONLY after a thrown check (`preflightFailed`), but an
        // insufficient-balance / no-storage result is a clean "fail" VERDICT,
        // not a throw — so the one path that reliably sends the user away was
        // the one path that reused the stale sockets. The recheck then degraded
        // every chain read to a 5s "couldn't verify" warn (which don't block),
        // auto-proceeded into a deploy, and that deploy hung on the dead socket
        // until each step's 45-90s deadline — the reported "recheck gets stuck".
        // Reconnect before ANY re-run so the recheck always hits a live socket.
        if (preflightFailed || preflight !== null) {
            resetAssetHubClient();
            resetBuilderBulletinClient();
        }
        setPreflightBusy(true);
        setPreflightFailed(false);
        setResult(null); // stale deploy result is no longer relevant
        const startedAt = Date.now();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        Promise.race([
            runPreflight({
                html: currentHtml(),
                label,
                account: activeAccount,
            }),
            new Promise<never>((_, reject) => {
                // Outer deadline: the checks run in parallel, each capped at a
                // 5s internal guard, but this overall bound prevents an
                // indefinite spin if the page was frozen mid-check. Comfortably
                // above the ~5s parallel worst case so a healthy run still lands
                // a real report. This deadline is now the sole recovery net (the
                // focus/visibility handler is gone), so it must always fire.
                deadline = setTimeout(
                    () => reject(new Error("Pre-flight timed out")),
                    15_000,
                );
            }),
        ])
            .then((report) => {
                setPreflight(report);
                setCheckedLabel(label);
                // Happy path: a clean check auto-proceeds into deploy, so one
                // tap of "Check & deploy" does the whole thing.
                if (report.ok) {
                    void deploy();
                }
                // Otherwise the report stays on screen with "Check again". A
                // funds shortfall is NOT auto-collected: doing so used to spin a
                // detect → top-up → re-check loop that re-fired a host signature
                // prompt every iteration (the top-up can't actually deliver PGAS
                // — that's the mobile claim path — so the re-check kept failing).
                // Collection is now strictly user-initiated via the in-popup
                // "Get more resources" button (see the deploy panel below).
            })
            .catch(() => {
                setPreflight(null);
                setPreflightFailed(true);
                setCheckedLabel(label);
            })
            .finally(() => {
                clearTimeout(deadline);
                // Keep "Checking…" up for a minimum perceptible window, then
                // clear via a macrotask (setTimeout) so the browser paints the
                // busy state first even when the check resolved within the
                // click's own microtask flush. See checkBusyClearDelay.
                const delay = checkBusyClearDelay(Date.now() - startedAt);
                setTimeout(() => setPreflightBusy(false), delay);
            });
    };

    // Debounced draft autosave — gated on the user actually CHANGING
    // something. Entering a starting point and backing straight out must not
    // mint a draft (it would count toward MAX_DRAFTS), and resuming without
    // edits must not bump updatedAt and reshuffle the landing list. Sticky:
    // once dirty, every subsequent state lands in storage. Dirtiness is a
    // reference-compare against the entry's initial state — any real edit
    // replaces these objects/strings.
    const draft: Draft = { mode, content, markdownText, htmlText, cssText, jsText };
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const dirtyRef = useRef(false);
    useEffect(() => {
        if (!dirtyRef.current) {
            const d = draftRef.current;
            const pristine =
                d.mode === init.mode &&
                d.content === init.content &&
                d.markdownText === init.markdownText &&
                d.htmlText === init.htmlText &&
                d.cssText === init.cssText &&
                d.jsText === init.jsText;
            if (pristine) return;
            dirtyRef.current = true;
        }
        const t = setTimeout(() => saveDraft(entry.id, draft), 500);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, content, markdownText, htmlText, cssText, jsText]);
    // Flush synchronously when the page is leaving/backgrounding, so an edit
    // made within the debounce window survives a reload or mobile app-switch.
    useEffect(() => {
        const flush = () => {
            if (dirtyRef.current) saveDraft(entry.id, draftRef.current);
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("pagehide", flush);
            document.removeEventListener("visibilitychange", onVisibility);
            // SPA navigation (rail click on desktop) unmounts without firing
            // pagehide — flush here too, so the debounce window can't eat the
            // last edit. Redundant after the Back tab's flush, but idempotent.
            flush();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Blocks-mode undo: a snapshot stack over SiteContent. Snapshots are taken
    // OUTSIDE setState updaters (StrictMode double-invokes those) and rapid
    // keystrokes coalesce into one entry per ~800ms burst.
    const contentRef = useRef(content);
    contentRef.current = content;
    const undoStack = useRef<SiteContent[]>([]);
    const redoStack = useRef<SiteContent[]>([]);
    const lastEditAt = useRef(0);
    const snapshotContent = (force = false) => {
        const now = Date.now();
        if (force || now - lastEditAt.current > 800) {
            undoStack.current.push(contentRef.current);
            if (undoStack.current.length > 100) undoStack.current.shift();
        }
        lastEditAt.current = now;
        redoStack.current = [];
    };
    const undoBlocks = () => {
        const prev = undoStack.current.pop();
        if (!prev) return;
        redoStack.current.push(contentRef.current);
        lastEditAt.current = 0; // next edit starts a fresh undo group
        setContent(prev);
    };
    const redoBlocks = () => {
        const next = redoStack.current.pop();
        if (!next) return;
        undoStack.current.push(contentRef.current);
        lastEditAt.current = 0;
        setContent(next);
    };

    // Undo/redo for the CodeMirror editor (markdown/html modes), surfaced by
    // the lazy component once its view mounts.
    const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null);

    const update = <K extends keyof SiteContent>(key: K, value: SiteContent[K]) => {
        snapshotContent();
        setContent((prev) => ({ ...prev, [key]: value }));
    };
    const updateBlock = (id: string, patcher: (b: Block) => Block) => {
        snapshotContent();
        setContent((prev) => ({
            ...prev,
            blocks: prev.blocks.map((b) => (b.id === id ? patcher(b) : b)),
        }));
    };
    const removeBlock = (id: string) => {
        snapshotContent(true);
        setContent((prev) => ({ ...prev, blocks: prev.blocks.filter((b) => b.id !== id) }));
    };
    const addBlock = (type: BlockPreset) => {
        snapshotContent(true);
        setContent((prev) => ({ ...prev, blocks: [...prev.blocks, BLOCK_PRESETS[type]()] }));
        setOpenMenu(null);
    };

    // The one remaining mode transition: Simple → HTML, as a FORK. The
    // current Simple draft is saved as-is and a NEW draft holding the HTML
    // conversion becomes the session — nothing is destroyed (so no confirm):
    // "going back" is resuming the Simple draft from the landing. Markdown
    // and HTML sessions keep their mode; modes are chosen on the landing.
    //
    // The fork mints a draft, so it respects MAX_DRAFTS: blocked-at-mount
    // disables the button (tooltip explains); the click-time re-check also
    // counts this session's own not-yet-saved draft.
    const [editorNotice, setEditorNotice] = useState<string | null>(null);
    useEffect(() => {
        if (!editorNotice) return;
        const t = setTimeout(() => setEditorNotice(null), 4000);
        return () => clearTimeout(t);
    }, [editorNotice]);
    const [forkBlocked, setForkBlocked] = useState(
        () => loadDrafts().length >= MAX_DRAFTS,
    );
    // First-open hint that the page ITSELF is the editor: focus the first
    // text block so a caret is blinking the moment the blocks view appears.
    // Mount-only — view switches within the session shouldn't steal focus.
    useEffect(() => {
        if (mode !== "blocks") return;
        const el = document.querySelector<HTMLElement>(
            ".builder-root .site .editable",
        );
        if (!el) return;
        el.focus();
        // Caret at the END — typing extends the text instead of prepending.
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Save-if-edited, then leave to the Site Builder landing. Shared by the
    // floating Back circle, the code header's back control, and the success
    // panel's "Build another site".
    const exitToLanding = () => {
        if (dirtyRef.current) saveDraft(entry.id, draftRef.current);
        onExit();
    };

    // Apply a curated theme combo (Shuffle): one forced snapshot, one merge,
    // so each application is its own undo step and never touches the blocks.
    // Forced (like add/remove block) because applying a theme is a discrete
    // action — it shouldn't coalesce into a preceding text edit's undo group,
    // and each tap should be individually undoable. textColor is set from the
    // combo or cleared back to auto when the combo doesn't specify one.
    const applyTheme = (combo: ThemeCombo) => {
        snapshotContent(true);
        setContent((prev) => ({
            ...prev,
            accentColor: combo.accentColor,
            background: combo.background,
            fontFamily: combo.fontFamily,
            textColor: combo.textColor,
        }));
    };

    const forkToHtml = () => {
        const records = loadDrafts();
        const sessionUnsaved =
            dirtyRef.current && !records.some((r) => r.id === entry.id) ? 1 : 0;
        if (records.length + sessionUnsaved + 1 > MAX_DRAFTS) {
            setForkBlocked(true);
            // window.alert is a silent no-op on the mobile hosts (unwired
            // JS dialogs) — use the in-DOM toast instead.
            setEditorNotice(
                `Draft limit reached (${MAX_DRAFTS}). Delete a draft on the start page to make an HTML copy.`,
            );
            return;
        }
        if (dirtyRef.current) saveDraft(entry.id, draftRef.current);
        const parts = renderHtmlParts(content);
        const htmlDraft: Draft = {
            mode: "html",
            content,
            markdownText: "",
            htmlText: parts.bodyHtml,
            cssText: parts.css,
            jsText: "",
        };
        // Deliberately NOT saved here: the conversion is the new session's
        // INITIAL state, so the standard dirty-gated autosave applies — a
        // fork the user only looks at leaves no draft behind.
        onSwitchEntry({ kind: "resume", id: newDraftId(), draft: htmlDraft });
    };

    const uploadImage = async (
        file: File,
        onStatus: (msg: string) => void,
    ): Promise<string> => {
        if (!activeAccount) {
            throw new Error(
                "Sign in first. Tick the dev account in the Deploy panel, or connect a wallet.",
            );
        }
        // Checked-and-unauthorized fails fast with the faucet link, BEFORE
        // the user sits through image optimization for a store that must
        // fail. (Only set for dev accounts; host accounts authorize the
        // Bulletin store on demand via storeBytes → ensurePreimagePermission.)
        if (bulletinAuthorized === false) {
            throw new Error(
                `No Bulletin storage authorization for ${activeAccount.displayName}.\n\n` +
                    `Self-serve faucet:\n${BULLETIN_FAUCET_URL}`,
            );
        }
        // Deliberately NO ensureAccountReady() here. That provisions the
        // SmartContractAllowance and — since 642e334 — runs an on-chain PGAS
        // query as its gate. An image upload needs neither: it stores to
        // Bulletin via storeBytes, which requests its own PreimageSubmit
        // permission (host) or signs TransactionStorage.store directly (dev).
        // Running the contract-allowance path here pulled that PGAS query into
        // the upload, and the query never settles after the system photo picker
        // backgrounds the WebView and wedges the dApp's socket — wedging the
        // upload on the first step forever. Deploy still calls
        // ensureAccountReady, because the registry publish IS a contract call.
        // Every upload is optimized: downscaled to the largest dimension the
        // page can display (1280px) and re-encoded — images that already fit
        // pass through untouched. The byte budget is the smaller of the chain's
        // per-tx cap and the remaining allowance (chain cap when unknown).
        const chainLimit = Math.min(MAX_TX_BYTES, maxStoreBytes ?? MAX_TX_BYTES);
        // Host accounts store via the host's preimage submission (local IPC,
        // no per-blob signing), so the full chain budget applies to both
        // sources. The halving loop below survives as a guard for hosts
        // whose IPC still rejects very large messages.
        let budget = chainLimit;
        for (;;) {
            onStatus("Optimising image…");
            const resized = await resizeImageToFit(file, Math.floor(budget * 0.95));
            const bytes = resized.bytes;
            const label = `Image (${resized.filename || "untitled"})`;
            onStatus(
                resized.finalBytes !== resized.originalBytes
                    ? `Optimised ${(resized.originalBytes / 1024).toFixed(0)} KB → ${(resized.finalBytes / 1024).toFixed(0)} KB. Uploading…`
                    : "Uploading to Bulletin…",
            );
            try {
                const stored = await storeBytes({
                    bytes,
                    signer: activeAccount.signer,
                    label,
                    viaHost: activeAccount.source === "host",
                    onStatus,
                });
                return stored.ipfsUrl;
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                const next = Math.floor(budget / 2);
                if (!/too big|too large/i.test(message) || next < MIN_SIGN_BUDGET) {
                    throw cause;
                }
                budget = next;
                onStatus(
                    `Signer rejected the size, retrying at ${(budget / 1024).toFixed(0)} KB…`,
                );
            }
        }
    };

    // Upload state lives HERE, keyed by block id — not in the bottom sheet.
    // Uploads outlive the sheet (close/reopen mid-upload keeps progress
    // visible) and completion patches the CURRENT block, so edits made while
    // uploading aren't reverted by a stale copy.
    const [uploads, setUploads] = useState<Record<string, string>>({});
    const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
    const startImageUpload = async (blockId: string, file: File) => {
        if (uploads[blockId]) return; // one upload per block at a time
        setUploadErrors(({ [blockId]: _drop, ...rest }) => rest);
        setUploads((prev) => ({ ...prev, [blockId]: "Preparing…" }));
        try {
            const url = await uploadImage(file, (msg) =>
                setUploads((prev) => ({ ...prev, [blockId]: msg })),
            );
            updateBlock(blockId, (b) =>
                b.type === "image" ? { ...b, url, alt: b.alt || file.name } : b,
            );
        } catch (cause) {
            setUploadErrors((prev) => ({
                ...prev,
                [blockId]: cause instanceof Error ? cause.message : String(cause),
            }));
        } finally {
            setUploads(({ [blockId]: _drop, ...rest }) => rest);
        }
    };

    const deploy = async () => {
        setBusy(true);
        setResult(null);
        setListStatus(null);
        setDeployError(null);
        setDeployStep(0);
        setStatus("Preparing deploy…");
        const updateDeployStatus = (message: string) => {
            setStatus(message);
            // Monotonic: the pipelined deploy interleaves Bulletin statuses
            // (step 1) with the commitment wait (step 5) — keep the bar at
            // the furthest stage reached instead of bouncing backward.
            setDeployStep((prev) => Math.max(prev ?? 0, stepForDeployStatus(message)));
        };
        try {
            if (!activeAccount || !effectiveLabel) {
                throw new Error("No account connected or no name resolved");
            }
            // Host account: connect + request the SmartContract/Bulletin
            // allowances (one cached host prompt) before chain work.
            await ensureAccountReady(activeAccount);
            const html = currentHtml();
            const stored = await deployFull(
                html,
                effectiveLabel,
                activeAccount,
                updateDeployStatus,
            );
            if (stored.dotMapped) recordDeployedSite(stored.domain, stored.url);
            let autoListing: RegistryListing | null = null;
            // Auto-list the freshly-deployed site PRIVATELY. A private entry
            // shows in the owner's own My Apps (Profile) but is filtered out of
            // the public Apps grid, so every deploy lands in the builder's
            // profile without exposing it to everyone. Public exposure stays
            // opt-in via the "List in Apps" button on the success card, which
            // re-publishes this same entry as public. Metadata is auto-derived
            // (title/description/first image, default "site" tag) — no edit step.
            //
            // Host accounts only: the registry entry is keyed to the connected
            // user, and the success card's listing affordance is host-only too
            // (the dev fallback is a throwaway key with no profile). Non-fatal —
            // the site is already live via DotNS, so a miss just leaves it off
            // My Apps until the user lists it, and we surface the warning.
            if (activeAccount.source === "host") {
                try {
                    // One clean status line, NO bar advance: the registry's
                    // internal "Registry: …" chatter is deliberately not wired to
                    // updateDeployStatus, so this listing adds no step to the
                    // deploy progress bar — it sits at its final position while
                    // the (silent, session-key-signed) publish lands.
                    setStatus("Adding to your apps…");
                    autoListing = await publishSiteToRegistry({
                        domain: stored.domain,
                        name: titleFromHtml(html).slice(0, LISTING_NAME_MAX),
                        description: descriptionFromHtml(html, LISTING_DESC_MAX),
                        // tag omitted → defaults to the reserved "site" tag, the
                        // dot-site quest's detection signal.
                        iconCid: firstImageCidFromHtml(html),
                        visibility: VISIBILITY_PRIVATE,
                        account: activeAccount,
                    });
                } catch (cause) {
                    // Don't fail the deploy; just log. The success card still
                    // offers "List in Apps", which retries the publish (public).
                    console.warn("Auto private registry listing failed:", cause);
                }
            }
            setResult({ ...stored, xpAwarded: autoListing?.xpAwarded });
        } catch (cause) {
            setDeployError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
            setStatus(null);
            setDeployStep(null);
        }
    };

    // Open the metadata panel: prefill name + description from the deployed
    // site. The user confirms/edits there, then `listInApps` re-publishes the
    // entry as public. Icon/cover are auto-derived at publish time. The category
    // is not user-selectable — every builder site is always tagged "site" (the
    // dot-site quest's detection signal), so there's no tag state to reset here.
    const openListModal = () => {
        if (!activeAccount || !result || listing) return;
        const html = currentHtml();
        // Truncate the prefilled name: maxLength on the input only caps typing,
        // not a programmatically-set value, so a long <h1> would otherwise
        // overflow. descriptionFromHtml already self-truncates to the cap.
        setListName(titleFromHtml(html).slice(0, LISTING_NAME_MAX));
        setListDescription(descriptionFromHtml(html, LISTING_DESC_MAX));
        setListStatus(null);
        setListModalOpen(true);
    };

    // Opt-in "make public": the site is already listed PRIVATELY (auto-listed
    // at deploy, visible only in the owner's My Apps), so this re-publishes the
    // SAME entry as public — which is what surfaces it in the public Apps grid.
    // The contract preserves owner + publisher across re-publish and only
    // mutates visibility + metadata_uri. Non-fatal: a failure leaves the entry
    // private with a retry. Host accounts only (the dev fallback is a throwaway
    // key). Launch XP can land during the auto-private first publish above; this
    // public flip is a re-publish of that same entry and therefore does not
    // award again.
    const listInApps = async () => {
        if (!activeAccount || !result || listing) return;
        setListing(true);
        setListStatus(null);
        try {
            const res = await publishSiteToRegistry({
                domain: result.domain,
                // Clamp at the source too — a hard backstop independent of the
                // input's maxLength (see LISTING_*_MAX in limits.ts).
                name: (listName.trim() || titleFromHtml(currentHtml())).slice(0, LISTING_NAME_MAX),
                description: listDescription.slice(0, LISTING_DESC_MAX),
                // Builder sites are always tagged "site" — no user-facing choice.
                tag: "site",
                // Auto-pick the first image already on the page as icon + cover;
                // undefined when there is none (keeps the placeholder tile).
                iconCid: firstImageCidFromHtml(currentHtml()),
                visibility: VISIBILITY_PUBLIC,
                account: activeAccount,
                onStatus: setListStatus,
            });
            setResult({
                ...result,
                registryListed: true,
                registryError: null,
                xpAwarded: result.xpAwarded || res.xpAwarded,
            });
            setListModalOpen(false);
            // The XP confetti is fired app-wide off the DeployPointAwarded
            // event (see src/App.tsx); no local trigger here. `xpAwarded` is
            // still recorded on `result` for the success-panel copy.
        } catch (cause) {
            setResult({
                ...result,
                registryListed: false,
                registryError: cause instanceof Error ? cause.message : String(cause),
            });
        } finally {
            setListing(false);
            setListStatus(null);
        }
    };

    const isEditing = view === "edit";
    const editingBlock =
        isEditing && mode === "blocks"
            ? content.blocks.find((b) => b.id === editingBlockId) ?? null
            : null;
    // Derive the primary button state from a pure function so the logic is
    // testable in isolation (see deployButton.ts / deployButton.test.ts).
    const deployBtn = deployButtonState({
        busy,
        preflightBusy,
        hasAccount: activeAccount !== null,
        hasName: effectiveLabel !== "",
        localOk,
        checkFresh,
        preflightOk: preflight?.ok ?? null,
        preflightFailed,
    });
    // A host account that can't afford the deploy → route to "Collect resources"
    // (in-app top-up) rather than offer a "deploy anyway" that would just fail.
    const hostFundsFail =
        activeAccount?.source === "host" &&
        (preflight?.checks.some((c) => c.id === "funds" && c.state === "fail") ?? false);
    const onPrimaryClick = () => {
        // "check"/"checkAgain" lead with the bounded pre-flight (which
        // auto-deploys on a clean pass); "deploy" is a direct retry after a
        // fresh pass whose auto-deploy didn't stick.
        if (deployBtn.mode === "check" || deployBtn.mode === "checkAgain") {
            runCheck();
        } else if (deployBtn.mode === "deploy") {
            void deploy();
        }
    };
    const copyAddress = async () => {
        if (!activeAccount) return;
        // On total failure the address is still selectable text.
        if (await copyText(activeAccount.address)) {
            setCopiedAddress(true);
            setTimeout(() => setCopiedAddress(false), 1500);
        }
    };
    const [copiedUrl, setCopiedUrl] = useState(false);
    const copyLiveUrl = async () => {
        if (!result) return;
        // In-host: copy the raw .dot URL (the host resolves it natively);
        // in a browser: the .dot.li gateway form.
        if (await copyText(hostLinkForm(result.url))) {
            setCopiedUrl(true);
            setTimeout(() => setCopiedUrl(false), 1500);
        }
    };
    // Separate "copied" state for the partial-failure gateway link so its
    // checkmark doesn't share the success-URL toggle.
    const [copiedGateway, setCopiedGateway] = useState(false);
    const copyGatewayUrl = async (url: string) => {
        if (await copyText(url)) {
            setCopiedGateway(true);
            setTimeout(() => setCopiedGateway(false), 1500);
        }
    };
    // ── Post-deploy "is it live yet" poll ───────────────────────────────
    // Resolvers (hosts, gateways) read the FINALIZED chain state, but the
    // deploy confirms at best-block — so for one finality lag (~30-60s on
    // Paseo) "Open your site" points at a not-yet-resolvable page. Poll the
    // finalized contenthash until it equals the CID we just deployed.
    // Fail-open: a polling error or 3 minutes without confirmation enables
    // the button anyway — the poll may only ever shrink the dead window.
    const [liveState, setLiveState] = useState<"checking" | "confirmed" | "assumed">(
        "checking",
    );
    useEffect(() => {
        if (!result?.dotMapped) return;
        const addr = activeAccount?.address;
        if (!addr) {
            setLiveState("assumed");
            return;
        }
        let cancelled = false;
        setLiveState("checking");
        const want = encodeIpfsContenthash(result.cid).toLowerCase();
        const deadline = Date.now() + 180_000;
        let interval: ReturnType<typeof setInterval> | null = null;
        const stop = (state: "confirmed" | "assumed") => {
            if (interval) clearInterval(interval);
            interval = null;
            if (!cancelled) setLiveState(state);
        };
        const tick = async () => {
            if (cancelled) return;
            try {
                const onChain = await readContentHashFinalized(result.domain, addr);
                if (cancelled) return;
                if (onChain?.toLowerCase() === want) stop("confirmed");
                else if (Date.now() > deadline) stop("assumed");
            } catch {
                stop("assumed");
            }
        };
        void tick();
        interval = setInterval(tick, 6000);
        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, [result, activeAccount?.address]);

    const colors = siteColors(content.background);
    const foreground = content.textColor ?? colors.foreground;
    const siteStyle = {
        background: content.background,
        fontFamily: content.fontFamily,
        fontSize: content.fontSize ?? DEFAULT_FONT_SIZE,
        textAlign: content.align,
        color: foreground,
        "--site-foreground": foreground,
        "--site-divider": colors.divider,
        "--site-accent": content.accentColor,
    } as React.CSSProperties;

    // Colors + Font controls: shown where their effect is VISIBLE. Blocks
    // mode styles the live site in the edit view; markdown's edit view is
    // raw source, so these ride the Preview view there instead. (HTML mode
    // styles via its CSS pane — no menu controls at all.)
    const styleActions = (
        <>
            <div className="colors-wrap action-item">
                <button
                    className="action-btn"
                    onClick={() => toggleMenu("colors")}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "colors"}
                    title="Colors"
                >
                    <PaletteIcon />
                </button>
                {openMenu === "colors" && (
                    <div className="colors-menu" role="menu">
                        <StyleRow
                            label="Accent"
                            value={content.accentColor}
                            presets={ACCENT_PRESETS}
                            onChange={(v) => update("accentColor", v)}
                        />
                        <StyleRow
                            label="Background"
                            value={content.background}
                            presets={BACKGROUND_PRESETS}
                            onChange={(v) => update("background", v)}
                        />
                        <StyleRow
                            label="Text"
                            value={foreground}
                            presets={TEXT_PRESETS}
                            onChange={(v) => update("textColor", v)}
                        >
                            {content.textColor && (
                                <button
                                    className="style-auto"
                                    onClick={() =>
                                        update("textColor", undefined)
                                    }
                                    title="Auto-pick for contrast against the background"
                                >
                                    Auto
                                </button>
                            )}
                        </StyleRow>
                    </div>
                )}
                <span className="action-label" aria-hidden="true">
                    Colors
                </span>
            </div>
            <div className="font-wrap action-item">
                <button
                    className="action-btn font-btn"
                    onClick={() => toggleMenu("font")}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "font"}
                    title="Font family"
                >
                    Aa
                </button>
                {openMenu === "font" && (
                    <div className="font-menu" role="menu">
                        {FONT_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                role="menuitem"
                                className={
                                    content.fontFamily === opt.value
                                        ? "is-active"
                                        : ""
                                }
                                style={{ fontFamily: opt.value }}
                                onClick={() => {
                                    update("fontFamily", opt.value);
                                    setOpenMenu(null);
                                }}
                            >
                                {opt.label}
                            </button>
                        ))}
                        <FontSizeStepper
                            value={parseInt(
                                content.fontSize ?? DEFAULT_FONT_SIZE,
                                10,
                            )}
                            onChange={(n) => update("fontSize", `${n}px`)}
                        />
                        <div
                            className="font-size-row font-align-row"
                            role="group"
                            aria-label="Text alignment"
                        >
                            {(["left", "center"] as const).map((a) => (
                                <button
                                    key={a}
                                    className={
                                        (content.align ?? "left") === a
                                            ? "is-active"
                                            : ""
                                    }
                                    onClick={() =>
                                        update("align", a as TextAlign)
                                    }
                                >
                                    {a === "left" ? "Left" : "Center"}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                <span className="action-label" aria-hidden="true">
                    Font
                </span>
            </div>
            {/* Shuffle: one tap drops a curated accent + background + text +
                font combo onto the page. Hit it until something clicks — every
                stop is hand-picked, so the user never has to dial in each
                channel by hand. */}
            <div className="shuffle-wrap action-item">
                <button
                    className="action-btn"
                    onClick={() => applyTheme(pickRandomTheme(content))}
                    title="Shuffle colours & font"
                    aria-label="Shuffle colours and font"
                >
                    <Dices size={18} aria-hidden="true" />
                </button>
                <span className="action-label" aria-hidden="true">
                    Shuffle
                </span>
            </div>
        </>
    );

    return (
        <>
            {mode !== "blocks" &&
                (isEditing ? (
                    <main className="code-pane">
                        <div className="code-card">
                            <div className="code-card-header">
                                <button
                                    type="button"
                                    className="header-back"
                                    onClick={exitToLanding}
                                    title="Back to Site Builder"
                                    aria-label="Back to Site Builder"
                                >
                                    <BackIcon />
                                </button>
                                <span aria-hidden="true">
                                    {mode === "markdown"
                                        ? "README.md"
                                        : htmlPane === "css"
                                          ? "styles.css"
                                          : htmlPane === "js"
                                            ? "script.js"
                                            : "index.html"}
                                </span>
                            </div>
                        <React.Suspense
                            fallback={<LoadingFallback label="Loading editor…" compact />}
                        >
                            <CodeEditor
                                cacheKey={entry.id}
                                language={mode === "markdown" ? "markdown" : htmlPane}
                                value={
                                    mode === "markdown"
                                        ? markdownText
                                        : htmlPane === "css"
                                          ? cssText
                                          : htmlPane === "js"
                                            ? jsText
                                            : htmlText
                                }
                                onChange={(v) => {
                                    if (mode === "markdown") setMarkdownText(v);
                                    else if (htmlPane === "css") setCssText(v);
                                    else if (htmlPane === "js") setJsText(v);
                                    else setHtmlText(v);
                                }}
                                placeholder={
                                    mode === "html" && htmlPane === "js"
                                        ? "// Runs at the end of <body>"
                                        : undefined
                                }
                                ariaLabel={
                                    mode === "markdown"
                                        ? "Markdown source"
                                        : `${htmlPane.toUpperCase()} source`
                                }
                                onHandle={setEditorHandle}
                            />
                        </React.Suspense>
                        </div>
                    </main>
                ) : iframesAllowed() ? (
                    // Preview IS the deploy artifact. sandbox without
                    // allow-same-origin: pasted scripts run, but in an opaque
                    // origin that can't reach the app (and its signer).
                    <iframe
                        className="site-frame"
                        title="Site preview"
                        srcDoc={currentHtml(false)}
                        sandbox="allow-scripts allow-popups"
                    />
                ) : (
                    // No sandbox = no preview: rendering user HTML inline
                    // would put pasted scripts in the APP origin, next to
                    // the signer. Deploy is unaffected.
                    <main className="code-pane">
                        <p className="frame-unavailable">
                            Preview isn't available in this host. It doesn't
                            allow embedded frames. Your site is unaffected:
                            deploy it and open it normally.
                        </p>
                    </main>
                ))}

            {mode === "blocks" && (
            <main className={`site ${isEditing ? "is-editing" : ""}`} style={siteStyle}>
                <article className="site-inner">
                    {content.blocks.map((block) => (
                        <BlockView
                            key={block.id}
                            block={block}
                            accentColor={content.accentColor}
                            editable={isEditing}
                            onUpdate={(b) => updateBlock(block.id, () => b)}
                            onRemove={() => removeBlock(block.id)}
                            onEdit={() => setEditingBlockId(block.id)}
                            uploadStatus={uploads[block.id] ?? null}
                        />
                    ))}
                    {isEditing && content.blocks.length === 0 && (
                        <p className="site-tip">
                            Click any text to edit. Use the + button below to add
                            paragraphs, links, or images.
                        </p>
                    )}
                    {/* Mirrors the footer wrapMain() bakes into the artifact, but
                        intentionally INERT here: this is the author's own canvas
                        (every other element is click-to-edit), the link is
                        self-referential — they're already in playground — and a
                        live nav mid-edit could drop them out of an unsaved
                        session (in the host, navigateTo replaces the view). The
                        credit only needs to be clickable for real visitors on the
                        deployed site. An href-less <a> keeps the .site-footer a
                        styling (underline) for visual parity while doing nothing
                        on click. */}
                    <footer className="site-footer">
                        made with{" "}
                        <a style={{ color: content.accentColor }}>playground.dot</a>
                    </footer>
                </article>
            </main>
            )}

            {/* Floating action bar — visible only in edit view; sits above the bottom nav pill. */}
            {isEditing && (
                <div className="float-bottom">
                    {/* Undo/redo satellites: same spot in every mode, thumb-zone
                        reachable, 40px touch targets. */}
                    <button
                        className="float-circle"
                        onClick={
                            mode === "blocks" ? undoBlocks : () => editorHandle?.undo()
                        }
                        disabled={
                            mode === "blocks"
                                ? undoStack.current.length === 0
                                : !editorHandle?.canUndo()
                        }
                        title="Undo"
                        aria-label="Undo"
                    >
                        <UndoIcon />
                    </button>
                    {/* Markdown edit has no bar items (styling rides Preview,
                        the mode is fixed) — skip the empty pill. */}
                    {mode !== "markdown" && (
                    <div className="action-bar" role="toolbar" aria-label="Site styling">
                        {mode === "blocks" && styleActions}
                        {mode === "blocks" && (
                        <div className="add-wrap action-item">
                            <button
                                className="action-btn"
                                onClick={() => toggleMenu("add")}
                                aria-haspopup="menu"
                                aria-expanded={openMenu === "add"}
                                title="Add element"
                            >
                                +
                            </button>
                            {openMenu === "add" && (
                                <div className="add-menu" role="menu">
                                    <button onClick={() => addBlock("heading")}>
                                        Heading
                                    </button>
                                    <button onClick={() => addBlock("paragraph")}>
                                        Paragraph
                                    </button>
                                    <button onClick={() => addBlock("link")}>Link</button>
                                    <button onClick={() => addBlock("button")}>
                                        Button
                                    </button>
                                    <button onClick={() => addBlock("image")}>Image</button>
                                    <button onClick={() => addBlock("divider")}>Divider</button>
                                </div>
                            )}
                            <span className="action-label" aria-hidden="true">
                                Add
                            </span>
                        </div>
                        )}
                        {mode === "html" &&
                            (["html", "css", "js"] as const).map((pane) => (
                                <div key={pane} className="action-item">
                                    <button
                                        className={`action-btn pane-btn ${
                                            htmlPane === pane ? "is-active" : ""
                                        }`}
                                        onClick={() => setHtmlPane(pane)}
                                        aria-pressed={htmlPane === pane}
                                        title={`Edit ${pane.toUpperCase()}`}
                                    >
                                        {PANE_GLYPHS[pane]}
                                    </button>
                                    <span className="action-label" aria-hidden="true">
                                        {pane.toUpperCase()}
                                    </span>
                                </div>
                            ))}
                        {mode === "blocks" && (
                            <div className="action-item">
                                <button
                                    className="action-btn"
                                    onClick={forkToHtml}
                                    disabled={forkBlocked}
                                    title={
                                        forkBlocked
                                            ? `Draft limit reached (${MAX_DRAFTS}). Delete a draft on the start page to make an HTML copy`
                                            : "Open an HTML, CSS & JS copy; this Simple draft is kept"
                                    }
                                >
                                    <CodeIcon />
                                </button>
                                <span className="action-label" aria-hidden="true">
                                    HTML
                                </span>
                            </div>
                        )}
                    </div>
                    )}
                    <button
                        className="float-circle"
                        onClick={
                            mode === "blocks" ? redoBlocks : () => editorHandle?.redo()
                        }
                        disabled={
                            mode === "blocks"
                                ? redoStack.current.length === 0
                                : !editorHandle?.canRedo()
                        }
                        title="Redo"
                        aria-label="Redo"
                    >
                        <RedoIcon />
                    </button>
                </div>
            )}

            {/* Markdown preview: the styling controls live HERE — the edit
                view is raw source where color/font changes are invisible. */}
            {view === "preview" && mode === "markdown" && (
                <div className="float-bottom">
                    <div className="action-bar" role="toolbar" aria-label="Site styling">
                        {styleActions}
                    </div>
                </div>
            )}

            {editingBlock && (
                <BlockEditSheet
                    block={editingBlock}
                    onUpdate={(b) => updateBlock(editingBlock.id, () => b)}
                    onDelete={() => {
                        removeBlock(editingBlock.id);
                        setEditingBlockId(null);
                    }}
                    onClose={() => setEditingBlockId(null)}
                    onUpload={(file) => startImageUpload(editingBlock.id, file)}
                    uploadStatus={uploads[editingBlock.id] ?? null}
                    uploadError={uploadErrors[editingBlock.id] ?? null}
                    maxStoreBytes={Math.min(MAX_TX_BYTES, maxStoreBytes ?? MAX_TX_BYTES)}
                />
            )}

            {/* Deploy panel — visible only in deploy view. Once the deploy
                fully lands, the SUCCESS card replaces the whole form: name,
                checklist and Deploy button are spent context. (Editing again
                or switching views clears `result`, restoring the form.) */}
            {view === "deploy" && (
                <div className="deploy-panel" role="region" aria-label="Deploy">
                    {result?.dotMapped ? (
                        <div className="result-success" role="status">
                            <span className="result-success-check" aria-hidden="true">
                                <Check size={22} />
                            </span>
                            <p className="result-success-title">
                                {liveState === "checking"
                                    ? "Your site is deployed"
                                    : "Your site is live"}
                            </p>
                            <p className="result-success-domain">
                                {result.domain}.dot
                                <button
                                    type="button"
                                    className={`result-success-copy${copiedUrl ? " copied" : ""}`}
                                    onClick={copyLiveUrl}
                                    title="Copy the site link"
                                    aria-label="Copy the site link"
                                >
                                    {copiedUrl ? <CheckIcon /> : <CopyIcon />}
                                </button>
                            </p>
                            {/* Status lines under the domain. "Going live"
                                replaces the old disabled pill — it's a wait
                                indicator, not a button you can click yet. The
                                listed confirmation collapses the List action
                                once it's done and links to the Apps grid where
                                the freshly-listed app now appears (XP itself is
                                announced by the celebration overlay). */}
                            {liveState === "checking" && (
                                <p
                                    className="result-success-status"
                                    role="status"
                                    aria-live="polite"
                                >
                                    <span
                                        className="result-success-dot"
                                        aria-hidden="true"
                                    />
                                    going live, usually under a minute
                                </p>
                            )}
                            {activeAccount?.source === "host" &&
                                result.registryListed && (
                                    <Link className="result-success-listed" to="/apps">
                                        <Check size={14} aria-hidden="true" />
                                        Listed in Apps
                                    </Link>
                                )}
                            {/* Adaptive emphasis: whichever action is still
                                pending is the filled primary. Before listing →
                                List in Apps; once listed (or a non-host account
                                that can't list) → Open becomes primary. Open
                                never renders while the site is still going
                                live — there's nothing to open yet. */}
                            {activeAccount?.source === "host" &&
                                !result.registryListed && (
                                    <div className="result-success-list">
                                        <button
                                            type="button"
                                            className="result-success-listbtn"
                                            onClick={openListModal}
                                            disabled={listing}
                                        >
                                            <Sparkles size={15} aria-hidden="true" />
                                            {result.registryError
                                                ? "Try listing again"
                                                : "List in Apps"}
                                        </button>
                                        {/* Surface a prior failure once the panel
                                            is closed; live publish progress and the
                                            phone hint live inside the panel. */}
                                        {result.registryError && !listing && (
                                            <p className="result-success-listnote">
                                                {`Couldn't list this time: ${result.registryError}`}
                                            </p>
                                        )}
                                    </div>
                                )}
                            {liveState !== "checking" && (
                                <PopupLink
                                    className={`result-success-open${
                                        activeAccount?.source === "host" &&
                                        !result.registryListed
                                            ? " secondary"
                                            : ""
                                    }`}
                                    href={result.url}
                                >
                                    Open your site
                                </PopupLink>
                            )}
                            <button
                                type="button"
                                className="result-success-another"
                                onClick={exitToLanding}
                            >
                                Build another site
                            </button>
                            {liveState === "assumed" && (
                                <p className="result-success-hint">
                                    If the link doesn't load yet, give it
                                    another minute and try again.
                                </p>
                            )}
                        </div>
                    ) : (
                    <>
                    <h2 className="deploy-title">Deploy your site</h2>

                    {/* The deploy uses the host account silently — no need to
                        show the address (the user is already signed in at the
                        host). Only surface a prompt when there's NO account to
                        sign with. The address + dev toggle live in the
                        checklist's deep-details view. */}
                    {!activeAccount && !resolvingOwned && (
                        <div className="deploy-field">
                            <span className="field-label">Account</span>
                            <button
                                className="pill pill-secondary"
                                onClick={handleHostSignIn}
                                disabled={busy}
                            >
                                Connect Polkadot account
                            </button>
                            <p className="hint">
                                {ownedError ??
                                    "Sign in with your Polkadot account to deploy your site."}
                            </p>
                        </div>
                    )}

                    <div className="deploy-field">
                        <label className="name-field">
                            <span className="field-label">.dot name</span>
                            <span className="name-input">
                                <input
                                    type="text"
                                    placeholder={autoLabel ?? "auto-generated if blank"}
                                    value={domain}
                                    onChange={(e) =>
                                        setDomain(e.target.value.trim().toLowerCase())
                                    }
                                    disabled={busy}
                                />
                                <span className="name-suffix">.dot</span>
                            </span>
                        </label>
                        <button
                            type="button"
                            className="link-btn name-rules-link"
                            onClick={() => setNameRulesOpen(true)}
                        >
                            Learn more about choosing a name
                        </button>
                    </div>

                    {/* Pre-flight checklist — shown after an explicit check or while one runs. */}
                    {!busy && (preflight || preflightBusy || preflightFailed) && (
                        <div className="preflight" role="status" aria-label="Pre-flight checks">
                            {/* "Check again" / "Try to deploy anyway" live on
                                the primary buttons below — these lines only
                                explain what the failed check means. */}
                            {preflightFailed && !preflightBusy && (
                                <p className="hint subtle">
                                    Checks unavailable. The deploy itself
                                    verifies everything on-chain.
                                </p>
                            )}
                            {checkFresh && preflight !== null && !preflight.ok && !preflightBusy && (
                                <p className="hint subtle">
                                    Some checks didn't pass. The deploy may fail or waste a
                                    transaction.
                                </p>
                            )}
                            {preflight?.checks.map((check) => {
                                const shown =
                                    showCheckDetails && check.tech
                                        ? check.tech
                                        : check.detail;
                                return (
                                    <div
                                        key={check.id}
                                        className={`check-row check-${check.state}`}
                                    >
                                        <span className="check-icon" aria-hidden="true">
                                            {check.state === "ok"
                                                ? "✓"
                                                : check.state === "warn"
                                                  ? "!"
                                                  : "✕"}
                                        </span>
                                        <span className="check-label">{check.label}</span>
                                        {(shown || check.link) && (
                                            <span className="check-detail">
                                                {shown}
                                                {check.link && (
                                                    <>
                                                        {shown && " "}
                                                        <PopupLink href={check.link}>
                                                            Open faucet
                                                        </PopupLink>
                                                        {" · "}
                                                        <button
                                                            type="button"
                                                            className="check-recheck"
                                                            onClick={runCheck}
                                                            disabled={preflightBusy}
                                                        >
                                                            Re-check
                                                        </button>
                                                    </>
                                                )}
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                            {preflightBusy && (
                                <p className="hint subtle">
                                    {preflight ? "Re-checking…" : "Running pre-flight checks…"}
                                </p>
                            )}
                            {preflight && !preflightBusy && (
                                <button
                                    type="button"
                                    className={`check-details-toggle${showCheckDetails ? " active" : ""}`}
                                    onClick={() => setShowCheckDetails((v) => !v)}
                                    aria-expanded={showCheckDetails}
                                >
                                    {showCheckDetails
                                        ? "Hide developer details"
                                        : "Developer details"}
                                </button>
                            )}
                            {showCheckDetails && (
                                <div className="check-dev">
                                    {activeAccount && (
                                        <button
                                            type="button"
                                            className="check-dev-addr"
                                            onClick={copyAddress}
                                            title="Copy address"
                                        >
                                            <code>{activeAccount.address}</code>
                                            <span className="copy-state">
                                                {copiedAddress ? "copied ✓" : "copy"}
                                            </span>
                                        </button>
                                    )}
                                    <label
                                        className="checkbox check-dev-toggle"
                                        title="Throwaway local signer, no wallet needed"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={useDevAccount}
                                            onChange={(e) =>
                                                setUseDevAccount(e.target.checked)
                                            }
                                            disabled={busy}
                                        />
                                        <span>Use a dev account</span>
                                    </label>
                                    <p className="check-dev-diag">
                                        build {VERSION} · served from{" "}
                                        {typeof window === "undefined"
                                            ? "?"
                                            : window.location.hostname}{" "}
                                        · signing as {PLAYGROUND_DOTNS_ID}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Local hard-block reason — instant, no network. Explains
                        why Deploy is disabled in the two guaranteed-failure
                        cases so the user can act without waiting on a check. */}
                    {!busy && (sizeError || nameFormatError !== null) && (
                        <p className="hint warn">
                            {sizeError
                                ? "Too large to deploy. Remove large files or images."
                                : nameFormatError}
                        </p>
                    )}

                    {/* Deploy progress occupies the SAME slot the pre-flight
                        checklist does (the two are mutually exclusive on
                        `busy`), so the check→deploy transition swaps content in
                        a fixed region above the button instead of unmounting
                        the checklist and remounting progress below — which made
                        the button hop at the exact moment of the click. */}
                    {busy && status && deployStep !== null && (
                        <StepProgress
                            steps={DEPLOY_STEPS}
                            step={deployStep}
                            status={status}
                            phoneSteps={DEPLOY_PHONE_STEPS}
                        />
                    )}

                    {/* The primary button leads with the check, then auto-
                        deploys on a clean pass. When the fresh check didn't
                        pass it becomes "Check again" and the secondary "Try to
                        deploy anyway" appears beside it — advice, not a gate. */}
                    <button
                        className="pill pill-primary pill-wide"
                        onClick={onPrimaryClick}
                        disabled={deployBtn.disabled}
                    >
                        {deployBtn.label}
                    </button>

                    {deployBtn.mode === "checkAgain" &&
                        (hostFundsFail ? (
                            <div className="result result-error">
                                <p className="result-fail-title">
                                    You need more resources
                                </p>
                                <p className="result-note">
                                    Collect more to finish deploying your site.
                                </p>
                                <button
                                    type="button"
                                    className="pill pill-secondary pill-wide"
                                    onClick={() => setResourcesModalOpen(true)}
                                >
                                    Get more resources
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="pill pill-secondary pill-wide"
                                onClick={() => void deploy()}
                            >
                                Try to deploy anyway
                            </button>
                        ))}

                    {result && !result.dotMapped && (() => {
                        const action = failureAction(
                            result.dotError ?? "",
                            "Check your balance or pick a different name, then deploy again.",
                        );
                        return (
                            <div className="result result-partial">
                                <p className="result-live-title">
                                    <Check size={18} aria-hidden="true" /> Your site
                                    is live
                                </p>
                                <div className="result-link-row">
                                    <PopupLink
                                        className="result-link"
                                        href={result.gatewayUrl}
                                    >
                                        {result.gatewayUrl}
                                    </PopupLink>
                                    <button
                                        type="button"
                                        className={`result-link-copy${copiedGateway ? " copied" : ""}`}
                                        onClick={() => copyGatewayUrl(result.gatewayUrl)}
                                        title="Copy link"
                                        aria-label="Copy link"
                                    >
                                        {copiedGateway ? <CheckIcon /> : <CopyIcon />}
                                    </button>
                                </div>
                                <p className="result-note">
                                    We weren't able to register your domain:{" "}
                                    <code>{result.domain}.dot</code>. {action}
                                </p>
                                {result.dotError && (
                                    <button
                                        type="button"
                                        className="link-btn"
                                        onClick={() => setLogsText(result.dotError)}
                                    >
                                        View logs
                                    </button>
                                )}
                            </div>
                        );
                    })()}
                    {deployError && (() => {
                        // A funds shortfall that surfaced as a tx revert (rather
                        // than at pre-flight) gets the same "collect resources"
                        // affordance instead of a raw error — same destination as
                        // the funds-fail row above.
                        if (isResourcesError(deployError)) {
                            return (
                                <div className="result result-error">
                                    <p className="result-fail-title">
                                        You need more resources
                                    </p>
                                    <p className="result-note">
                                        Collect more to finish deploying your site.
                                    </p>
                                    <button
                                        type="button"
                                        className="pill pill-secondary pill-wide"
                                        onClick={() => setResourcesModalOpen(true)}
                                    >
                                        Get more resources
                                    </button>
                                </div>
                            );
                        }
                        const action = failureAction(
                            deployError,
                            "Check your balance, then deploy again.",
                        );
                        return (
                            <div className="result result-error">
                                <p className="result-fail-title">
                                    Deployment didn't finish
                                </p>
                                <p className="result-note">{action}</p>
                                <button
                                    type="button"
                                    className="link-btn"
                                    onClick={() => setLogsText(deployError)}
                                >
                                    View logs
                                </button>
                            </div>
                        );
                    })()}
                    </>
                    )}
                </div>
            )}

            {/* Back to the Site Builder landing — floating top-left, except in
                the md/html EDIT views, where the code card's filename header
                hosts the control instead (the card is centered, so a fixed
                circle can't align with it). */}
            {!(isEditing && mode !== "blocks") && (
                <button
                    type="button"
                    className="float-circle back-float"
                    onClick={exitToLanding}
                    title="Back to Site Builder"
                    aria-label="Back to Site Builder"
                >
                    <BackIcon />
                </button>
            )}

            {logsText !== null && (
                <LogsModal text={logsText} onClose={() => setLogsText(null)} />
            )}

            {resourcesModalOpen && (
                <BuilderModal
                    title="You need more resources"
                    onClose={() => setResourcesModalOpen(false)}
                >
                    <p className="hint">
                        Publishing your site uses resources from your account.
                        Collect more to finish. It only takes a moment, and
                        there's nothing to buy.
                    </p>
                    <button
                        type="button"
                        className="pill pill-primary pill-wide"
                        onClick={() => {
                            // One attempt, user-initiated. For a builder this
                            // tops up in the background and reports the outcome
                            // through the onboarding toasts — no auto re-check or
                            // re-deploy, so it can't spin a signature loop. The
                            // user re-runs the check themselves once funded.
                            setResourcesModalOpen(false);
                            startBecomeBuilder();
                        }}
                    >
                        Collect resources
                    </button>
                </BuilderModal>
            )}

            {listModalOpen && (
                <ListInAppsModal
                    name={listName}
                    description={listDescription}
                    listing={listing}
                    status={listStatus}
                    onName={setListName}
                    onDescription={setListDescription}
                    onPublish={listInApps}
                    onClose={() => {
                        if (!listing) setListModalOpen(false);
                    }}
                />
            )}

            {nameRulesOpen && (
                <NameRulesModal
                    suggestion={autoLabel}
                    onClose={() => setNameRulesOpen(false)}
                />
            )}

            {editorNotice && (
                <div className="builder-editor-toast" role="status">
                    {editorNotice}
                </div>
            )}

            {/* Bottom centered nav — 3 view tabs, always visible. */}
            <nav className="bottom-nav" aria-label="View">
                <div className="bottom-nav-pill">
                    <NavTab
                        active={view === "edit"}
                        onClick={() => {
                            setView("edit");
                            setOpenMenu(null);
                        }}
                        icon={<PencilIcon />}
                        label="Edit"
                    />
                    <NavTab
                        active={view === "preview"}
                        onClick={() => {
                            setView("preview");
                            setOpenMenu(null);
                        }}
                        icon={<EyeIcon />}
                        label="Preview"
                    />
                    <NavTab
                        active={view === "deploy"}
                        onClick={() => {
                            setView("deploy");
                            setOpenMenu(null);
                        }}
                        icon={<RocketIcon />}
                        label="Deploy"
                    />
                </div>
            </nav>
        </>
    );
}

// How long a single deploy step may run before the progress UI adds a "still
// working" reassurance. The eased fill (progress.ts) is already flat near its
// 92% cap by ~25s with no host sub-progress to move it, and the per-step
// deadlines are 45-90s — so a step sitting past this is either a slow network
// or a wedged connection on its way to a timeout. Either way the user should be
// told it isn't frozen, and that a timeout will let them retry safely.
const SLOW_STEP_HINT_MS = 18_000;

function StepProgress({
    steps,
    step,
    status,
    phoneSteps,
}: {
    steps: readonly ProgressStep[];
    step: number;
    status: string;
    /** Step ids whose tx the user approves on their phone — when the active
     *  step is one of these, a "check your phone" hint is shown. */
    phoneSteps?: ReadonlySet<string>;
}) {
    const currentStep = steps[Math.min(step, steps.length - 1)];
    const stepNumber = Math.min(step + 1, steps.length);
    const needsPhone = phoneSteps?.has(currentStep.id) ?? false;

    // Eased within-step fill for the active segment. The host SDK gives no
    // sub-progress for the slow broadcast/in-block wait, so we animate EXPECTED
    // progress (see progress.ts) — fast early, slowing as it climbs — to read
    // as "working" rather than "frozen". Re-armed whenever `step` advances; the
    // segment flipping to is-complete (full accent via CSS) is the real "snap
    // to done". Keyed only on `step`, so frequent `status` text updates don't
    // restart the fill.
    const [activeFill, setActiveFill] = useState(0);
    // A step that runs past SLOW_STEP_HINT_MS reads as "stuck": the eased fill
    // has long since flattened near its cap. `slow` flips on a reassurance line
    // so a slow-but-alive network doesn't look like a freeze. Re-armed (false)
    // whenever the step advances, alongside the fill.
    const [slow, setSlow] = useState(false);
    useEffect(() => {
        setActiveFill(0);
        setSlow(false);
        const start = performance.now();
        const id = window.setInterval(() => {
            const elapsed = performance.now() - start;
            setActiveFill(easedStepProgress(elapsed, PROGRESS_TAU_MS));
            if (elapsed > SLOW_STEP_HINT_MS) setSlow(true);
        }, 150);
        return () => window.clearInterval(id);
    }, [step]);

    return (
        <div className="deploy-progress" role="status" aria-live="polite">
            <div className="progress-meta">
                <span>{`Step ${stepNumber} of ${steps.length}`}</span>
                <span>{currentStep.label}</span>
            </div>
            <div
                className="progress-bar"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={steps.length}
                aria-valuenow={stepNumber}
                aria-valuetext={`${currentStep.label}: ${status}`}
            >
                {steps.map((s, index) => (
                    <span
                        key={s.id}
                        className={[
                            "progress-segment",
                            index < step ? "is-complete" : "",
                            index === step ? "is-active" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        aria-hidden="true"
                    >
                        {index === step && (
                            <span
                                className="progress-segment-fill"
                                style={{ width: `${Math.round(activeFill * 100)}%` }}
                            />
                        )}
                    </span>
                ))}
            </div>
            <div className="status">{status}</div>
            {needsPhone && (
                <div className="progress-phone-hint" role="status">
                    📱 Check your phone. Approve this step to continue.
                </div>
            )}
            {slow && !needsPhone && (
                <div className="progress-slow-hint" role="status">
                    Still working. This can take a moment.
                </div>
            )}
        </div>
    );
}

function NavTab({
    active,
    onClick,
    icon,
    label,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            className={`nav-tab ${active ? "is-active" : ""}`}
            onClick={onClick}
            aria-pressed={active}
        >
            {icon}
            <span className="nav-tab-label">{label}</span>
        </button>
    );
}

// − / value / + stepper for the base font size (px). Clicking the number swaps
// it for a text input; Enter or blur commits, Escape cancels.
function FontSizeStepper({
    value,
    onChange,
}: {
    value: number;
    onChange: (next: number) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const clamp = (n: number) => Math.min(40, Math.max(8, Math.round(n)));
    const commit = () => {
        if (draft !== null) {
            const n = parseInt(draft, 10);
            if (!Number.isNaN(n)) onChange(clamp(n));
        }
        setDraft(null);
    };
    return (
        <div className="font-size-row" role="group" aria-label="Font size">
            <button
                onClick={() => onChange(clamp(value - 1))}
                aria-label="Decrease font size"
            >
                −
            </button>
            {draft !== null ? (
                <input
                    autoFocus
                    inputMode="numeric"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setDraft(null);
                    }}
                    aria-label="Font size in pixels"
                />
            ) : (
                <button
                    className="font-size-value"
                    onClick={() => setDraft(String(value))}
                    title="Click to type a size"
                >
                    {value}
                </button>
            )}
            <button
                onClick={() => onChange(clamp(value + 1))}
                aria-label="Increase font size"
            >
                +
            </button>
        </div>
    );
}

// Per-context preset palettes. Each row offers colors that actually suit its
// job, rather than one shared list (a saturated hue is a fine accent but a bad
// background; white/black are fine text/background but poor accents).
//
// ACCENT — interactive color (buttons, links). Vibrant Tailwind-500-grade
// hues, evenly spread around the wheel so they read on both light and dark
// (the artifact pairs the accent with a luminance-computed text color), led by
// the Polkadot pink that's also the default. A neutral slate closes the row
// for monochrome designs.
const ACCENT_PRESETS = [
    "#e6007a", "#ef4444", "#f97316", "#f59e0b", "#22c55e", "#14b8a6",
    "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#64748b",
];
// BACKGROUND — page canvas. Six options that are each visibly distinct at
// swatch size (an earlier 10-swatch set read as "5 blacks, 5 whites" — the
// warm/cool tints were imperceptible). Three clearly-different darks (neutral
// black, blue slate, green teal) and three clearly-different lights (pure
// white, warm sand, cool sky); good canvases cluster at the extremes, so no
// muddy mid-grays.
const BACKGROUND_PRESETS = [
    "#0b0d12", "#1e293b", "#134e4a",
    "#ffffff", "#f5ead6", "#dbeafe",
];
// TEXT — body copy. An evenly-spaced neutral ramp where each step is a clearly
// different lightness (one white, one black, three distinct grays) rather than
// a stack of near-whites/near-blacks. The Text row's Auto option still
// default-picks the contrast color; these are deliberate overrides.
const TEXT_PRESETS = [
    "#ffffff", "#cbd5e1", "#6b7280", "#374151", "#0b0d12",
];

// Accepts `#rrggbb` or the same without the leading `#`; returns the
// canonical `#rrggbb` or null when it isn't a complete 6-digit hex color.
// Deliberately NO 3-digit shorthand: backspacing a 6-digit value passes
// through length 3, and expanding it there would hijack the edit mid-delete
// (apply a surprise color + rewrite the field to its 6-digit form).
function normalizeHex(input: string): string | null {
    const v = input.trim().toLowerCase().replace(/^#/, "");
    return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

// A labelled color row inside the Colors menu. Tapping the swatch expands an
// in-DOM picker (preset grid + hex field) rather than the native
// `<input type="color">`: that control is rendered by the Android product
// WebView's INTERNAL chooser, which needs an Activity window token the
// app-context WebView can't provide, so it silently no-ops on tap (same
// root cause as the openUri crash and broken JS dialogs). A DOM picker works
// uniformly on every host. `children` slots extra controls between the label
// and the swatch (e.g. the Text row's Auto reset).
function StyleRow({
    label,
    value,
    presets,
    onChange,
    children,
}: {
    label: string;
    value: string;
    presets: string[];
    onChange: (next: string) => void;
    children?: React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [hex, setHex] = useState(value);
    const [editing, setEditing] = useState(false);
    // Re-sync the field from `value` only when NOT being edited: on blur (snap
    // to the canonical applied color, reverting an incomplete entry) and on
    // external changes (preset tap, Text's Auto reset). While the user types,
    // the field is theirs — the sync must not rewrite it mid-edit.
    useEffect(() => {
        if (!editing) setHex(value);
    }, [value, editing]);

    // A non-empty field that isn't a complete 6-digit hex is invalid: surface
    // it (red field + message) so the state is never a mystery, and don't let
    // Done / Enter commit it — they'd otherwise silently revert to the last
    // valid color, swallowing the error. Empty is neutral (a no-op close).
    const invalid = hex.trim() !== "" && normalizeHex(hex) === null;

    return (
        <div className="style-row-wrap">
            <div className="style-row">
                <span className="style-row-label">{label}</span>
                {children}
                <button
                    type="button"
                    className="swatch"
                    title={`${label}: ${value}`}
                    style={{ background: value }}
                    aria-label={`${label} color`}
                    aria-expanded={open}
                    onClick={() => setOpen((o) => !o)}
                />
            </div>
            {open && (
                <div className="color-picker" role="group" aria-label={`${label} color`}>
                    <div className="color-presets">
                        {presets.map((c) => (
                            <button
                                key={c}
                                type="button"
                                className={`color-preset${
                                    c === value.toLowerCase() ? " is-selected" : ""
                                }`}
                                style={{ background: c }}
                                title={c}
                                aria-label={c}
                                onClick={() => {
                                    onChange(c);
                                    setOpen(false);
                                }}
                            />
                        ))}
                    </div>
                    <div className="color-hex-row">
                        <input
                            type="text"
                            className={`color-hex${invalid ? " is-invalid" : ""}`}
                            value={hex}
                            spellCheck={false}
                            autoCapitalize="none"
                            autoCorrect="off"
                            placeholder="#rrggbb"
                            aria-label={`${label} hex value`}
                            aria-invalid={invalid}
                            onFocus={() => setEditing(true)}
                            onBlur={() => setEditing(false)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !invalid) setOpen(false);
                                if (e.key === "Escape") setOpen(false);
                            }}
                            onChange={(e) => {
                                setHex(e.target.value);
                                const norm = normalizeHex(e.target.value);
                                if (norm) onChange(norm);
                            }}
                        />
                        <button
                            type="button"
                            className="color-done"
                            disabled={invalid}
                            onClick={() => setOpen(false)}
                        >
                            Done
                        </button>
                    </div>
                    {invalid && (
                        <p className="color-hex-error" role="alert">
                            Enter a 6-digit hex, like #1a2b3c
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

// In edit mode, text blocks stay directly editable inline (the WYSIWYG core);
// structured blocks (link/button/image) render exactly like the preview and
// open the bottom-sheet property editor on tap.
function BlockView({
    block,
    accentColor,
    editable,
    onUpdate,
    onRemove,
    onEdit,
    uploadStatus,
}: {
    block: Block;
    accentColor: string;
    editable: boolean;
    onUpdate: (next: Block) => void;
    onRemove: () => void;
    onEdit: () => void;
    uploadStatus?: string | null;
}) {
    const linkStyle =
        block.type === "link" && block.variant === "pill"
            ? {
                  background: accentColor,
                  color: siteColors(accentColor).foreground,
              }
            : { color: accentColor };
    const structured = block.type === "link" || block.type === "image";
    return (
        <div className={`block ${editable ? "is-editing" : ""}`}>
            {editable && structured && (
                <button
                    className="block-corner block-edit"
                    onClick={onEdit}
                    aria-label={`Edit ${block.type}`}
                    title="Edit"
                >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
                    </svg>
                </button>
            )}
            {editable && (
                <button
                    className="block-corner block-remove"
                    onClick={onRemove}
                    aria-label={`Remove ${block.type}`}
                    title="Remove"
                >
                    ×
                </button>
            )}
            {block.type === "heading" && (
                <Editable
                    tag="h1"
                    value={block.text}
                    onChange={(text) => onUpdate({ ...block, text })}
                    editable={editable}
                    className="site-header"
                    style={{ color: accentColor }}
                    placeholder="Heading"
                />
            )}
            {block.type === "paragraph" && (
                <Editable
                    tag="p"
                    value={block.text}
                    onChange={(text) => onUpdate({ ...block, text })}
                    editable={editable}
                    className="site-paragraph"
                    placeholder="Paragraph text"
                />
            )}
            {block.type === "link" && (
                <p className={`block-link ${block.variant === "pill" ? "is-pill" : ""}`}>
                    {editable ? (
                        <span
                            className="site-link block-tap"
                            style={linkStyle}
                            onClick={onEdit}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === "Enter" && onEdit()}
                        >
                            {block.label || "Link text"}
                        </span>
                    ) : (
                        <PopupLink
                            // Same allowlist as the deployed artifact: the
                            // preview runs in the APP origin (which holds the
                            // signer), so a typed javascript: URL must be as
                            // inert here as it is in the artifact.
                            href={validateUrl(block.url)}
                            className="site-link"
                            style={linkStyle}
                        >
                            {block.label}
                        </PopupLink>
                    )}
                </p>
            )}
            {block.type === "image" &&
                (!isPlaceholderImageUrl(block.url) ? (
                    <img
                        className={`site-image is-${imageSize(block.variant)} is-${imageShape(block)} ${editable ? "block-tap" : ""}`}
                        src={block.url}
                        alt={block.alt}
                        onClick={editable ? onEdit : undefined}
                    />
                ) : editable ? (
                    <div
                        className={`site-image-placeholder is-${imageSize(block.variant)} is-${imageShape(block)} block-tap${uploadStatus ? " is-uploading" : ""}`}
                        onClick={onEdit}
                        role="button"
                        tabIndex={0}
                        aria-busy={uploadStatus ? true : undefined}
                        onKeyDown={(e) => e.key === "Enter" && onEdit()}
                    >
                        {uploadStatus && (
                            <span className="upload-spinner" aria-hidden="true" />
                        )}
                        {uploadStatus ?? "No image yet, tap to edit"}
                    </div>
                ) : null)}
            {block.type === "divider" && <hr className="site-divider" />}
        </div>
    );
}

// Bottom-sheet property editor for structured blocks. Labeled form fields,
// live updates (the page behind reflects edits as you type), Delete as the
// destructive footer action.
function BlockEditSheet({
    block,
    onUpdate,
    onDelete,
    onClose,
    onUpload,
    uploadStatus,
    uploadError,
    maxStoreBytes,
}: {
    block: Block;
    onUpdate: (next: Block) => void;
    onDelete: () => void;
    onClose: () => void;
    /** Fire-and-forget: upload state is owned by App (keyed by block id), so
     * it survives this sheet closing and reopening mid-upload. */
    onUpload: (file: File) => void;
    uploadStatus: string | null;
    uploadError: string | null;
    maxStoreBytes: number;
}) {
    // URL entry is the power-user path — hidden behind a toggle by default.
    const [showUrlField, setShowUrlField] = useState(false);
    const uploading = uploadStatus !== null;
    const hasImage =
        block.type === "image" && !!block.url && block.url !== "https://";
    const kind =
        block.type === "link"
            ? block.variant === "pill"
                ? "Button"
                : "Link"
            : "Image";

    return (
        <div className="sheet-backdrop" onClick={onClose}>
            <div
                className="sheet"
                role="dialog"
                aria-label={`Edit ${kind}`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="sheet-title">Edit {kind}</div>
                {block.type === "link" && (
                    <>
                        <label className="sheet-field">
                            <span>Label</span>
                            <input
                                type="text"
                                value={block.label}
                                onChange={(e) =>
                                    onUpdate({ ...block, label: e.target.value })
                                }
                                placeholder={kind === "Button" ? "Button text" : "Link text"}
                            />
                        </label>
                        <label className="sheet-field">
                            <span>URL</span>
                            <input
                                type="url"
                                value={block.url}
                                onChange={(e) =>
                                    onUpdate({ ...block, url: e.target.value })
                                }
                                placeholder="https://"
                            />
                        </label>
                    </>
                )}
                {block.type === "image" && (
                    <>
                        <label
                            className={`sheet-media ${hasImage ? "has-img" : ""}`}
                        >
                            <input
                                type="file"
                                accept="image/*"
                                disabled={uploading}
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (file) onUpload(file);
                                }}
                            />
                            {uploading && uploadStatus ? (
                                <div className="sheet-media-empty">
                                    <StepProgress
                                        steps={UPLOAD_STEPS}
                                        step={stepForUploadStatus(uploadStatus)}
                                        status={uploadStatus}
                                        phoneSteps={UPLOAD_PHONE_STEPS}
                                    />
                                    <span className="sheet-media-note">
                                        Uploading in the background, close this
                                        and keep editing your page.
                                    </span>
                                </div>
                            ) : hasImage ? (
                                <>
                                    <img src={block.url} alt={block.alt} />
                                    <span
                                        className="sheet-media-chip"
                                        aria-hidden="true"
                                    >
                                        Replace
                                    </span>
                                </>
                            ) : (
                                <div className="sheet-media-empty">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M12 16V4" />
                                        <path d="m6 10 6-6 6 6" />
                                        <path d="M4 20h16" />
                                    </svg>
                                    <span>Tap to add an image</span>
                                    <span className="sheet-media-note">
                                        Optimised automatically, up to{" "}
                                        {MAX_IMAGE_DIMENSION}px,{" "}
                                        {(maxStoreBytes / 1024 / 1024).toFixed(0)} MB
                                    </span>
                                </div>
                            )}
                        </label>
                        {uploadError && (
                            <pre className="image-upload-error">{uploadError}</pre>
                        )}
                        {showUrlField ? (
                            <label className="sheet-field">
                                <span>Image link</span>
                                <input
                                    type="url"
                                    value={block.url}
                                    onChange={(e) =>
                                        onUpdate({ ...block, url: e.target.value })
                                    }
                                    placeholder="https://"
                                    autoFocus
                                />
                            </label>
                        ) : (
                            <button
                                type="button"
                                className="sheet-link-toggle"
                                onClick={() => setShowUrlField(true)}
                            >
                                Use an image link instead
                            </button>
                        )}
                        <label className="sheet-field">
                            <span>Alt text</span>
                            <input
                                type="text"
                                value={block.alt}
                                onChange={(e) =>
                                    onUpdate({ ...block, alt: e.target.value })
                                }
                                placeholder="Describe the image"
                            />
                        </label>
                        <div className="sheet-field">
                            <span>Size</span>
                            <VariantToggle
                                label="Image size"
                                options={[
                                    { value: "small", name: "Small · 160px" },
                                    { value: "medium", name: "Medium · 512px" },
                                    { value: "large", name: "Large · full" },
                                ]}
                                value={imageSize(block.variant)}
                                onChange={(variant) =>
                                    onUpdate({
                                        ...block,
                                        variant: variant as ImageVariant,
                                        // Pin the shape so changing size never
                                        // silently changes corners.
                                        shape: imageShape(block),
                                    })
                                }
                            />
                        </div>
                        <div className="sheet-field">
                            <span>Shape</span>
                            <VariantToggle
                                label="Image shape"
                                options={[
                                    { value: "circle", name: "Circle" },
                                    { value: "rounded", name: "Rounded" },
                                    { value: "square", name: "Square" },
                                ]}
                                value={imageShape(block)}
                                onChange={(shape) =>
                                    onUpdate({
                                        ...block,
                                        shape: shape as ImageShape,
                                    })
                                }
                            />
                        </div>
                    </>
                )}
                <div className="sheet-actions">
                    <button className="sheet-delete" onClick={onDelete}>
                        Delete
                    </button>
                    <button className="sheet-done" onClick={onClose}>
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}

// Tiny segmented control for per-block style variants — what makes every
// template block reproducible by hand (avatar images, button links).
function VariantToggle({
    label,
    options,
    value,
    onChange,
}: {
    label: string;
    options: { value: string; name: string }[];
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <span className="variant-toggle" role="group" aria-label={label}>
            {options.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    className={value === opt.value ? "is-active" : ""}
                    aria-pressed={value === opt.value}
                    onClick={() => onChange(opt.value)}
                >
                    {opt.name}
                </button>
            ))}
        </span>
    );
}

// Heuristic hint mapping common DotNS failures to actionable next steps.
// The error strings come from pallet-revive dispatch errors, JSON-serialised
// in submit-and-wait, so they're greppable.
// Map a raw failure message to ONE short, friendly next step. The verbose
// diagnosis lives in the logs modal; funding lives on the Balance checklist row
// (still shown above) — so this is just plain words, no faucet link.
// True when a raw failure message is a funds/resources shortfall (the same
// bucket `failureAction` maps to "add tokens"). Used to swap the generic deploy
// error card for the "collect resources" affordance. Excludes "timed out",
// which is a stalled connection, not a shortfall.
function isResourcesError(message: string): boolean {
    const m = message.toLowerCase();
    if (m.includes("timed out")) return false;
    return (
        m.includes("balance") ||
        m.includes("transferfailed") ||
        m.includes("fundsunavailable") ||
        m.includes("inability to pay") ||
        m.includes("storage deposit")
    );
}

function failureAction(message: string, fallback: string): string {
    const m = message.toLowerCase();
    // Timeout first: a DeadlineError (see deadline.ts) is a stalled connection,
    // NOT an on-chain failure — and retrying is safe because completed steps are
    // reused. Match before the balance/name buckets so it isn't misread as
    // "check your balance" (its message can otherwise fall through to fallback).
    if (m.includes("timed out")) {
        return "The connection stalled before this step finished. Your completed steps are saved, so just deploy again.";
    }
    if (
        m.includes("balance") ||
        m.includes("transferfailed") ||
        m.includes("fundsunavailable") ||
        m.includes("inability to pay") ||
        m.includes("storage deposit")
    ) {
        return "Add some test tokens to your account, then deploy again.";
    }
    if (m.includes("already registered") || m.includes("already taken")) {
        return "That name is taken. Pick another, then deploy again.";
    }
    if (m.includes("accountunmapped") || m.includes("mapping did not propagate")) {
        return "Your account is still finishing setup. Wait a moment, then deploy again.";
    }
    // Unknown cause: don't suggest a blind retry — point at the two things the
    // user can actually change (balance, name). Caller supplies the wording.
    return fallback;
}

// Shared centered modal shell — backdrop, titled header, close button. Used by
// the logs and name-rules dialogs so they stay visually consistent and
// on-screen (contained height, scrollable body).
function BuilderModal({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    return (
        <div
            className="builder-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={onClose}
        >
            <div className="builder-modal" onClick={(e) => e.stopPropagation()}>
                <div className="builder-modal-head">
                    <span className="builder-modal-title">{title}</span>
                    <button
                        type="button"
                        className="builder-modal-close"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        <X size={18} />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

// Contained modal holding the raw technical log (revert hex / dispatch JSON).
// Kept OUT of the inline result cards so the deploy panel stays short and
// on-screen; users open it only to copy logs for a developer.
function LogsModal({ text, onClose }: { text: string; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        if (await copyText(text)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
    };
    return (
        <BuilderModal title="Deploy logs" onClose={onClose}>
            <p className="hint subtle">
                Technical detail for debugging. Share this with a developer.
            </p>
            <pre className="logs-modal-body">{text}</pre>
            <button type="button" className="pill pill-wide" onClick={copy}>
                {copied ? "Copied" : "Copy logs"}
            </button>
        </BuilderModal>
    );
}

// Plain-language guide to .dot name rules. Most users never need it — the
// suggested name always works — but it's one tap away for anyone customizing.
function NameRulesModal({
    suggestion,
    onClose,
}: {
    suggestion: string | null;
    onClose: () => void;
}) {
    const example = suggestion ?? "mycoolsite42";
    return (
        <BuilderModal title="Choosing a .dot name" onClose={onClose}>
            <div className="name-rules">
                <p>
                    Your <code>.dot</code> name is the address people use to open
                    your site. It must be unique, and which names you can register
                    depends on how verified your account is.
                </p>
                <p>
                    <strong>The format that always works:</strong> at least 9
                    letters, ending in two digits, like{" "}
                    <code>{example}</code>. Any account can register a name in this
                    format, so the name we suggest already follows it.
                </p>
                <p>
                    <strong>Shorter or word-like names are reserved.</strong> Brief
                    names and real words (e.g. <code>shop</code>, <code>music</code>)
                    are held for accounts with higher verification, personhood or
                    governance level. If your account isn't verified for one, the
                    checklist will say so before you deploy.
                </p>
                <p className="name-rules-tip">
                    Not sure? Keep the suggested name. It's guaranteed to work.
                </p>
            </div>
        </BuilderModal>
    );
}

// Metadata panel shown when the user lists a deployed site in the Apps grid.
// Name + description arrive pre-filled (derived from the site) and editable. The
// category is fixed: every builder site is tagged "site", so no tag picker is
// shown. Icon and cover are auto-picked from an image already on the page at
// publish time — deliberately NOT surfaced here, to keep the panel minimal.
function ListInAppsModal({
    name,
    description,
    listing,
    status,
    onName,
    onDescription,
    onPublish,
    onClose,
}: {
    name: string;
    description: string;
    listing: boolean;
    status: string | null;
    onName: (v: string) => void;
    onDescription: (v: string) => void;
    onPublish: () => void;
    onClose: () => void;
}) {
    return (
        <BuilderModal title="List in Apps" onClose={onClose}>
            <div className="list-modal">
                <label className="field">
                    <span className="field-label">Name</span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => onName(e.target.value)}
                        disabled={listing}
                        maxLength={LISTING_NAME_MAX}
                    />
                </label>
                <label className="field">
                    <span className="field-label">Description</span>
                    <textarea
                        value={description}
                        onChange={(e) => onDescription(e.target.value)}
                        disabled={listing}
                        rows={3}
                        maxLength={LISTING_DESC_MAX}
                        placeholder="A short blurb shown on your app's page"
                    />
                </label>
                <button
                    type="button"
                    className="pill pill-primary pill-wide"
                    onClick={onPublish}
                    disabled={listing}
                >
                    {listing ? "Publishing…" : "Publish app"}
                </button>
                {listing && (
                    <>
                        <p className="status">
                            {status ?? "Adding your site to the app gallery…"}
                        </p>
                        <div className="progress-phone-hint" role="status">
                            📱 Check your phone. Approve to continue.
                        </div>
                    </>
                )}
            </div>
        </BuilderModal>
    );
}

// Inline SVG icons. Lightweight, no dep.
// Chrome icons — thin wrappers over lucide-react (the app's icon set; the
// previous hand-rolled SVGs were near-copies of these paths anyway), sized
// per surface: 14px action bar / undo satellites, 20px nav tabs.
function UndoIcon() {
    return <Undo2 size={14} aria-hidden="true" />;
}
function RedoIcon() {
    return <Redo2 size={14} aria-hidden="true" />;
}
function PaletteIcon() {
    return <Palette size={18} aria-hidden="true" />;
}
function CodeIcon() {
    return <Code size={14} aria-hidden="true" />;
}
function BackIcon() {
    // 16px inside the 32px back-float circle (nested in the code header bar).
    return <ArrowLeft size={16} aria-hidden="true" />;
}
function PencilIcon() {
    return <Pencil size={20} aria-hidden="true" />;
}
function EyeIcon() {
    return <Eye size={20} aria-hidden="true" />;
}
function RocketIcon() {
    return <Rocket size={20} aria-hidden="true" />;
}
