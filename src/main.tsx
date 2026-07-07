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

import "./sentry.ts";
import "./lib/logger-config.ts";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { lazyRetry } from "./utils/lazyRetry.ts";
import { LoadingFallback } from "./LoadingFallback.tsx";
import "@fontsource-variable/inter";
import "@fontsource/dm-serif-display/400.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "@fontsource/sixtyfour/400.css";
import "./App.css";

// Lazy-loaded so that App.tsx's module-level side effects (page-load journey,
// signer subscription) don't execute when the user is on the test-sentry page
// or when a Polkadot Desktop dashboard widget mounts the lean widget root.
const App = lazyRetry(() => import("./App.tsx"));
const TestSentry = lazyRetry(() => import("./TestSentry.tsx"));
const MyAppsWidget = lazyRetry(() => import("./MyAppsWidget.tsx"));

// A lazy chunk failing to load is almost always version skew: this tab's
// entry bundle predates the latest deployment, and the gateway only serves
// the current manifest's hashed filenames. Reloading picks up the new
// bundle. Rate-limited to one reload per 30s so a chunk that's missing in
// the CURRENT deployment (or a dead gateway) can't reload-loop — repeat
// failures fall through to Vite's normal import rejection, which surfaces
// in the boundary fallback. The window self-resets, so a tab left open
// across a later deployment still heals itself.
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "playground:chunk-reload-at";
  const lastReload = Number(sessionStorage.getItem(KEY) ?? 0);
  if (Date.now() - lastReload < 30_000) return;
  sessionStorage.setItem(KEY, String(Date.now()));
  event.preventDefault();
  window.location.reload();
});

const isTestPage = new URLSearchParams(window.location.search).has("test-sentry");
// Interim hookup for the Polkadot Desktop *Widget* modality. The eventual
// shape (see "Product Manifest Proposal.md") is a separately-deployed
// widget executable referenced from a dotNS root manifest's
// `Topology::Widget` list — likely served from a subdomain like
// `myapps-widget.playground.dot` with its own IPFS bundle and checksum.
// Until that lands, we share this SPA's bundle and branch on the pathname.
// Branching here (not inside <App />) keeps the heavy grid + admin +
// pinned-apps initialisation out of the widget tile so first paint is fast.
const isWidget = window.location.pathname.startsWith("/widget");

const FallbackUi = () => (
  <div style={{ padding: "2rem", color: "#fff", fontFamily: "ui-monospace, monospace" }}>
    <h2>Something went wrong.</h2>
    <p>The error has been reported. Reload the page to try again.</p>
  </div>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={<FallbackUi />}
      beforeCapture={(scope) => scope.setTag("boundary", "root")}
    >
      <Suspense fallback={<LoadingFallback />}>
        {isTestPage ? (
          <TestSentry />
        ) : isWidget ? (
          <MyAppsWidget />
        ) : (
          <BrowserRouter>
            <App />
          </BrowserRouter>
        )}
      </Suspense>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
