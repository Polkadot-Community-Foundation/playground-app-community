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
import { SENTRY_DSN, VERSION } from "./config.ts";

// `import.meta.env` is Vite-only — undefined when this file is imported from a
// Node script (tsx scripts/*.ts in CI / locally). Guard the access so scripts
// that transitively pull in this module don't crash on module load.
interface ViteEnv {
  VITE_SENTRY_TAG?: string;
  VITE_SENTRY_ENV?: string;
  VITE_VERSION?: string;
  MODE?: string;
  PROD?: boolean;
  DEV?: boolean;
}
const env: ViteEnv = (import.meta as { env?: ViteEnv }).env ?? {};

// DSN (SENTRY_DSN) comes from config.ts — injected at build time, empty by
// default. Empty disables Sentry (see the init guard below).

// VITE_SENTRY_TAG is set by Playwright (and any other synthetic-traffic
// runner) to label the run so production dashboards can filter via
// `!journey.tag:e2e-*`. Read once at module load — also attached to every
// JourneyTracker span via attributes (see journey-tracker.ts).
export const SENTRY_TAG: string | undefined = env.VITE_SENTRY_TAG || undefined;

// Strip leading filesystem path segments before they reach Sentry. Append
// patterns (Windows paths, API-key URLs) here as new PII shapes appear;
// never remove. Early-return is a hot-path optimisation — beforeSend runs
// per breadcrumb on every event.
const PATH_RE = /(\/Users|\/home)\/[^/\s"'`]+/g;
function scrubPaths(s: string): string {
  if (!s || (s.indexOf("/Users") < 0 && s.indexOf("/home") < 0)) return s;
  return s.replace(PATH_RE, "$1/<redacted>");
}

// Skip Sentry init in three cases:
//   1. No DSN — the default unless VITE_SENTRY_DSN is supplied at build time.
//   2. Non-browser context (Node scripts pulling this module in via the import
//      graph — `@sentry/react` is browser-only and there's no useful telemetry
//      to capture from a one-shot CLI invocation).
//   3. Local production-mode builds (`pnpm build:frontend` with no
//      VITE_VERSION). CI always sets VITE_VERSION; an unset value in a prod
//      build means someone is deploying a local bundle, and we don't want
//      those polluting the Sentry production stream with `playground-app@dev`
//      events that have no matching source maps. `pnpm dev` is unaffected
//      (env.DEV=true → init proceeds with the "dev" version tag).
const skipForLocalProdBuild = env.PROD && !env.VITE_VERSION;
if (SENTRY_DSN && typeof window !== "undefined" && !skipForLocalProdBuild) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `playground-app@${VERSION}`,
    integrations: [Sentry.browserTracingIntegration()],
    // Prod is the Web3 Summit demo — every page load + publish would be a
    // transaction; sample 10% there. Dev runs full-rate so local debugging
    // still shows everything.
    tracesSampleRate: env.PROD ? 0.1 : 1.0,
    // VITE_SENTRY_ENV is set by CI to distinguish prod / preview-<pr> / e2e.
    // Falls back to Vite's MODE ("production" | "development") for local.
    environment: env.VITE_SENTRY_ENV ?? env.MODE,
    beforeSend(event) {
      if (event.message) event.message = scrubPaths(event.message);
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = scrubPaths(ex.value);
      }
      for (const bc of event.breadcrumbs ?? []) {
        if (bc.message) bc.message = scrubPaths(bc.message);
      }
      return event;
    },
    beforeSendTransaction(event) {
      for (const span of event.spans ?? []) {
        for (const [k, v] of Object.entries(span.data ?? {})) {
          if (typeof v === "string") span.data![k] = scrubPaths(v);
        }
      }
      return event;
    },
  });

  // Set scope tag so every error event (not just span events) carries the
  // synthetic-traffic label. Without this, error issues from E2E runs are
  // indistinguishable from real user errors.
  if (SENTRY_TAG) Sentry.setTag("journey.tag", SENTRY_TAG);
} else if (skipForLocalProdBuild) {
  console.info(
    "[sentry] local production-mode build (VITE_VERSION unset) — Sentry disabled. CI sets VITE_VERSION; unset means a local `vite build` you don't want polluting prod Sentry.",
  );
} else if (env.DEV) {
  console.info("[sentry] VITE_SENTRY_DSN not set — Sentry disabled.");
}

// Note: Session Replay is intentionally NOT enabled. Playground is mobile-first
// for the Web3 Summit demo (4G constraints), surfaces account/PoP UI that may
// be sensitive, and adds ~50kB gzipped. Re-evaluate post-V1 with explicit privacy
// review and DOM-mask config.
