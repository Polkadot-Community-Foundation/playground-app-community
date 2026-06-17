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

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AtSign, Check, GitFork, Rocket, Star } from "lucide-react";
import {
  readOwnerAppCount,
  readUsername,
  registryReady,
  stringify,
} from "./utils";
import { readPointsSnapshot, writePointsSnapshot } from "./utils/snapshotCache";
import { readIdentityBonusClaimed } from "./utils/identityBonus";
import { withReadDeadline } from "./utils/deadline.ts";
import { XP_VALUES } from "./xpValues";
import XpLabel from "./XpLabel";

export interface PointBreakdown {
  total: bigint;
  launch_points: bigint;
  mod_points: bigint;
  star_points: bigint;
}

const ZERO: PointBreakdown = {
  total: 0n,
  launch_points: 0n,
  mod_points: 0n,
  star_points: 0n,
};

/**
 * Read get_point_breakdown(account) from the registry. Returns null on
 * any failure so callers can keep showing a cached value instead of
 * snapping back to zeros.
 */
export async function fetchPointBreakdown(account: string): Promise<PointBreakdown | null> {
  try {
    const registry = await registryReady;
    const res = await withReadDeadline(
      registry.getPointBreakdown.query(account as `0x${string}`),
      "Registry point breakdown",
    );
    if (!res.success) {
      console.warn(
        `[playground] registry.getPointBreakdown(${account}) returned success:false — ${stringify(res)}`,
      );
      return null;
    }
    return res.value;
  } catch (cause) {
    console.warn(
      `[playground] registry.getPointBreakdown(${account}) threw — ${stringify(cause)}`,
    );
    return null;
  }
}

interface PointsBreakdownProps {
  /** H160 of the account whose points to show. */
  account: string;
  /**
   * Increment to force a refresh. The parent bumps this when an award
   * event fires (via refreshLeaderboard wired into the registry event
   * dispatcher), so the points update live without polling.
   */
  refreshKey: number;
  /**
   * Whether the account has claimed a username — optimistic override from the
   * parent's username state so a just-claimed name unlocks the tile instantly
   * (the chain read below confirms on the next refresh).
   */
  hasUsername?: boolean;
  /**
   * Render the small dt/dd stat strip instead of the achievement cards.
   * Used by MyAppsWidget, where the container is too narrow for cards.
   * Skips the achievement-gate chain reads (only the breakdown is fetched).
   */
  compact?: boolean;
  /**
   * A username claim is in flight (optimistic, not yet confirmed). Paints the
   * Username tile unlocked and gives it a slow blink until the chain confirms.
   */
  usernamePending?: boolean;
}

interface PanelState {
  breakdown: PointBreakdown;
  /** get_owner_app_count — the deploy achievement gate. */
  deployed: boolean;
  /** get_username non-empty (works for arbitrary accounts, unlike the prop). */
  username: boolean;
  /**
   * Locally-recorded intro bonus (becoming a builder). The contract tracks this
   * in `identity_bonus_awarded` but exposes no getter, so the local flag is a
   * fast-path signal that the +25 XP was earned. See `utils/identityBonus`.
   */
  identityBonus: boolean;
}

const IDLE: PanelState = { breakdown: ZERO, deployed: false, username: false, identityBonus: false };

const MOD_XP = BigInt(XP_VALUES.modReceived);
const STAR_XP = BigInt(XP_VALUES.starReceived);
const USERNAME_XP = BigInt(XP_VALUES.identity);
const DEPLOY_XP = BigInt(XP_VALUES.deploy);
/** Only the first three deploys award XP — the cap for the progress pips. */
const DEPLOYS_REWARDED = 3;

/**
 * Each locked achievement links to the Playground journey card that satisfies
 * it (via the `?section=<id>` deep link honoured by PlaygroundTab's mount
 * effect). Unlocked tiles are not linked. `deployed` points at the simplest
 * first-deploy path, "Launch a .dot site".
 */
const JOURNEY_SECTION: Record<string, string> = {
  username: "username",
  deployed: "dot-site",
  modded: "get-modded",
  starred: "stars",
};

interface AchievementTileProps {
  id: string;
  title: string;
  Icon: typeof AtSign;
  unlocked: boolean;
  /** Cumulative count shown as ×N (mods, stars). */
  count?: bigint;
  /** Deploy progress 0..DEPLOYS_REWARDED — renders the pips row. */
  progress?: number;
  /** XP this source has earned — the aria-label figure when unlocked. */
  xp: bigint;
  /** XP on offer per the reward table — shown on the face while locked. */
  offer: number;
  /** How to earn it — the locked face's sans text line. */
  desc: string;
  /** Optimistic-but-unconfirmed — the tile blinks slowly until confirmed. */
  pending?: boolean;
}

