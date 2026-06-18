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

import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import XpLabel from "./XpLabel";
import LaptopRequiredFlag from "./LaptopRequiredFlag";
import { scrollToSection, useTaskProgress, useIsMobile } from "./utils";
import { fetchPointBreakdown } from "./PointsBreakdown";
import { readPointsSnapshot } from "./utils/snapshotCache";
import { QUEST_COLORS } from "./questPalette.ts";
import { XP_VALUES } from "./xpValues.ts";
import { captureWarning } from "./lib/telemetry";
import platformImg from "./assets/platform.png";
import hoverCharacter from "./assets/platform_hover_character.png";
import hoverPet from "./assets/platform_hover_pet.png";
import hoverUnderground from "./assets/platform_hover_underground.png";
import hoverLights from "./assets/platform_hover_lights.png";
import hoverStar from "./assets/platform_hover_star.png";
import hoverGates from "./assets/platform_hover_gates.png";
// Per-hotspot altered full-island art (same 1000×1090 canvas as platform.png, one
// per quest). When a quest completes, its hotspot crops its own region from the
// matching image and paints it at the same scale/position as the base island, so
// the patch registers exactly over where the hotspot sits.
import completeCharacter from "./assets/platform_character.png";
import completePet from "./assets/platform_pet.png";
import completeUnderground from "./assets/platform_underground.png";
import completeLights from "./assets/platform_lights.png";
import completeStar from "./assets/platform_star.png";
import completeGates from "./assets/platform_gates.png";

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

type XPSticker = {
  before?: string;
  amount: number;
  upTo?: boolean;
  after?: string;
};

// The single CTA shown under each card's description. Always scrolls down to the
// card's `anchor` instruction section (reusing the same deep-link the info button
// fires). The journey card it lands on owns any onward step — navigating to
// another tab or opening a flow — so every quest window CTA behaves identically.
type QuestCta = { text: string };

type QuestConfig = {
  id: string;
  step: number;
  // Down-page section to deep-link to from the window's info button. Keyed off
  // the card CONTENT (decoupled from `id` in the reorder), matching the journey
  // section ids in PlaygroundTab.tsx / PlaygroundToc.tsx.
  anchor: string;
  title: string;
  xp?: XPSticker;
  xp2?: XPSticker;
  // The quest's action needs RevX or the CLI — show the "Laptop required"
  // pill in the window. Passive quests (e.g. "Someone mods your app") and
  // phone-doable ones (site builder, stars, username) leave this unset.
  laptopRequired?: boolean;
  hoverImage: string;
  // Altered full-island art (1000×1090) cropped to this hotspot's region.
  // By default the crop is revealed when the quest is detected complete.
  completeImage: string;
  // Inverts the reveal: show the crop while the quest is INCOMPLETE and hide it
  // (base island shows through) once done. `character` works this way — it starts
  // as an un-built figure and "resolves" into the base art on completion.
  cropOnIncomplete?: boolean;
  // Keep this quest's text label pinned visible (not just on hover) until it is
  // detected complete — used to anchor a first-time visitor on step 1. After
  // completion it reverts to hover-only like every other label.
  pinLabelUntilComplete?: boolean;
  color: string;
  region: { top: string; left: string; width: string; height: string };
  circle: { top: string; left: string };
  label: { text: string; placement: "above" | "below" };
  // Optional override for where the window first opens. "center-right" pins it
  // vertically centred and 200px in from the right edge (default is a cascading
  // spawn anchored under the left rail).
  spawn?: "center-right";
  content: ReactNode;
  cta: QuestCta;
};

