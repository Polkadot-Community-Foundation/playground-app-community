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

import { Check } from "lucide-react";

export type ResourceStatus = "idle" | "loading" | "cancelled";

interface Props {
  resourceStatus: ResourceStatus;
  /** Mobile = the approval surfaces on this same device; desktop/web = on the
   *  user's paired phone. Drives the only cross-device copy in the flow. */
  isMobile: boolean;
  /** Become a builder: one approval that binds the verified identity and
   *  provisions network resources (bundled at the contract level). */
  onBecomeBuilder: () => void;
  onClose: () => void;
}

const RESOURCE_BULLETS = [
  "Publish your apps to a .dot site",
  "Keep them online on decentralised storage, no servers to run",
  "Star apps and reward their builders",
];

/**
 * The single, focused "Become a builder" modal. One dismissible shell (NOT a
 * full-screen takeover) with a single approval: becoming a builder binds the
 * user's verified identity AND provisions network resources in one bundled
 * contract call, so there is no separate "claim a handle" step and no
 * anonymous choice — it just happens in the background. Same flow regardless of
 * entry point (Playground journey, Apps banner, Profile button, locked nudge,
 * the CLI hand-off route).
 */
export default function BecomeBuilderModal({
  resourceStatus,
  isMobile,
  onBecomeBuilder,
  onClose,
}: Props) {
  const loading = resourceStatus === "loading";
  const ctaLabel = loading
    ? isMobile
      ? "Waiting for approval…"
      : "Waiting for approval on your phone…"
    : "Become a builder";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal--onboarding"
        onClick={(e) => e.stopPropagation()}
        data-testid="become-builder-modal"
      >
        <header className="modal-head">
          <h2 className="modal-head-title">Enter the competition</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
            data-testid="become-builder-close"
          >
            ×
          </button>
        </header>

        <p className="modal-lead">
          Become a builder to enter the competition. One approval sets you up
          to publish, star, and mod. Nothing to buy.
        </p>

        <p className="onboarding-bullets-intro">With this you'll be able to:</p>
        <ul className="onboarding-bullets">
          {RESOURCE_BULLETS.map((b) => (
            <li key={b}>
              <Check size={16} strokeWidth={3} aria-hidden="true" />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <div className="modal-actions modal-actions--single">
          <button
            className="btn btn-publish btn-hover-blue onboarding-cta"
            onClick={onBecomeBuilder}
            disabled={loading}
            aria-busy={loading}
            data-testid="get-resources-btn"
          >
            {ctaLabel}
          </button>
          {/* Cross-device note: desktop/web approve on the paired phone. On
              mobile the prompt is on this device, so the line is omitted. */}
          {!isMobile && (
            <p className="onboarding-approve-note" data-testid="approve-on-phone">
              You'll approve this on your phone.
            </p>
          )}
          {resourceStatus === "cancelled" && (
            <p
              className="onboarding-cancelled"
              role="status"
              data-testid="resources-cancelled"
            >
              Approval cancelled, try again.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
