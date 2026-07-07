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

import * as Sentry from "@sentry/react";
import { SENTRY_TAG } from "../../sentry.ts";
import { isExpectedError } from "./expected-errors.ts";

export type AppJourneyType =
  | "page-load"
  | "authenticate"
  | "publish"
  | "star-app";

export const APP_JOURNEY_OPS: Record<AppJourneyType, string> = {
  "page-load": "journey.page-load",
  "authenticate": "journey.authenticate",
  "publish": "journey.publish",
  "star-app": "journey.star-app",
};

interface ActiveJourney<T> {
  type: T;
  startedAt: number;
  milestones: Map<string, number>;
  attributes: Record<string, string | number | boolean>;
}

export class JourneyTracker<T extends string> {
  private active = new Map<T, ActiveJourney<T>>();
  private spanOps: Record<T, string>;

  constructor(spanOps: Record<T, string>) {
    this.spanOps = spanOps;
  }

  start(
    type: T,
    attributes: Record<string, string | number | boolean> = {},
    startedAt?: number,
  ): void {
    // Spread caller attributes first, then defaults — the SAD% widget query
    // (count_if(journey.sad,equals,true) / count()) needs `journey.sad` on
    // every span to compute a valid ratio, so callers can't accidentally
    // unset it.
    const initial: Record<string, string | number | boolean> = {
      ...attributes,
      "journey.sad": "false",
    };
    if (SENTRY_TAG) initial["journey.tag"] = SENTRY_TAG;
    this.active.set(type, {
      type,
      startedAt: startedAt ?? performance.now(),
      milestones: new Map(),
      attributes: initial,
    });
    if (import.meta.env.DEV) console.info(`[Journey:${type}] started`);
  }

  /**
   * Flip `journey.sad` to "true" for one in-flight journey, or all of
   * them when `type` is omitted (cross-cutting friction events). Used by
   * captureWarning() so transient retries / reconnections show up in the
   * SAD% metric without affecting hard-failure rates.
   */
  markSad(type?: T): void {
    if (type === undefined) {
      for (const j of this.active.values()) j.attributes["journey.sad"] = "true";
      return;
    }
    const j = this.active.get(type);
    if (j) j.attributes["journey.sad"] = "true";
  }

  milestone(type: T, name: string): void {
    const journey = this.active.get(type);
    if (!journey) return;
    if (journey.milestones.has(name)) return;
    const elapsed = performance.now() - journey.startedAt;
    journey.milestones.set(name, elapsed);
    if (import.meta.env.DEV) console.info(`[Journey:${type}] ${name} +${elapsed.toFixed(0)}ms`);
  }

  addAttributes(
    type: T,
    attrs: Record<string, string | number | boolean>,
  ): void {
    const journey = this.active.get(type);
    if (!journey) return;
    Object.assign(journey.attributes, attrs);
  }

  complete(type: T): void {
    const journey = this.active.get(type);
    if (!journey) return;
    this.active.delete(type);

    this.emitSpan(journey, type, { code: 1, message: "ok" });

    // Phase spans render the milestone waterfall in Sentry's trace view; the
    // duplicate per-milestone attributes on the main span don't.
    const op = this.spanOps[type];
    const phaseOp = `${op}.phase`;
    const startTime = (performance.timeOrigin + journey.startedAt) / 1000;
    const milestoneEntries = [...journey.milestones.entries()].sort(
      (a, b) => a[1] - b[1],
    );

    for (const [name, elapsed] of milestoneEntries) {
      const phaseSpan = Sentry.startSpanManual(
        { name, op: phaseOp, attributes: { "journey.type": type }, startTime },
        (s) => s,
      );
      phaseSpan.setStatus({ code: 1, message: "ok" });
      phaseSpan.end(
        (performance.timeOrigin + journey.startedAt + elapsed) / 1000,
      );
    }

    const totalMs = performance.now() - journey.startedAt;
    if (import.meta.env.DEV) console.info(`[Journey:${type}] completed in ${totalMs.toFixed(0)}ms`);
  }

  /**
   * Record a journey failure.
   *
   * `reason` is a short, human-readable label suitable for dashboard
   * grouping (e.g. `"bulletin-failed"`). `error` is the underlying
   * exception used to classify expected vs unexpected — pass it whenever
   * available so user-input errors (AccountUnmapped, AlreadyExists) don't
   * inflate the unexpected-failure rate.
   */
  fail(type: T, reason?: string, error?: unknown): void {
    const journey = this.active.get(type);
    if (!journey) return;
    this.active.delete(type);

    const resolvedReason = reason ?? "unknown";
    // The journey didn't complete cleanly — sad regardless of cause. The
    // expected/unexpected split lets dashboards separate user-input errors
    // (AccountUnmapped, AlreadyExists) from actual bugs.
    journey.attributes["journey.sad"] = "true";
    journey.attributes["journey.status"] = "error";
    journey.attributes["journey.error"] = resolvedReason.slice(0, 200);
    journey.attributes["journey.expected"] = isExpectedError(error ?? resolvedReason)
      ? "true"
      : "false";

    this.emitSpan(
      journey,
      type,
      { code: 2, message: resolvedReason },
      resolvedReason,
    );

    const totalMs = performance.now() - journey.startedAt;
    if (import.meta.env.DEV) {
      console.info(
        `[Journey:${type}] failed after ${totalMs.toFixed(0)}ms: ${resolvedReason}`,
      );
    }
  }

  abandon(type: T): void {
    if (this.active.has(type)) {
      if (import.meta.env.DEV) console.info(`[Journey:${type}] abandoned`);
      this.active.delete(type);
    }
  }

  isActive(type: T): boolean {
    return this.active.has(type);
  }

  private emitSpan(
    journey: ActiveJourney<T>,
    type: T,
    status: { code: 0 | 1 | 2; message: string },
    failureReason?: string,
  ): void {
    const totalMs = performance.now() - journey.startedAt;

    const attributes: Record<string, string | number | boolean> = {
      "journey.type": type,
      "journey.duration_ms": Math.round(totalMs),
      ...journey.attributes,
    };
    if (failureReason) {
      attributes["journey.failure_reason"] = failureReason;
    }
    for (const [name, elapsed] of journey.milestones) {
      attributes[`journey.milestone.${name}_ms`] = Math.round(elapsed);
    }

    const op = this.spanOps[type];
    const startTime = (performance.timeOrigin + journey.startedAt) / 1000;
    const endTime = (performance.timeOrigin + performance.now()) / 1000;

    const span = Sentry.startSpanManual(
      { name: `journey:${type}`, op, attributes, startTime },
      (s) => s,
    );
    span.setStatus(status);
    span.end(endTime);
  }
}

export const journeyTracker = new JourneyTracker<AppJourneyType>(
  APP_JOURNEY_OPS,
);