// Ordered so larger regions sit beneath smaller ones in the DOM —
// later-declared hotspots win pointer events when they overlap.
// Each entry is a FIXED island spot: `id`, `hoverImage`, `color`, `region`,
// `circle`, and `label.placement` are bound to the artwork and never move. The
// badge number (`step`) and card payload (`title`/`xp`/`label.text`/`content`)
// were resequenced independently, so e.g. `id: "star"` opens the .dot-site card.
const QUESTS: QuestConfig[] = [
  {
    id: "lights",
    step: 5,
    anchor: "stars",
    title: "Give and receive stars",
    xp: { before: "receive", amount: XP_VALUES.starReceived },
    hoverImage: hoverLights,
    completeImage: completeLights,
    color: QUEST_COLORS.lights,
    region: { top: "0%", left: "13%", width: "65%", height: "30%" },
    circle: { top: "22%", left: "78%" },
    label: { text: "Star Apps", placement: "below" },
    content: (
      <p className="ucard-sub">
        Give stars to vote for apps you enjoy.
        <br />
        The builder earns XP. Stars are unlimited, one per app, and permanent.
      </p>
    ),
    cta: { text: "Star apps" },
  },
  {
    id: "underground",
    step: 4,
    anchor: "mod",
    title: "Mod an app",
    // Modding IS a deploy — it pays the same DEPLOY_XP as any other publish,
    // on your first three deploys. This is the third deploy-quest card, so the
    // +100 pill is honest: three deploy cards × 100 = the 300 the contract
    // awards across an owner's first three deploys.
    xp: { amount: XP_VALUES.deploy },
    laptopRequired: true,
    hoverImage: hoverUnderground,
    completeImage: completeUnderground,
    color: QUEST_COLORS.underground,
    region: { top: "60%", left: "20%", width: "70%", height: "38%" },
    circle: { top: "78%", left: "55%" },
    label: { text: "Mod an app", placement: "above" },
    content: (
      <p className="ucard-sub">
        Pick a moddable app, change something, and deploy your version. Any of
        your first three deploys earns XP.
      </p>
    ),
    cta: { text: "Mod it" },
  },
  {
    id: "gates",
    step: 3,
    anchor: "tutorial",
    title: "Build your game",
    xp: { amount: XP_VALUES.deploy },
    laptopRequired: true,
    hoverImage: hoverGates,
    completeImage: completeGates,
    color: QUEST_COLORS.gates,
    region: { top: "0%", left: "44%", width: "30%", height: "40%" },
    circle: { top: "13%", left: "68%" },
    label: { text: "Build your game", placement: "above" },
    spawn: "center-right",
    content: (
      <>
        <dl className="ucard-stats">
          <div>
            <dt>Time</dt>
            <dd>~30m</dd>
          </div>
          <div>
            <dt>Difficulty</dt>
            <dd>easy → hard</dd>
          </div>
        </dl>
        <p className="ucard-sub">
          Build any game and learn how
          decentralised storage, unstoppable logic and player-owned assets
          change what digital experiences are made of. Or explore, mod, and
          deploy anything else. Any of your first three deploys earns the XP.
        </p>
      </>
    ),
    cta: { text: "Start" },
  },
  {
    id: "character",
    step: 1,
    anchor: "username",
    title: "Become a builder",
    xp: { amount: XP_VALUES.identity },
    hoverImage: hoverCharacter,
    completeImage: completeCharacter,
    cropOnIncomplete: true,
    color: QUEST_COLORS.character,
    pinLabelUntilComplete: true,
    region: { top: "31%", left: "28%", width: "16%", height: "24%" },
    circle: { top: "50%", left: "33%" },
    label: { text: "Become a builder", placement: "below" },
    content: (
      <p className="ucard-sub">
        Get set up to build. One quick approval and your verified name is how you'll appear on the leaderboard.
      </p>
    ),
    cta: { text: "Become a builder" },
  },
  {
    id: "star",
    step: 2,
    anchor: "dot-site",
    title: "Launch a .dot site",
    xp: { amount: XP_VALUES.deploy },
    hoverImage: hoverStar,
    completeImage: completeStar,
    color: QUEST_COLORS.star,
    region: { top: "32%", left: "44%", width: "18%", height: "14%" },
    circle: { top: "40%", left: "52%" },
    label: { text: "First .dot site", placement: "below" },
    content: (
      <p className="ucard-sub">
        Decentralise any existing page, or create and launch a new one. No code required.
      </p>
    ),
    cta: { text: "Launch on .dot" },
  },
  {
    id: "pet",
    step: 6,
    anchor: "get-modded",
    title: "Get your app modded",
    xp: { amount: XP_VALUES.modReceived },
    hoverImage: hoverPet,
    completeImage: completePet,
    // Like `character`: show the overlay art while INCOMPLETE and reveal the
    // base island underneath once the quest is done.
    cropOnIncomplete: true,
    color: QUEST_COLORS.pet,
    region: { top: "60%", left: "5%", width: "20%", height: "25%" },
    circle: { top: "80%", left: "19%" },
    label: { text: "App modded", placement: "below" },
    content: (
      <p className="ucard-sub">
        Earn XP for inspiring someone else.
        <br />
        Publish a moddable app and earn XP when someone builds on top of it.
      </p>
    ),
    cta: { text: "Learn how" },
  },
];

