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
import { BreadcrumbCategory } from "./breadcrumb-categories.ts";
import { journeyTracker, type AppJourneyType } from "./journey-tracker.ts";

type Data = Record<string, unknown>;

export function addUiBreadcrumb(message: string, data?: Data): void {
  Sentry.addBreadcrumb({ category: BreadcrumbCategory.UI, message, level: "info", data });
}

export function addUserActionBreadcrumb(message: string, data?: Data): void {
  Sentry.addBreadcrumb({ category: BreadcrumbCategory.USER_ACTION, message, level: "info", data });
}

export function addAdminActionBreadcrumb(message: string, data?: Data): void {
  Sentry.addBreadcrumb({ category: BreadcrumbCategory.ADMIN_ACTION, message, level: "info", data });
}

/**
 * Synthetic Error class for app warnings.
 *
 * We emit warnings via `captureException` rather than `captureMessage` so
 * Sentry's event-metadata extractor populates `event.metadata.type` and
 * `event.metadata.value` (it only does that for events with an exception
 * payload — message events leave both fields empty, which breaks Slack/email
 * automation templates of the form `{metadata.type}: {metadata.value}`).
 *
 * Wrapping the message in a typed Error gives us:
 *   - `metadata.type`  = "AppWarning"          (the constructor's `name`)
 *   - `metadata.value` = the human-readable message
 * which is what most Sentry alert templates expect to see.
 */
class AppWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppWarning";
  }
}

/**
 * Record a non-fatal problem (transient retry, reconnection, fallback).
 * Pass `journey` to bump SAD on a specific in-flight journey, or omit to
 * mark every active journey — the typical case for cross-cutting issues
 * like a dropped websocket. Wrapped in try/catch so an SDK bug here never
 * aborts the caller.
 *
 * Note on stack traces: the captured Error is synthesized here, so the
 * stack-trace tab in Sentry will point at this function rather than the
 * caller. Sentry's fingerprint groups by error name + message, which is
 * what we want anyway — different warning messages should be different
 * issues. If you need finer-grained grouping, pass a per-call category
 * via `context.category` and configure a Sentry inbound-data fingerprint.
 */
export function captureWarning(
  message: string,
  context?: Data,
  journey?: AppJourneyType,
): void {
  try {
    // Mirror to the browser console too — Sentry round-trips can take a few
    // seconds to surface, and during development it's easier to see the
    // warning right where it fires. Context is stringified into the message
    // because some log consumers render object args as "[object Object]".
    const ctx = context && Object.keys(context).length
      ? ` ${safeStringify(context)}`
      : "";
    console.warn(`[playground] ${message}${ctx}`);
    Sentry.addBreadcrumb({ category: BreadcrumbCategory.WARNING, level: "warning", message, data: context });
    Sentry.captureException(new AppWarning(message), { level: "warning", extra: context });
    journeyTracker.markSad(journey);
  } catch {
    // Telemetry must never throw.
  }
}

// JSON.stringify with safe handling for BigInt / Uint8Array / Error so the
// console message round-trips structurally regardless of what's in `context`.
// Inlined here rather than imported from src/utils/diagnostics to avoid a
// telemetry → utils cycle (utils already imports from telemetry).
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return `<Uint8Array ${v.length}b>`;
      if (v instanceof Error) return { name: v.name, message: v.message };
      return v;
    });
  } catch {
    return String(value);
  }
}
