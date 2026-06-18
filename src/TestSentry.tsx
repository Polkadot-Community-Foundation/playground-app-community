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

import { useState } from "react";
import * as Sentry from "@sentry/react";
import { journeyTracker, BreadcrumbCategory } from "./lib/telemetry";

export default function TestSentry() {
  const [log, setLog] = useState<string[]>([]);
  const append = (msg: string) =>
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const triggerError = () => {
    append("Capturing test error...");
    const id = Sentry.captureException(new Error("Test error from playground.dot"), {
      tags: { source: "test-sentry-page" },
    });
    append(`Captured: ${id ?? "(no DSN — local-only)"}`);
  };

  const triggerBreadcrumb = () => {
    Sentry.addBreadcrumb({
      category: BreadcrumbCategory.TEST,
      message: "Test breadcrumb",
      level: "info",
      data: { ts: Date.now() },
    });
    append("Breadcrumb added (will appear in next event's timeline).");
  };

  const triggerJourneySuccess = () => {
    append("Starting page-load journey (success path)...");
    journeyTracker.start("page-load", { "journey.test": true });
    setTimeout(() => {
      journeyTracker.milestone("page-load", "contracts-ready");
      append("milestone: contracts-ready");
    }, 150);
    setTimeout(() => {
      journeyTracker.milestone("page-load", "first-page-loaded");
      append("milestone: first-page-loaded");
    }, 350);
    setTimeout(() => {
      journeyTracker.milestone("page-load", "metadata-rendered");
      journeyTracker.complete("page-load");
      append("complete. Check Sentry > Performance > op:journey.page-load");
    }, 600);
  };

  const triggerJourneyFail = () => {
    append("Starting publish journey (fail path)...");
    journeyTracker.start("publish", { "journey.test": true });
    setTimeout(() => {
      journeyTracker.milestone("publish", "metadata-prepared");
      append("milestone: metadata-prepared");
    }, 200);
    setTimeout(() => {
      journeyTracker.fail("publish", "test-bulletin-upload-failed");
      append("failed: test-bulletin-upload-failed");
    }, 500);
  };

  const flush = async () => {
    append("Flushing...");
    const ok = await Sentry.flush(5000);
    append(`Flushed: ${ok}`);
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "ui-monospace, monospace", color: "#fff", background: "#111", minHeight: "100vh" }}>
      <h1>Sentry Test</h1>
      <p style={{ opacity: 0.7 }}>
        Sentry initialized: <strong>{Sentry.getClient() ? "yes" : "no (events stay local)"}</strong>
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", margin: "1rem 0" }}>
        <button onClick={triggerError}>Test Error</button>
        <button onClick={triggerBreadcrumb}>Test Breadcrumb</button>
        <button onClick={triggerJourneySuccess}>Journey: page-load (success)</button>
        <button onClick={triggerJourneyFail}>Journey: publish (fail)</button>
        <button onClick={flush}>Flush Queue</button>
      </div>
      <pre style={{ background: "#000", padding: "1rem", borderRadius: 4, fontSize: 12, lineHeight: 1.5 }}>
        {log.length ? log.join("\n") : "No events yet."}
      </pre>
    </div>
  );
}
