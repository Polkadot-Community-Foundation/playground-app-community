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

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import CodeSnippet from "./CodeSnippet";
import { CLI_COMMAND, INSTALL_CMD } from "./config";

// Shared, persisted "the CLI is set up" flag. This block sits in every desktop
// instruction tab (tutorial, mod, the .dot-site decentralise path) — it can't
// be hoisted into a single journey section, because the CLI is desktop-only and
// a shared section would leak it to web/mobile users. So instead of deduping by
// LOCATION, it dedupes by STATE: once the user ticks "I've set up the CLI" in
// one tab, every mounted instance collapses to a slim acknowledgement. Backed by
// localStorage (survives reloads) with an in-memory subscriber set so all live
// instances update together, plus a `storage` listener for cross-tab sync.
const STORAGE_KEY = "pg.cliReady";
const listeners = new Set<() => void>();
let cliReady = readStored();

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function setCliReady(value: boolean): void {
  cliReady = value;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — the in-memory flag still drives this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cliReady = readStored();
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function useCliReady(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => cliReady,
    () => false,
  );
}

/**
 * Reusable "install + log in to the CLI first" block shared by every desktop
 * Playground CLI instruction tab, so the setup prerequisites are written once.
 * Rendered as a native <details> disclosure. A localStorage-backed "I've set up
 * the CLI" checkbox marks it done across the whole page: every instance then
 * collapses to a slim "set up" line (re-openable to revert).
 */
export default function CliInstallInstructions() {
  const ready = useCliReady();
  // Expanded by default — the steps are the point of the section, so they show
  // unless the user has already marked the CLI set up (the persisted `ready`
  // flag). We deliberately do NOT persist the open/closed state itself: a manual
  // collapse is session-only, and the only thing that survives a reload is the
  // "I've set up the CLI" completion flag.
  const [open, setOpen] = useState(!ready);

  // Marking the CLI set up (here or in any other instance) folds the steps
  // away everywhere. Only fires on the transition to ready, so a collapsed
  // "set up" block can still be re-opened to revert.
  useEffect(() => {
    if (ready) setOpen(false);
  }, [ready]);

  return (
    <details
      className={`cli-install${ready ? " is-ready" : ""}`}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cli-install-toggle">
        <ChevronDown size={16} className="cli-install-chevron" aria-hidden="true" />
        {ready ? (
          <>
            <Check size={14} strokeWidth={3} className="cli-install-tick" aria-hidden="true" />
            Playground CLI ready
          </>
        ) : (
          "Set up the Playground CLI"
        )}
      </summary>
      <div className="cli-install-body">
        <p className="journey-step-note">
          Install the Playground CLI.
        </p>
        <CodeSnippet command={INSTALL_CMD} ariaLabel={`Copy ${CLI_COMMAND} install command`} />
        <p className="journey-step-note">
          Set up your toolchain, phone signing, and account.
        </p>
        <CodeSnippet command={`${CLI_COMMAND} login`} ariaLabel={`Copy ${CLI_COMMAND} login command`} />
        <label className="cli-install-done">
          <input
            type="checkbox"
            checked={ready}
            onChange={(e) => setCliReady(e.target.checked)}
          />
          I’ve set up the CLI
        </label>
      </div>
    </details>
  );
}
