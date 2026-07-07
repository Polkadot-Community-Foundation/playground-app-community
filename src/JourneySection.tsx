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

import { useRef, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import XpLabel from "./XpLabel";
import { useSectionDisclosure } from "./utils";

type Reward = { amount: number; upTo?: boolean; condition?: string };
/** Navigate (`to`) or run an action (`onClick`) — mutually exclusive. */
type Cta = { label: string; to: string } | { label: string; onClick: () => void };

type Props = {
  /** Anchor target — the TOC and scroll-on-mount jump to this. */
  id: string;
  title: string;
  /** XP rewards; the `+N XP` sits in its label, the condition beside it. */
  rewards?: Reward[];
  /** Leading line; larger, primary-colour. Sits above the description. */
  lede?: ReactNode;
  description?: ReactNode;
  /** Instruction body (tabs, steps, guidance). */
  children?: ReactNode;
  cta?: Cta;
  /** Optional secondary action, rendered beside the primary cta as a quieter
   *  ghost button (e.g. "Introduce yourself" next to "Collect more resources"). */
  secondaryCta?: Cta;
  /** Plain variant for "Where next" — no card chrome, never collapsible. */
  plain?: boolean;
  /** Quest colour for this step; tints the XP label, code commands, and links. */
  hue?: string;
  /**
   * Task completion. When set the card is collapsible: a check chip joins the
   * title and the body folds — collapsed by default iff complete AT MOUNT
   * (see useSectionDisclosure for the mid-session and re-open rules).
   */
  complete?: boolean;
  /**
   * Gated behind the build gate (no network resources yet). A gated card is a
   * normal collapsible card that simply starts folded and never takes the
   * active-quest wash — it is NOT blocked: the caret expands it like any other.
   * On unlock, PlaygroundTab auto-expands the incomplete gated cards once.
   */
  gated?: boolean;
};

/**
 * One step of the Playground journey: a titled, anchorable section with
 * optional XP rewards, a short description, instructions, and a CTA.
 */
export default function JourneySection({
  id,
  title,
  rewards,
  lede,
  description,
  children,
  cta,
  secondaryCta,
  plain,
  hue,
  complete,
  gated,
}: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const collapsible = complete !== undefined && !plain;
  // Gated steps (build gate not yet open) and completed steps start folded.
  const { open, toggle } = useSectionDisclosure(
    id,
    collapsible && (!!complete || !!gated),
  );
  const collapsedBody = collapsible && !open;
  const folded = collapsedBody;
  // The active, actionable step gets a soft hue wash + accent edge — applied to
  // any incomplete, ungated quest, the become-a-builder card included.
  const activeQuest = !plain && !gated && complete === false;

  // Primary CTAs take the filled button; a secondary takes a quieter ghost
  // style. Both honour the navigate (`to`) vs action (`onClick`) split and
  // stopPropagation so a CTA on a folded card doesn't also expand the section.
  const renderCta = (c: Cta, variant: "primary" | "secondary") => {
    const className =
      variant === "primary"
        ? "btn-primary journey-cta"
        : "btn btn-ghost journey-cta journey-cta--secondary";
    return "to" in c ? (
      <Link className={className} to={c.to}>
        {c.label}
      </Link>
    ) : (
      <button
        type="button"
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          c.onClick();
        }}
      >
        {c.label}
      </button>
    );
  };

  const body = (
    <>
      {lede && <p className="xp-prizes-lede">{lede}</p>}
      {description && <p className="journey-section-desc">{description}</p>}
      {children}
      {(cta || secondaryCta) && (
        <div className="journey-cta-row">
          {cta && renderCta(cta, "primary")}
          {secondaryCta && renderCta(secondaryCta, "secondary")}
        </div>
      )}
    </>
  );

  return (
    <section
      ref={sectionRef}
      id={id}
      className={`journey-section${plain ? " journey-section--plain" : ""}${folded ? " is-folded" : ""}${activeQuest ? " is-active-quest" : ""}`}
      style={hue ? ({ "--journey-hue": hue } as CSSProperties) : undefined}
      aria-labelledby={`${id}-title`}
      // A folded card opens on a click anywhere; the handler is absent when
      // open, so the caret stays the only COLLAPSE control and keyboard users
      // have its button — the section needs no role/tabindex.
      onClick={collapsible && folded ? toggle : undefined}
    >
      <div className="journey-section-head">
        {/* Title + rewards flow inline and wrap only on overflow; the caret
            stays pinned to the right of the title line. */}
        <div className="journey-section-heading">
          <h2 id={`${id}-title`} className="journey-section-title">
            {title}
            {complete && (
              <span className="journey-check" role="img" aria-label="Completed">
                <Check size={15} strokeWidth={3} aria-hidden="true" />
              </span>
            )}
          </h2>
          {rewards && rewards.length > 0 && (
            <div className="journey-section-rewards">
              {rewards.map((r) => (
                <span key={r.condition ?? r.amount} className="journey-reward">
                  <XpLabel amount={r.amount} upTo={r.upTo} />
                  {r.condition && <span className="xp-note">{r.condition}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
        {collapsible && (
          <button
            type="button"
            className="journey-caret"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            aria-label={open ? "Collapse section" : "Expand section"}
            // stopPropagation: on a folded card the section's own click
            // handler would re-toggle the bubbled event and snap it shut.
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            <ChevronDown
              className={`journey-chevron${open ? " is-open" : ""}`}
              size={20}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {collapsible ? (
        <div
          id={`${id}-body`}
          className={`journey-section-body${collapsedBody ? " is-collapsed" : ""}`}
        >
          <div className="journey-section-body-inner" inert={collapsedBody || undefined}>
            {body}
          </div>
        </div>
      ) : (
        body
      )}
    </section>
  );
}