interface IslandPortalProps {
  /** H160 of the connected account, or undefined when not signed in. */
  account?: string;
  /** Bumped on point-award events so the live XP total re-fetches. */
  pointsRefresh?: number;
  /**
   * During the first-visit pre-hero intro: pin the island via a `top` offset on
   * `.row-island` so content scrolls up over it, then fade it out. Must use
   * `top` (not `fixed`/`sticky`), which would create a stacking context and
   * break the island's `mix-blend-mode: lighten`.
   */
  pinOnScroll?: boolean;
}

export default function IslandPortal({ account, pointsRefresh, pinOnScroll }: IslandPortalProps) {
  // Live XP total below the island. The contract awards absolute XP (no client
  // multiplier — June 2026 scoring rework), so get_point_breakdown().total is
  // displayed as-is. Seeded from the persisted snapshot (lazy init, so it's in
  // the first frame); stays 0 only when signed out or on a cold cache.
  const [xpTotal, setXpTotal] = useState<bigint>(
    () => (account ? readPointsSnapshot(account)?.total : undefined) ?? 0n,
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  // Report at most one broken-image event — onError can re-fire on re-render.
  const platformImgErrored = useRef(false);
  // The `.row-island` section, so the pre-hero intro can fake-pin it via `top`.
  const rowRef = useRef<HTMLElement>(null);

  // Per-quest completion, detection-only (no manual self-attest anywhere).
  // The XP total is sourced separately (snapshot-seeded state above) so the
  // badge never flashes 0 on a cold mount.
  const { questsDetected } = useTaskProgress(account, {
    pointsRefresh,
    connectedAccount: account,
  });
  // A check only animates in when a quest flips false→true live this session
  // — never replayed for snapshot-seeded checks on mount or account switch.
  const seededQuestsRef = useRef<{ acct?: string; quests: Record<string, boolean> } | null>(null);
  if (!seededQuestsRef.current || seededQuestsRef.current.acct !== account) {
    seededQuestsRef.current = { acct: account, quests: questsDetected };
  }
  const seededQuests = seededQuestsRef.current.quests;

  // Fetch the connected account's XP total on mount, on account switch, and
  // whenever a point-award event bumps pointsRefresh. Resets to 0 when signed
  // out. Mirrors the cancelled-flag guard used by PointsBreakdown.
  useEffect(() => {
    if (!account) {
      setXpTotal(0n);
      return;
    }
    let cancelled = false;
    // Seed from the persisted snapshot so the badge doesn't flash 0, then
    // revalidate; a failed read (null) keeps the last shown total.
    const snap = readPointsSnapshot(account);
    if (snap) setXpTotal(snap.total);
    fetchPointBreakdown(account).then((b) => {
      if (!cancelled && b) setXpTotal(b.total);
    });
    return () => {
      cancelled = true;
    };
  }, [account, pointsRefresh]);

  const openOrFocus = useCallback((id: string) => {
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveId(id);
  }, []);

  const close = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = prev.filter((w) => w !== id);
      setActiveId((current) => {
        if (next.length === 0) return null;
        if (current === id) return next[next.length - 1];
        return current;
      });
      return next;
    });
  }, []);

  // Scroll to the matching down-page journey section. On desktop the floating
  // window stays open (the user may want to keep it while reading the section);
  // on mobile the CTA additionally closes the bottom-sheet drawer (handled in
  // QuestWindow). Scrolls imperatively so clicking the same quest's CTA twice
  // keeps working.
  const goToSection = useCallback((anchor: string) => {
    scrollToSection(anchor);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(activeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, close]);

  // Pre-hero intro: pin the island via a `top` offset, then fade it out. The
  // fade goes on the children inside `.island-stage` + the sibling XP label —
  // never on `.island-stage` or an ancestor, which would isolate the blend
  // group and flash a box instead of melting into the grain.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const stage = row.querySelector(".island-stage");
    const fadeEls = [
      ...(stage ? Array.from(stage.children) : []),
      ...Array.from(row.querySelectorAll(".island-xp")),
    ] as HTMLElement[];
    const reset = () => {
      row.style.top = "";
      for (const el of fadeEls) el.style.opacity = "";
    };
    if (!pinOnScroll || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      reset();
      return;
    }
    let frame = 0;
    const apply = () => {
      frame = 0;
      const vh = window.innerHeight;
      const pinStart = vh * 0.4; // scroll at which the island locks in place
      const fadeStart = vh * 0.65; // a bit after the pin — fade begins
      const fadeEnd = vh * 1.1; // fully gone
      const y = window.scrollY;
      row.style.top = `${y <= pinStart ? 0 : y - pinStart}px`; // pin & keep pinned
      const opacity = 1 - clamp((y - fadeStart) / (fadeEnd - fadeStart), 0, 1);
      for (const el of fadeEls) {
        // Labels own their visibility via the `is-visible` class. Multiply the
        // intro fade by that class-driven base so a hidden label never gets
        // forced to opacity 1 by this inline style (which would override the
        // CSS `opacity: 0` and flash every label on first load). The one pinned
        // label still fades out with the island as you scroll.
        const base = el.classList.contains("island-label")
          ? el.classList.contains("is-visible")
            ? 1
            : 0
          : 1;
        el.style.opacity = String(opacity * base);
      }
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      reset();
    };
  }, [pinOnScroll]);

  const hoveredQuest = hoveredId
    ? QUESTS.find((q) => q.id === hoveredId) ?? null
    : null;
  const activeQuest = activeId
    ? QUESTS.find((q) => q.id === activeId) ?? null
    : null;
  const displayedQuest = hoveredQuest ?? activeQuest;

  return (
    <section className="row row-island" aria-label="Quest portal" ref={rowRef}>
      <div className="island-platform">
        <span className="island-stage">
          <img
            className="island-img island-img-default"
            src={platformImg}
            alt="Floating island platform"
            draggable={false}
            onError={(e) => {
              // platform.png is a bundled asset that's definitely deployed, so
              // a fired onError is a per-client load/decode failure (mobile
              // webview decode, CSP, interrupted fetch) — NOT a missing asset.
              // It also disambiguates the "island didn't show up" reports: if
              // users hit that but this never fires, the image loaded fine and
              // the cause is render/visibility (CSS), not loading. Guard so a
              // re-fired onError can't spam Sentry.
              if (platformImgErrored.current) return;
              platformImgErrored.current = true;
              const img = e.currentTarget;
              captureWarning("island.platform-image-failed", {
                src: platformImg,
                currentSrc: img.currentSrc,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                complete: img.complete,
              });
            }}
          />
          {/* key forces remount so the fade-in animation replays on quest change */}
          {displayedQuest && (
            <img
              key={displayedQuest.id}
              className="island-img island-img-hover is-visible"
              src={displayedQuest.hoverImage}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          )}
          {QUESTS.map((q) => (
            <QuestHotspot
              key={q.id}
              quest={q}
              isHovered={hoveredId === q.id}
              complete={!!questsDetected[q.id]}
              animateIn={!!questsDetected[q.id] && !seededQuests[q.id]}
              onHover={setHoveredId}
              onSelect={openOrFocus}
            />
          ))}
        </span>
        {/* Preload hover variants so first hover doesn't flash. */}
        <div className="island-preload" aria-hidden="true">
          {QUESTS.map((q) => (
            <img key={q.id} src={q.hoverImage} alt="" />
          ))}
        </div>
      </div>
      <div className="island-xp" aria-label="Experience points">
        <span className="island-xp-n">{(xpTotal ?? 0n).toString()}</span> XP
      </div>
      <div
        className={`island-scroll-hint${pinOnScroll ? "" : " is-visible"}`}
        aria-hidden="true"
      >
        <ChevronDown size={28} strokeWidth={1.5} />
      </div>

      {/* On mobile, only the active quest renders — as a bottom-sheet drawer
          whose backdrop covers the hotspots (so a second can't be opened
          underneath). Desktop renders every open window with its cascade. */}
      {openIds
        .filter((id) => !isMobile || id === activeId)
        .map((id, idx) => {
        const quest = QUESTS.find((q) => q.id === id);
        if (!quest) return null;
        return (
          <QuestWindow
            key={id}
            quest={quest}
            cascadeIndex={idx}
            asDrawer={isMobile}
            isActive={activeId === id}
            onActivate={() => setActiveId(id)}
            onClose={() => close(id)}
            onInfo={() => goToSection(quest.anchor)}
          />
        );
      })}
    </section>
  );
}

