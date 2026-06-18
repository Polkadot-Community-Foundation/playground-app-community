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

import { VISIBILITY_PUBLIC } from "./registryTypes";

export type PublishStatus =
  | "idle"
  | "preparing"
  | "uploading"
  | "publishing"
  | "done"
  | "error";

/**
 * Form-side inputs the flow needs. Icon bytes are pre-read by the caller
 * (the component reads the File before calling) so the flow stays
 * environment-agnostic and runs identically in tests + browser.
 */
export interface PublishInput {
  /** Raw user-entered domain; the flow appends `.dot` if missing. */
  domain: string;
  name: string;
  description?: string;
  repository?: string;
  tag?: string;
  visibility: number;
  iconBytes: Uint8Array | null;
}

/**
 * Operation-shaped deps the flow needs. Adapters at the call site map
 * these onto the underlying SDK — keeps the flow independent of
 * @parity/product-sdk types and makes tests trivial (pass plain mocks).
 */
export interface PublishClients {
  /** Compute the CID for byte content. */
  calculateCid(bytes: Uint8Array): Promise<{ toString(): string }>;
  /** Upload one chunk to Bulletin Chain. Sequential calls are fine. */
  storeBytes(bytes: Uint8Array): Promise<unknown>;
  /**
   * Submit a `registry.publish(domain, cid, vis, owner, modded_from, is_moddable)`
   * transaction, returning the tx result.
   *
   * `moddedFrom` is always null from the playground-app's publish UI (modding
   * is a CLI/RevX path). The CLI threads its own value through.
   * `isModdable` reflects whether the user provided a repository — that's the
   * signal that other users can clone + mod this app from GitHub.
   */
  publishToRegistry(
    domain: string,
    cid: string,
    visibility: number,
    moddedFrom: string | null,
    isModdable: boolean,
  ): Promise<{ ok: boolean }>;
  /**
   * Wrap the bulletin upload step in a telemetry span. Tests pass the
   * inner `fn` through directly.
   */
  startBulletinSpan<T>(
    attrs: { itemCount: number },
    fn: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Side-effect interface. The flow never reads back from these — it just
 * announces status/progress and lets the caller decide how to render.
 */
export interface PublishReporter {
  /** Status state machine: idle → preparing → uploading → done / error. */
  status(s: PublishStatus): void;
  /** Single live progress line; new calls replace the previous message. */
  message(m: string): void;
  /** User-facing error message on terminal failure. */
  errorMessage(m: string): void;
  // Telemetry — match journeyTracker / Sentry semantics:
  start(opts: {
    hasIcon: boolean;
    visibility: "public" | "private";
    hasTag: boolean;
  }): void;
  milestone(name: string): void;
  complete(): void;
  fail(reason: string, err: unknown): void;
}

export type PublishOutcome =
  | { ok: true; metadataCid: string; fullDomain: string }
  | { ok: false; reason: string };

/**
 * Classify which side of the parallel upload+publish failed, so the
 * caller can attribute the error in telemetry tags. Pure — exposed so
 * tests can lock the mapping.
 */
export function publishFailureReason(
  bulletinDone: boolean,
  registryDone: boolean,
): string {
  if (!bulletinDone && !registryDone) return "both-failed";
  if (!bulletinDone) return "bulletin-failed";
  if (!registryDone) return "registry-failed";
  return "post-publish-failed";
}

/**
 * Append `.dot` to a domain if missing. Pure.
 */
export function ensureDotSuffix(rawDomain: string): string {
  const trimmed = rawDomain.trim();
  return trimmed.endsWith(".dot") ? trimmed : `${trimmed}.dot`;
}

/**
 * Run the full publish flow:
 *  1. Compute icon CID (if any)
 *  2. Build metadata JSON + compute its CID
 *  3. In parallel: upload bytes to Bulletin AND submit `registry.publish` tx
 *  4. Wait for both, surface the first failure if either rejects
 *
 * Does NOT throw — every failure is reported via `reporter.fail` and
 * the function resolves with `{ ok: false, reason }`. Callers should not
 * try/catch around this; check `outcome.ok` instead.
 */
export async function runPublishFlow(
  input: PublishInput,
  clients: PublishClients,
  reporter: PublishReporter,
): Promise<PublishOutcome> {
  reporter.start({
    hasIcon: input.iconBytes !== null,
    visibility: input.visibility === VISIBILITY_PUBLIC ? "public" : "private",
    hasTag: !!input.tag,
  });
  reporter.status("preparing");

  // Tracked outside try{} so the catch path can use them to attribute
  // the failure (bulletin vs registry vs both).
  let bulletinDone = false;
  let registryDone = false;

  try {
    const iconCid = input.iconBytes
      ? (await clients.calculateCid(input.iconBytes)).toString()
      : undefined;

    const metadata: Record<string, string | undefined> = {
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      repository: input.repository?.trim() || undefined,
      icon_cid: iconCid,
      tag: input.tag || undefined,
    };
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));

    reporter.status("uploading");
    reporter.message("Uploading & publishing in parallel...");

    const metadataCid = (await clients.calculateCid(metadataBytes)).toString();
    const fullDomain = ensureDotSuffix(input.domain);
    reporter.milestone("metadata-prepared");

    let registryStarted = false;
    const updateMsg = () => {
      const parts: string[] = [];
      parts.push(bulletinDone ? "Bulletin: done" : "Bulletin: uploading...");
      parts.push(
        registryDone
          ? "Registry: done"
          : registryStarted
            ? "Registry: signing..."
            : "Registry: starting...",
      );
      reporter.message(parts.join(" · "));
    };
    updateMsg();

    const bulletinPromise = clients.startBulletinSpan(
      { itemCount: input.iconBytes ? 2 : 1 },
      async () => {
        const total = input.iconBytes ? 2 : 1;
        let done = 0;
        if (input.iconBytes) {
          reporter.message(`Uploading icon (${++done}/${total})...`);
          await clients.storeBytes(input.iconBytes);
        }
        reporter.message(`Uploading metadata (${++done}/${total})...`);
        await clients.storeBytes(metadataBytes);
        bulletinDone = true;
        updateMsg();
        reporter.milestone("bulletin-uploaded");
      },
    );

    const registryPromise = (async () => {
      registryStarted = true;
      updateMsg();
      // moddedFrom = null: the playground-app's publish UI doesn't capture a
      // source app. The CLI path passes its own value via `dot.json`.
      // isModdable: presence of a repository URL is the moddable signal.
      const isModdable = !!input.repository?.trim();
      const result = await clients.publishToRegistry(
        fullDomain,
        metadataCid,
        input.visibility,
        null,
        isModdable,
      );
      if (!result.ok) {
        throw new Error("Registry transaction failed");
      }
      registryDone = true;
      updateMsg();
      reporter.milestone("registry-published");
    })();

    const results = await Promise.allSettled([bulletinPromise, registryPromise]);
    const failures = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    if (failures.length) {
      throw failures[0].reason;
    }

    reporter.status("done");
    reporter.message("Published!");
    reporter.complete();
    return { ok: true, metadataCid, fullDomain };
  } catch (err: unknown) {
    reporter.status("error");
    // InsufficientFundsError / NotABuilderError are soft: the guard already
    // routed the user to a faucet top-up or the Become-a-builder flow, so don't
    // surface a hard error message for them.
    const soft =
      err instanceof Error &&
      (err.name === "InsufficientFundsError" || err.name === "NotABuilderError");
    if (!soft) {
      reporter.errorMessage(err instanceof Error ? err.message : "Something went wrong");
    }
    const reason = publishFailureReason(bulletinDone, registryDone);
    reporter.fail(reason, err);
    return { ok: false, reason };
  }
}
