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

// Chain preset passed to `getChainAPI` for the *standalone* (non-host) boot
// path. When the SPA runs inside a Polkadot host (Desktop/Browser) the host
// injects the active network — on Summit that is Summit Asset Hub — so this
// const does not gate the in-host network. It still selects the preset for a
// plain-browser/gateway view and the `paseo_asset_hub` typed descriptor.
// NOTE (Summit): left as "paseo" deliberately — `@parity/product-sdk-chain-client`
// must expose a Summit/w3s preset before this can flip without breaking the
// typed client. Verify against an installed product-sdk on the deploy VM; the
// in-host Summit path is unaffected. See the Summit VM runbook.
export const CHAIN = "paseo" as const;

// `import.meta.env` is Vite-only — undefined when this file is imported from a
// Node script (tsx scripts/*.ts in CI). Guard the access so scripts that only
// need CHAIN don't crash on module load.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

// Set at build time by CI workflows. Falls back to "dev" for local builds
// where pnpm dev / pnpm build:frontend runs without these env vars.
export const VERSION = env.VITE_VERSION ?? "dev";
export const BUILD_TIME = env.VITE_BUILD_TIME ?? "";

// Base URL for the revX editor. Override per environment via VITE_REVX_URL.
// Trailing slash is stripped so the value can be used as `${REVX_URL}/path`.
export const REVX_URL = (env.VITE_REVX_URL ?? "https://revx.dev").replace(/\/$/, "");

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
  if (host.endsWith(".dot.li")) return host.slice(0, -3);
  if (host.endsWith(".dot")) return host;
  return "playground.dot";
}
export const PLAYGROUND_DOTNS_ID = env.VITE_PLAYGROUND_DOTNS_ID ?? defaultDotNsId();

// One-line shell command shown in the InstallWidget and the home-page CLI
// rows. Points at the PCF playground-cli fork (the canonical CLI for the
// Summit deployment). Override via VITE_INSTALL_CMD for staging / PR-preview
// environments that point at a different `install.sh`.
export const INSTALL_CMD =
  env.VITE_INSTALL_CMD ??
  "curl -fsSL https://raw.githubusercontent.com/Polkadot-Community-Foundation/playground-cli/main/install.sh | bash";

// Pinned tutorial app's domain on the registry. Used by IslandPortal + AppsTab
// to deep-link the tutorial CTA at /apps?app=<TUTORIAL_DOMAIN>. Must be a
// domain that is actually pinned in the registry contract this build reads
// from — if it isn't, the App Detail Panel opens to an empty state.
export const TUTORIAL_DOMAIN = "playground-tutorial.dot";

// No-code starter app surfaced on the Playground tab and IslandPortal as the
// "open this in your browser and hit deploy" entry point. Stored as a bare
// `.dot` domain to match TUTORIAL_DOMAIN; call sites append `.li` for the
// Bulletin gateway URL. Override via VITE_NO_CODE_APP_DOMAIN.
export const NO_CODE_APP_DOMAIN = env.VITE_NO_CODE_APP_DOMAIN ?? "hello-playground20.dot";

// Name of the playground CLI binary as it's surfaced in copyable commands,
// inline code snippets, install labels, and aria-labels. The CLI is in the
// middle of a rename away from `dot` (it collides with too many existing
// tools); override per build via VITE_CLI_COMMAND.
export const CLI_COMMAND = env.VITE_CLI_COMMAND ?? "pg";