type QuestHotspotProps = {
  quest: QuestConfig;
  isHovered: boolean;
  /** Verified complete — a check replaces the step number on the badge. */
  complete: boolean;
  /** Completed live this session (not snapshot-seeded) — plays the pop-in. */
  animateIn: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
};

function QuestHotspot({
  quest,
  isHovered,
  complete,
  animateIn,
  onHover,
  onSelect,
}: QuestHotspotProps) {
  const hotspotStyle = {
    ...quest.region,
    "--quest-accent": quest.color,
  } as CSSProperties;
  // Crop geometry, percentage-only so it stays pixel-aligned with the base island
  // at every responsive width. The hotspot box is W%×H% of the stage; sizing the
  // background to 100/W × 100/H of the box renders the altered island at full stage
  // scale, and the position formula L/(100−W), T/(100−H) lines the crop up exactly
  // over the region behind it. See QUEST `region` defs above.
  const t = parseFloat(quest.region.top);
  const l = parseFloat(quest.region.left);
  const w = parseFloat(quest.region.width);
  const h = parseFloat(quest.region.height);
  const cropStyle: CSSProperties = {
    backgroundImage: `url(${quest.completeImage})`,
    backgroundSize: `calc(10000% / ${w}) calc(10000% / ${h})`,
    backgroundPosition: `${(l / (100 - w)) * 100}% ${(t / (100 - h)) * 100}%`,
  };
  // Default: reveal on completion. `cropOnIncomplete` quests (character) invert it.
  const showCrop = quest.cropOnIncomplete ? !complete : complete;
  // Labels are hover-only, except a `pinLabelUntilComplete` quest stays visible
  // at rest until it's done — anchors a first-time visitor on step 1.
  const labelVisible =
    isHovered || (!!quest.pinLabelUntilComplete && !complete);
  return (
    <>
      <button
        type="button"
        className="island-hotspot"
        style={hotspotStyle}
        aria-label={quest.title}
        onPointerEnter={() => onHover(quest.id)}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(quest.id)}
        onBlur={() => onHover(null)}
        onClick={() => onSelect(quest.id)}
      >
        {/* Lights up this patch of the island with the altered art (see `showCrop`
            — on completion by default, or while incomplete for cropOnIncomplete
            quests). Non-interactive; the button stays a transparent hit target.
            `is-live` plays the reveal on live completion. */}
        {showCrop && (
          <span
            className={`island-crop${animateIn ? " is-live" : ""}`}
            style={cropStyle}
            aria-hidden="true"
          />
        )}
      </button>
      <span
        className={`island-badge is-persistent${complete ? " is-complete" : ""}${animateIn ? " is-complete-live" : ""}`}
        style={{ ...quest.circle, background: quest.color }}
        aria-hidden="true"
      >
        {complete ? <Check size={14} strokeWidth={3.5} aria-hidden="true" /> : quest.step}
      </span>
      <span
        className={`island-label island-label-${quest.label.placement}${labelVisible ? " is-visible" : ""}`}
        style={{ ...quest.circle, color: quest.color }}
        aria-hidden="true"
      >
        {quest.label.text}
      </span>
    </>
  );
}

