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

// Onboarding ("Become a builder") orchestration. A single provider at the App
// root owns the gate state and the one modal that runs the flow, so every entry
// point — the Playground journey, the Apps banner, the Profile button, a locked
// nudge, the CLI hand-off route — drives the exact same focused experience.
//
// The gate is IDENTITY (`hasIdentity` — revealed). Becoming a builder is a
// SINGLE bundled call: `set_identity` binds the verified DotNS identity AND
// provisions network resources at the contract level, so there is no separate
// "claim a handle" step and no anonymous choice — it just happens in the
// background. A user who is already a builder but has run out of allowance
// takes the lighter top-up path (faucet only), never the identity modal again.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Sentry from "@sentry/react";
import {
  useSignerState,
  usePgasAllowance,
  requestResources,
  confirmResourcesGranted,
  PermissionDeniedError,
  useIsMobile,
} from "./utils";
import {
  useRootUsername,
  revealIdentity,
  revalidateRootIdentities,
} from "./utils/identity.ts";
import { markIdentityBonusClaimed } from "./utils/identityBonus.ts";
import { registerBecomeBuilderTrigger } from "./utils/dripBridge.ts";
import BecomeBuilderModal, { type ResourceStatus } from "./BecomeBuilderModal";

interface OnboardingValue {
  /** Connected H160, or undefined when not connected. */
  account: string | undefined;
  /** Does the account hold network resources (PGAS)? Drives the funded checks. */
  hasResources: boolean;
  /** The gate — is the account a builder yet (verified identity revealed)? */
  hasIdentity: boolean;
  /**
   * Has the identity read settled yet? `hasIdentity` is `false` both while the
   * read is in flight AND once it confirms "not a builder", so callers that act
   * on the *absence* of identity (e.g. the /become-builder auto-open) must wait
   * for this before treating `hasIdentity === false` as "not a builder".
   */
  identityResolved: boolean;
  /**
   * Open the flow for the current state:
   *  • Not a builder yet → the one-approval "Become a builder" modal (binds
   *    identity + provisions resources in one bundled call).
   *  • Already a builder → a silent faucet top-up (no identity modal).
   *
   * `onResourcesGranted` fires once, after resources have landed (either path) —
   * used by callers like the site builder to auto-recheck/deploy without a
   * manual "Check again".
   */
  startBecomeBuilder: (opts?: { onResourcesGranted?: () => void }) => void;
}

// No provider ⇒ don't gate. Isolated component/unit tests that render an
// AppCard or a JourneySection without wrapping the provider keep today's
// behaviour (resources assumed present, nothing locked).
const DEFAULT: OnboardingValue = {
  account: undefined,
  hasResources: true,
  hasIdentity: false,
  identityResolved: true,
  startBecomeBuilder: () => {},
};

const OnboardingContext = createContext<OnboardingValue>(DEFAULT);

export function useOnboarding(): OnboardingValue {
  return useContext(OnboardingContext);
}

// Onsite-event funding: shown only when every funder source is exhausted —
// contract faucet dry + dedicated mnemonic + Alice all failed. There's nothing
// the user can do remotely, so point them at a human in the room rather than a
// link or a "try again later". Kept as constants so both entry paths (first-time
// reveal and top-up) stay in sync.
const OUT_OF_FUNDS_REVEAL =
  "You're a builder now, but we're out of resources to fund your account right now. Please grab a member of the playground team here at the event and we'll sort it out.";
const OUT_OF_FUNDS_TOPUP =
  "We're out of resources to fund your account right now. Please grab a member of the playground team here at the event and we'll sort it out.";