/**
 * One achievement card. Every tile — locked or unlocked — is a shortcut into
 * the Playground journey card that earns it (the `?section=` deep link honoured
 * by PlaygroundTab on mount). A LOCKED card wears the XP on offer plus the
 * how-to-earn line on its face; an UNLOCKED card shows its check / ×count /
 * progress glyph instead. The `aria-label` carries the XP figure either way.
 */
function AchievementTile({
  id,
  title,
  Icon,
  unlocked,
  count,
  progress,
  xp,
  offer,
  desc,
  pending,
}: AchievementTileProps) {
  const xpLine = `+${unlocked ? xp.toString() : String(offer)} XP`;

  return (
    <Link
      className="achievement"
      to={`/?section=${JOURNEY_SECTION[id]}`}
      data-ach-hue={id}
      data-ach-state={unlocked ? "unlocked" : "locked"}
      data-ach-pending={pending ? "true" : undefined}
      data-testid={`ach-${id}`}
      aria-label={`${title}: ${xpLine}. ${desc}`}
    >
      <span className="achievement-icon-disc" aria-hidden="true">
        <Icon className="achievement-icon" size={26} strokeWidth={1.75} />
      </span>
      <span className="achievement-title">{title}</span>
      {/* The glyph (check / ×count / pips) carries the locked/unlocked
          state — never colour alone. */}
      {progress !== undefined ? (
        <span className="achievement-state achievement-state--progress">
          <span className="achievement-pips" aria-hidden="true">
            <i data-filled={progress >= 1} />
            <i data-filled={progress >= 2} />
            <i data-filled={progress >= 3} />
          </span>
          {progress} of {DEPLOYS_REWARDED}
        </span>
      ) : unlocked ? (
        <span className="achievement-state" aria-label="Unlocked">
          {count !== undefined && count > 0n ? (
            `×${count.toString()}`
          ) : (
            <Check size={20} strokeWidth={2.5} aria-hidden="true" />
          )}
        </span>
      ) : null}
      {!unlocked && (
        <span className="achievement-earn">
          <XpLabel amount={offer} />
          <span className="achievement-earn-text">{desc}</span>
        </span>
      )}
    </Link>
  );
}

/**
 * The profile's achievements panel: the Total XP hero plus one tile per
 * verifiable on-chain achievement. Reads only public getters keyed on
 * `account`, so it renders identically for the connected user and for any
 * profile reached via a leaderboard link — locked tiles dim and show a
 * how-to-earn hint; unlocked tiles take their category hue and show a
 * check/count plus the XP earned. All three reads land in ONE setState so
 * tiles light up in a single pass.
 *
 * Deploy XP is the residual (total − mod − star − username), which stays
 * correct under the suppression edge cases (dev-signer, blacklisted, 4th+
 * deploys) where `owner_app_count × DEPLOY_XP` would overstate. Since only the
 * first three deploys award XP (+100 each), residual ÷ 100 doubles as the "N
 * of 3" progress on the Deployed tile.
 */
