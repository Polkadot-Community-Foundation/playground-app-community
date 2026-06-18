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

import { configure, type LogLevel } from "@parity/product-sdk-logger";
import * as Sentry from "@sentry/react";
import { stringify } from "../utils/stringify.ts";
import { isSigningRejection } from "./telemetry";

type SentryLevel = "error" | "warning" | "info" | "debug";

// The host shell's console wrapper (Polkadot Desktop, the test fixture)
// coerces object args with String(), so the default `console.error("[ns]",
// msg, data)` prints `[object Object]`. Route data through our stringify()
// to keep bigints / byte arrays / Error own-props / circular refs readable.

const SENTRY_LEVEL: Record<LogLevel, SentryLevel> = {
  error: "error",
  warn: "warning",
  info: "info",
  debug: "debug",
};

// `@parity/product-sdk-tx` calls `log.error("Transaction subscription error",
// { error: "Rejected" })` BEFORE classifying — drop the level when it's
// just a user cancellation. The canonical rejection signal still surfaces
// via runTx + the call site. Wrap data.error in a synthetic Error so the
// upstream rejection classifier handles all the message variants the SDK
// recognises (cancelled / rejected / denied / user refused), instead of
// pattern-matching here.
function isLibraryUserRejection(namespace: string, data: unknown): boolean {
  if (namespace !== "tx") return false;
  const err = (data as { error?: unknown } | null)?.error;
  if (typeof err !== "string") return false;
  return isSigningRejection(new Error(err));
}

// The host signer logs these at `error` on every cold auto-connect (the
// module-load `signerManager.connect()` races the host handshake). Demote to
// `warn` so they stay queryable as warnings + breadcrumbs but drop out of the
// error stream and don't trip error alerts. Mirrors the `tx` user-rejection
// demotion above.
const EXPECTED_SIGNER_HOST_NOISE = new Set([
  "failed to get product account",
  "failed to get accounts from host",
  "host returned no accounts",
]);
function isExpectedSignerHostNoise(namespace: string, message: string): boolean {
  return namespace === "signer:host" && EXPECTED_SIGNER_HOST_NOISE.has(message);
}

configure({
  handler: ({ level, namespace, message, data }) => {
    const effective: LogLevel = isLibraryUserRejection(namespace, data)
      ? "debug"
      : isExpectedSignerHostNoise(namespace, message) && level === "error"
        ? "warn"
        : level;
    const isLoud = effective === "error" || effective === "warn";

    const prefix = `[${namespace}]`;
    // stringify() walks Error own-props + handles bigints/circular refs —
    // worth it for warn/error where we render readably; pass-through for
    // debug/info to skip the JSON.stringify allocation on hot paths.
    const args = data === undefined
      ? [prefix, message]
      : [prefix, message, isLoud ? stringify(data) : data];
    console[effective](...args);

    Sentry.addBreadcrumb({
      category: `polkadot-apps:${namespace}`,
      message,
      level: SENTRY_LEVEL[effective],
      data: data as Record<string, unknown> | undefined,
    });

    // Skip the standalone event for `tx` errors — runTx + call-site
    // captureException already record those, so capturing here would
    // duplicate every tx failure into Sentry.
    if (isLoud && namespace !== "tx") {
      // The SDK attaches the underlying failure as `data.cause`. When it's a
      // real Error, capture IT as the exception so Sentry records a stacktrace,
      // groups the issue by the actual failure (host-rejected vs derive vs
      // disconnected), and Seer can analyse it — instead of collapsing every
      // reason under one static `captureMessage` string. The cause message is
      // also lifted into an indexed tag so the root-cause distribution is
      // filterable/aggregatable in search (`extra` is neither). Truncated to
      // stay under Sentry's 200-char tag limit.
      const cause = (data as { cause?: unknown } | undefined)?.cause;
      const ctx = {
        level: SENTRY_LEVEL[effective],
        extra: data as Record<string, unknown> | undefined,
        tags: {
          source: "polkadot-apps",
          namespace,
          ...(cause instanceof Error
            ? { cause: cause.message.slice(0, 200) }
            : {}),
        },
      };
      if (cause instanceof Error) {
        Sentry.captureException(cause, ctx);
      } else {
        Sentry.captureMessage(`[${namespace}] ${message}`, ctx);
      }
    }
  },
});