function XPGroup({ xp }: { xp: XPSticker }) {
  return (
    <span className="quest-window-xp">
      {xp.before && <span className="quest-window-xp-side">{xp.before}</span>}
      <XpLabel amount={xp.amount} upTo={xp.upTo} />
      {xp.after && <span className="quest-window-xp-side">{xp.after}</span>}
    </span>
  );
}

type QuestWindowProps = {
  quest: QuestConfig;
  cascadeIndex: number;
  /** Render as a bottom-sheet drawer with a dismissing backdrop (mobile). */
  asDrawer: boolean;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  onInfo: () => void;
};

function QuestWindow({
  quest,
  cascadeIndex,
  asDrawer,
  isActive,
  onActivate,
  onClose,
  onInfo,
}: QuestWindowProps) {
  const windowRef = useRef<HTMLDivElement | null>(null);
  // Lock cascade index at mount so closing earlier windows doesn't slide later ones.
  const [initialCascadeIndex] = useState(cascadeIndex);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const didCenterRef = useRef(false);

  useEffect(() => {
    const w = Math.min(420, window.innerWidth * 0.9);
    if (quest.spawn === "center-right") {
      // 200px gap from the right edge; vertically centred (provisional height —
      // refined once measured in the layout effect below).
      setPos({
        left: clamp(window.innerWidth - w - 200, 8, window.innerWidth - w - 8),
        top: clamp((window.innerHeight - 360) / 2, 8, window.innerHeight - 8),
      });
      return;
    }
    const isMobile = window.innerWidth <= 820;
    let baseX = 16;
    let baseY = 80;
    if (!isMobile) {
      const rail = document.querySelector(".left-rail");
      const items = rail?.querySelectorAll(".nav-item") ?? [];
      const lastItem = items[items.length - 1];
      if (rail) baseX = rail.getBoundingClientRect().left;
      if (lastItem) baseY = lastItem.getBoundingClientRect().bottom + 24;
    }
    const offset = initialCascadeIndex * 24;
    setPos({
      left: clamp(baseX + offset, 8, window.innerWidth - w - 8),
      top: clamp(baseY + offset, 8, window.innerHeight - 200),
    });
    // Mount-only — initialCascadeIndex is locked at mount so this never re-runs.
  }, [initialCascadeIndex, quest.spawn]);

  // For "center-right" windows, recentre vertically using the real measured
  // height once rendered. Runs before paint (no flash) and only once.
  useLayoutEffect(() => {
    if (quest.spawn !== "center-right" || didCenterRef.current) return;
    const el = windowRef.current;
    if (!el) return;
    didCenterRef.current = true;
    const h = el.offsetHeight;
    setPos((p) =>
      p
        ? { left: p.left, top: clamp((window.innerHeight - h) / 2, 8, window.innerHeight - h - 8) }
        : p,
    );
  }, [pos, quest.spawn]);

  const dragState = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    pointerId: number;
    dragging: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (
      (e.target as HTMLElement).closest(".quest-window-close")
    )
      return;
    const el = windowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      pointerId: e.pointerId,
      dragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const s = dragState.current;
    const el = windowRef.current;
    if (!s || !el) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    // Only treat as a drag once the pointer clears a small threshold, so a
    // fumbled close tap (or finger jitter on touch) never nudges the window.
    if (!s.dragging) {
      if (Math.hypot(dx, dy) <= 5) return;
      s.dragging = true;
      e.currentTarget.classList.add("is-dragging");
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const nx = clamp(s.originLeft + dx, 4, window.innerWidth - w - 4);
    const ny = clamp(s.originTop + dy, 4, window.innerHeight - h - 4);
    setPos({ left: nx, top: ny });
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    const s = dragState.current;
    if (!s) return;
    s.dragging = false;
    e.currentTarget.classList.remove("is-dragging");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // XP stickers + info/close controls — identical in both modes.
  const headerControls = (
    <>
      {quest.xp && <XPGroup xp={quest.xp} />}
      {quest.xp2 && <XPGroup xp={quest.xp2} />}
      {!quest.xp && !quest.xp2 && (
        <span
          className="quest-window-xp quest-window-xp--ghost"
          aria-hidden="true"
        >
          <XpLabel amount={50} />
        </span>
      )}
      <button
        type="button"
        className="quest-window-close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        aria-label="Close"
      >
        ×
      </button>
    </>
  );

  // On mobile (drawer), a CTA tap also dismisses the sheet; on desktop the
  // window stays open so the user can keep it while reading the section.
  const body = (
    <div className="quest-window-body">
      <h3 className="ucard-title">{quest.title}</h3>
      {quest.laptopRequired && <LaptopRequiredFlag />}
      {quest.content}
      <button
        type="button"
        className="ucard-cta"
        onClick={() => {
          onInfo();
          if (asDrawer) onClose();
        }}
      >
        {quest.cta.text} <span aria-hidden="true">→</span>
      </button>
    </div>
  );

  // Mobile: bottom-sheet drawer with a dismissing backdrop. No drag, no cascade
  // positioning — the overlay tap closes this (the corresponding) window.
  if (asDrawer) {
    return createPortal(
      <div className="quest-drawer-overlay" onClick={onClose}>
        <div
          className="quest-window quest-window--drawer is-active"
          style={{ "--quest-accent": quest.color } as CSSProperties}
          role="dialog"
          aria-label={quest.title}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="quest-window-head">
            <span className="quest-window-grip" aria-hidden="true">⠿⠿</span>
            {headerControls}
          </header>
          {body}
        </div>
      </div>,
      document.body,
    );
  }

  if (!pos) return null;

  const style = {
    left: pos.left,
    top: pos.top,
    "--quest-accent": quest.color,
  } as CSSProperties;

  return createPortal(
    <div
      ref={windowRef}
      className={`quest-window${isActive ? " is-active" : ""}`}
      style={style}
      role="dialog"
      aria-label={quest.title}
      onPointerDownCapture={onActivate}
    >
      <header
        className="quest-window-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <span className="quest-window-grip" aria-hidden="true">⠿⠿</span>
        {headerControls}
      </header>
      {body}
    </div>,
    document.body,
  );
}
