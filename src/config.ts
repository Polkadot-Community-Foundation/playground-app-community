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

// `import.meta.env` is Vite-only — undefined when this file is imported from a
// Node script (tsx scripts/*.ts in CI). Guard the access so scripts that only
// need CHAIN / ENVIRONMENT don't crash on module load.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Networks this build can target. Both have a full descriptor set
 *  (asset-hub + bulletin + individuality) wired through the Product SDK, and
 *  `CloudStorageClient` only knows these two — so this is the usable universe,
 *  NOT the SDK's wider "polkadot" | "kusama" | "paseo" | "summit". */
export const ENVIRONMENTS = ["paseo", "summit"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Single source of truth for which network the whole app targets — Asset Hub,
 *  Bulletin, and the People chain move together. Set at BUILD time via
 *  VITE_ENVIRONMENT (Vite inlines it). Unset (local dev, tsx scripts, current
 *  CI) → "summit" — this is a Summit-only fork, so the default never targets
 *  Paseo. An explicitly-set unknown value is a build-config mistake and throws
 *  loudly here rather than silently shipping the wrong chain — caught at build /
 *  preview / smoke-test, never in prod. */
function resolveEnvironment(): Environment {
  const raw = env.VITE_ENVIRONMENT?.trim().toLowerCase();
  if (!raw) return "summit";
  if ((ENVIRONMENTS as readonly string[]).includes(raw)) return raw as Environment;
  throw new Error(
    `VITE_ENVIRONMENT="${env.VITE_ENVIRONMENT}" is not a supported network. ` +
      `Use one of: ${ENVIRONMENTS.join(", ")}.`,
  );
}
export const ENVIRONMENT: Environment = resolveEnvironment();
// Back-compat alias: existing imports of CHAIN keep working.
export const CHAIN = ENVIRONMENT;

// Set at build time by CI workflows. Falls back to "dev" for local builds
// where pnpm dev / pnpm build:frontend runs without these env vars.
export const VERSION = env.VITE_VERSION ?? "dev";
export const BUILD_TIME = env.VITE_BUILD_TIME ?? "";

// Sentry DSN, injected at build time via VITE_SENTRY_DSN (CI reads it from the
// SENTRY_DSN GitHub Actions secret). UNSET is the default and disables Sentry
// entirely — local dev/builds run without it unless set in .env.local. The DSN
// is public-safe (send-only) but kept out of the source tree so it isn't
// embedded in published code. See src/sentry.ts for the init guard.
export const SENTRY_DSN = env.VITE_SENTRY_DSN ?? "";

// Base URL for the revX editor. Override per environment via VITE_REVX_URL.
// Trailing slash is stripped so the value can be used as `${REVX_URL}/path`.
export const REVX_URL = (env.VITE_REVX_URL ?? "https://stg.revx.dev").replace(/\/$/, "");

// Polkadot developer documentation. Linked from the Playground "Where next"
// section and the site footer. Override per environment via VITE_DOCS_URL.
export const DOCS_URL = (env.VITE_DOCS_URL ?? "https://docs.polkadot.com/").replace(/\/$/, "");

// Canonical public host for share links. Used instead of window.location.href
// so a link copied from Polkadot Desktop, from a localhost dev session, or
// from a PR-preview .dot.li gateway still resolves in any web2 browser.
// Override per environment via VITE_PLAYGROUND_URL.
export const PLAYGROUND_URL = (env.VITE_PLAYGROUND_URL ?? "https://playground.dot.li").replace(/\/$/, "");

// DotNS identifier the host derives this app's product account from.
//
// Polkadot Desktop registers each product under its URL. signPayload enforces
// account[0] === identifier strictly, so the value we send must match what the
// host derived from the running URL:
//   localhost          → host:port (e.g. "localhost:5173")
//   <name>.dot.li      → "<name>.dot" (Bulletin gateway, incl. PR previews)
//   <name>.app.paseo.li → "<name>.dot" (current gateway hosts serve from —
//                         hosts derive the identifier from the .dot name, so
//                         an unrecognized hostname here falls back to
//                         "playground.dot" and every host-signed tx is
//                         rejected: PermissionDenied on Desktop, a silent
//                         hang at signing on mobile/web)
//   <name>.dot         → "<name>.dot" (direct Polkadot Browser navigation)
//
// Localhost support requires Polkadot Desktop v0.3.2-rc-2+ (PR #404, which
// added isProductIdentifier alongside isDotDomain). On older Desktops
// localhost product accounts always fail.
//
// Override via VITE_PLAYGROUND_DOTNS_ID for non-default deploy targets.
function defaultDotNsId(): string {
  if (typeof window === "undefined") return "playground.dot";
  const host = window.location.hostname;
  if (host === "localhost") return window.location.host;
  let name: string | null = null;
  if (host.endsWith(".dot.li")) name = host.slice(0, -3);
  else if (host.endsWith(".app.paseo.li"))
    name = host.slice(0, -".app.paseo.li".length) + ".dot";
  else if (host.endsWith(".dot")) name = host;
  if (!name) return "playground.dot";
  // Hosts load the app executable from the `app.` SUBNAME of the product's
  // base name (root-manifest Topology) — Polkadot Desktop serves this page
  // from `app.<name>.dot`. The signing identifier the host enforces is the
  // BASE name (Desktop Webview passes the base as the binding identifier
  // and resolves the 'app' subname under it), so strip the modality label.
  const sub = /^app\.(.+\.dot)$/.exec(name);
  return sub ? sub[1] : name;
}
export const PLAYGROUND_DOTNS_ID = env.VITE_PLAYGROUND_DOTNS_ID ?? defaultDotNsId();

// One-line shell command shown in the InstallWidget and the home-page CLI
// rows. Override via VITE_INSTALL_CMD for staging / PR-preview environments
// that point at a different `install.sh`.
export const INSTALL_CMD =
  env.VITE_INSTALL_CMD ??
  "curl -fsSL https://raw.githubusercontent.com/paritytech/playground-cli/main/install.sh | bash";

// Pinned tutorial app's domain on the registry. Used by IslandPortal + AppsTab
// to deep-link the tutorial CTA at /apps?app=<TUTORIAL_DOMAIN>. Must be a
// domain that is actually pinned in the registry contract this build reads
// from — if it isn't, the App Detail Panel opens to an empty state.
export const TUTORIAL_DOMAIN = "playground-tutorial.dot";

// Name of the playground CLI binary as it's surfaced in copyable commands,
// inline code snippets, install labels, and aria-labels. The CLI is in the
// middle of a rename away from `dot` (it collides with too many existing
// tools); override per build via VITE_CLI_COMMAND.
export const CLI_COMMAND = env.VITE_CLI_COMMAND ?? "pg";

// Optional dev-only funding mnemonic, injected at build time via
// VITE_DEV_FUNDER_MNEMONIC. When set, the "Collect my resources" onboarding
// step drips a fixed amount of PAS from this account to the freshly-connected
// product account so prototype sessions can sign txs before the production
// PGAS claim path lands (see `attemptMnemonicTopUp` in utils/contracts.ts).
// UNSET is the default and the only correct value for public / production
// builds — the drip is skipped entirely. Expects a bare mnemonic (derived at
// path ""). Never commit a real mnemonic; inject it through the build
// environment (CI secret / local shell) only.
export const DEV_FUNDER_MNEMONIC = env.VITE_DEV_FUNDER_MNEMONIC ?? "";