export function OnboardingProvider({
  children,
  refreshKey = 0,
}: {
  children: ReactNode;
  /**
   * Bumped by App on the connected user's XP events and on tab refocus. Feeds
   * the resources + identity reads so the gate reconciles when the account is
   * provisioned / revealed on another device, instead of staying stale until a
   * reload. PGAS and identity both only go false→true and the reads never
   * regress, so a needless re-read is harmless.
   */
  refreshKey?: number;
}) {
  const signer = useSignerState();
  const account = signer.selectedAccount ?? undefined;
  const h160 = account?.h160Address as `0x${string}` | undefined;
  const isMobile = useIsMobile();

  const { hasResources, refresh: refreshResources } = usePgasAllowance(account, refreshKey);
  const { username, refresh: refreshUsername } = useRootUsername(h160 ?? null, refreshKey);
  const hasIdentity = typeof username === "string" && username !== "";
  // `undefined` = read not yet settled; `null`/string = settled (anon / named).
  const identityResolved = username !== undefined;

  const [open, setOpen] = useState(false);
  const [resourceStatus, setResourceStatus] = useState<ResourceStatus>("idle");
  const [toast, setToast] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setResourceStatus("idle");
  }, []);

  // Fired once after resources land (either path) — set by startBecomeBuilder,
  // consumed (and cleared) in the success branch.
  const onResourcesGrantedRef = useRef<(() => void) | null>(null);

  // Already a builder, just out of allowance: faucet directly, no identity
  // modal. The host dialog is the visible activity; a failure surfaces a toast.
  const topUp = useCallback(() => {
    // Non-blocking progress feedback: the toast overlay never gates the UI, it
    // just narrates the request → success while the host dialog runs.
    setToast("Processing your request…");
    void (async () => {
      try {
        const { funded } = await requestResources();
        if (h160) confirmResourcesGranted(h160);
        refreshResources();
        onResourcesGrantedRef.current?.();
        onResourcesGrantedRef.current = null;
        if (!funded) {
          // The allowance landed, but every funder (dedicated mnemonic → Alice →
          // contract faucet) failed, so the account holds no spendable tokens —
          // don't claim success. At an onsite event the fix is a human, not a
          // retry; record it so we can see how often funding runs out.
          Sentry.captureMessage("funding exhausted on top-up", {
            level: "warning",
            tags: { action: "funding-exhausted" },
          });
          setToast(OUT_OF_FUNDS_TOPUP);
        } else {
          setToast("You're topped up.");
        }
      } catch (err) {
        const denied =
          err instanceof PermissionDeniedError ||
          (err instanceof Error && err.name === "PermissionDeniedError");
        if (denied) {
          // Cancelled → soft; clear the "processing" toast so it doesn't linger,
          // the caller can re-tap.
          setToast(null);
        } else {
          Sentry.captureException(err, { tags: { action: "top-up-resources" } });
          setToast("Couldn't top up resources. Try again?");
        }
      }
    })();
  }, [h160, refreshResources]);

  const startBecomeBuilder = useCallback(
    (opts?: { onResourcesGranted?: () => void }) => {
      onResourcesGrantedRef.current = opts?.onResourcesGranted ?? null;
      if (hasIdentity) {
        // Already a builder — this is a resource top-up, not a re-onboard.
        topUp();
        return;
      }
      setResourceStatus("idle");
      setOpen(true);
    },
    [hasIdentity, topUp],
  );

  // The one approval. `revealIdentity` runs `set_identity`, which binds the
  // verified identity AND provisions resources (bundled at the contract level),
  // so a single "ok" means the user is now a funded builder. The modal stays up
  // showing "Waiting for approval…" until the outcome lands; a decline/failure
  // keeps it open with a soft "try again".
  const onBecomeBuilder = useCallback(() => {
    if (!h160) return;
    setToast(null);
    setResourceStatus("loading");
    void revealIdentity(h160).then((outcome) => {
      refreshUsername();
      refreshResources();
      revalidateRootIdentities();
      if (outcome === "ok" || outcome === "ok-unfunded") {
        // Resources are bundled into the same call and PGAS never regresses, so
        // record the positive optimistically — this flips the gate without a
        // post-tx indexing lag. Identity is recorded inside revealIdentity.
        confirmResourcesGranted(h160);
        markIdentityBonusClaimed(h160);
        onResourcesGrantedRef.current?.();
        onResourcesGrantedRef.current = null;
        close();
        if (outcome === "ok-unfunded") {
          // Builder is set up, but every funder failed (bundled faucet dry, then
          // the dedicated mnemonic and Alice both came up short) — at an onsite
          // event the fix is a human, so send them to the playground team.
          setToast(OUT_OF_FUNDS_REVEAL);
        }
      } else if (outcome === "rejected") {
        // User declined the host sign prompt → soft "try again", stay put.
        setResourceStatus("cancelled");
      } else {
        setResourceStatus("cancelled");
        setToast("Couldn't set you up. Try again?");
      }
    });
  }, [h160, refreshUsername, refreshResources, close]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Abort the flow on account switch / disconnect: the modal carries the prior
  // account's status, which would render stale against the new account (mirrors
  // the "abort on account change" convention in the publish flow). Re-entry via
  // startBecomeBuilder reopens cleanly.
  //
  // Guarded against the initial undefined→<account> connect transition: this
  // effect (parent) runs AFTER a child route's auto-open effect, so an
  // unconditional reset here would clobber the modal opened by
  // /become-builder's trigger on the very first render it appears. Only reset
  // on a genuine change away from a known account.
  const prevH160 = useRef(h160);
  useEffect(() => {
    if (prevH160.current !== undefined && prevH160.current !== h160) {
      setOpen(false);
      setResourceStatus("idle");
    }
    prevH160.current = h160;
  }, [h160]);

  // Register the drip trigger so non-hook code (e.g. guardedWrite above the
  // provider in the tree) can open the "Become a builder" flow without needing
  // access to this hook.
  useEffect(() => {
    registerBecomeBuilderTrigger(() => startBecomeBuilder());
    return () => registerBecomeBuilderTrigger(null);
  }, [startBecomeBuilder]);

  const value = useMemo<OnboardingValue>(
    () => ({ account: h160, hasResources, hasIdentity, identityResolved, startBecomeBuilder }),
    [h160, hasResources, hasIdentity, identityResolved, startBecomeBuilder],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
      {open && h160 && !hasIdentity && (
        <BecomeBuilderModal
          resourceStatus={resourceStatus}
          isMobile={isMobile}
          onBecomeBuilder={onBecomeBuilder}
          onClose={close}
        />
      )}
      {toast && (
        <div className="username-toast" role="status" data-testid="onboarding-toast">
          {toast}
        </div>
      )}
    </OnboardingContext.Provider>
  );
}