export default function PointsBreakdown({ account, refreshKey, hasUsername, compact, usernamePending }: PointsBreakdownProps) {
  // Snapshot-first paint: seed the breakdown from the last persisted values
  // (lazy init so they land in the very first frame — no zero-flash), then
  // revalidate. The deployed/username gates aren't snapshotted; they only
  // gate the achievement cards and recompute cheaply on the live read.
  const [state, setState] = useState<PanelState>(() => {
    const snap = readPointsSnapshot(account);
    const identityBonus = readIdentityBonusClaimed(account);
    return snap
      ? { breakdown: snap, deployed: false, username: false, identityBonus }
      : { ...IDLE, identityBonus };
  });
  const [loading, setLoading] = useState(() => readPointsSnapshot(account) === null);

  useEffect(() => {
    let cancelled = false;
    // Account switch: paint its snapshot (or the skeleton on a cache miss)
    // while the fresh read is in flight. A refreshKey bump on the same
    // account re-reads its own last write — identical values, no flicker. The
    // intro-bonus flag is a synchronous local read (re-checked here so a
    // refreshKey bump after a just-claimed intro bonus unlocks the tile).
    const snap = readPointsSnapshot(account);
    const identityBonus = readIdentityBonusClaimed(account);
    setState(
      snap
        ? { breakdown: snap, deployed: false, username: false, identityBonus }
        : { ...IDLE, identityBonus },
    );
    setLoading(snap === null);
    void (async () => {
      if (compact) {
        const breakdown = await fetchPointBreakdown(account);
        if (cancelled) return;
        // A failed read keeps the cached paint.
        if (breakdown) {
          setState({ breakdown, deployed: false, username: false, identityBonus });
          writePointsSnapshot(account, breakdown);
        }
        setLoading(false);
        return;
      }
      // Same read helpers the task-progress hook uses; null (failed) → false.
      const [breakdown, deployed, username] = await Promise.all([
        fetchPointBreakdown(account),
        readOwnerAppCount(account).then((c) => (c ?? 0) > 0),
        readUsername(account).then((u) => u ?? false),
      ]);
      if (cancelled) return;
      // A failed breakdown read keeps the cached paint.
      setState((prev) => ({ breakdown: breakdown ?? prev.breakdown, deployed, username, identityBonus }));
      if (breakdown) writePointsSnapshot(account, breakdown);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [account, refreshKey, compact]);

  const { breakdown, deployed } = state;
  // The intro achievement is the one-time +25 XP for becoming a builder,
  // detected via the chain username read (state.username / hasUsername) or the
  // local intro-bonus fast-path flag before that read resolves.
  const identityEarned = state.username || !!hasUsername || state.identityBonus;
  const modCount = breakdown.mod_points;
  const starCount = breakdown.star_points;

  const modXp = modCount * MOD_XP;
  const starXp = starCount * STAR_XP;
  const usernameXp = identityEarned ? USERNAME_XP : 0n;
  // Residual; saturates at 0 in case of inconsistent reads.
  const carvedOut = modXp + starXp + usernameXp;
  const deployXp = breakdown.total > carvedOut ? breakdown.total - carvedOut : 0n;

  if (compact) {
    return (
      <div className="points-breakdown" data-testid="points-breakdown" data-loading={loading ? "true" : "false"}>
        <dl className="points-stat points-stat-total" data-testid="points-total">
          <dt className="points-stat-label">Total XP</dt>
          <dd className="points-stat-value">{breakdown.total.toString()}</dd>
        </dl>
        <dl className="points-stat" data-testid="points-username">
          <dt className="points-stat-label">Identity XP</dt>
          <dd className="points-stat-value">{usernameXp.toString()}</dd>
        </dl>
        <dl className="points-stat" data-testid="points-deploys">
          <dt className="points-stat-label">Deploy XP</dt>
          <dd className="points-stat-value">{deployXp.toString()}</dd>
        </dl>
        <dl className="points-stat" data-testid="points-mod">
          <dt className="points-stat-label">Mod XP</dt>
          <dd className="points-stat-value">{modXp.toString()}</dd>
        </dl>
        <dl className="points-stat" data-testid="points-star">
          <dt className="points-stat-label">Star XP</dt>
          <dd className="points-stat-value">{starXp.toString()}</dd>
        </dl>
      </div>
    );
  }

  const deploysComplete = Math.min(DEPLOYS_REWARDED, Number(deployXp / DEPLOY_XP));

  const tiles: AchievementTileProps[] = [
    {
      id: "username",
      title: "Become a builder",
      Icon: AtSign,
      // Earned by becoming a builder (the +25 XP lands with the bundled
      // set_identity). Paint unlocked optimistically while it's in flight; the
      // blink (data-ach-pending) signals it isn't confirmed yet.
      unlocked: identityEarned || !!usernamePending,
      pending: !!usernamePending,
      xp: usernameXp,
      offer: XP_VALUES.identity,
      desc: "Set up your verified builder identity",
    },
    {
      // A suppressed award (dev-signer / blacklisted recipient) can leave
      // `deployed` true with a 0 residual — the tile still unlocks, but "0 of
      // 3" never renders: at zero the tile shows its check (unlocked) or earn
      // hint.
      id: "deployed",
      title: "Deployed",
      Icon: Rocket,
      unlocked: deployed || deploysComplete > 0,
      progress: deploysComplete > 0 ? deploysComplete : undefined,
      xp: deployXp,
      offer: XP_VALUES.deploy,
      desc: "Deploy an app",
    },
    {
      id: "modded",
      title: "Modded by others",
      Icon: GitFork,
      unlocked: modCount > 0n,
      count: modCount,
      xp: modXp,
      offer: XP_VALUES.modReceived,
      desc: "Get your app modded",
    },
    {
      id: "starred",
      title: "Stars received",
      Icon: Star,
      unlocked: starCount > 0n,
      count: starCount,
      xp: starXp,
      offer: XP_VALUES.starReceived,
      desc: "Earn a star",
    },
  ];

  return (
    <div
      className="points-breakdown points-breakdown--cards"
      data-testid="points-breakdown"
      data-loading={loading ? "true" : "false"}
    >
      <dl className="points-stat points-stat-total" data-testid="points-total">
        <dt className="points-stat-label">Total XP</dt>
        <dd className="points-stat-value">{breakdown.total.toString()}</dd>
      </dl>
      <div className="achievements-grid">
        {tiles.map((tile) => (
          <AchievementTile key={tile.id} {...tile} />
        ))}
      </div>
    </div>
  );
}
