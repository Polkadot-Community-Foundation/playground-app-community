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

/**
 * @vitest-environment jsdom
 *
 * Overrides the unit project's default happy-dom (vitest.config.ts) for this
 * file only. The readme XSS test asserts on DOMPurify.sanitize OUTPUT, and
 * dompurify >=3.4.3 hardened its node-iterator/template traversal in a way
 * happy-dom 20's DOM doesn't faithfully model — under happy-dom sanitize
 * mangles safe and unsafe markup alike (allowed tags unwrapped, <script>
 * leaks through), so the security regression test below would validate
 * nothing. jsdom models the browser DOM faithfully, matching production.
 * Keep any DOMPurify-output assertions in jsdom-environment files. If a second
 * such file appears, promote this to an `environmentMatchGlobs` entry on the
 * "unit" project in vitest.config.ts instead of repeating the docblock.
 */

import type { ReactElement } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

// Mock the SDK + telemetry surface BEFORE importing the component so the
// module graph picks the stubs. The component only touches these at runtime
// in event handlers (external-link click, journey breadcrumbs, sentry spans);
// rendering tests don't exercise those paths, but the imports themselves must
// resolve. Tests that drive the rating-submit flow would extend these.
vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  startSpan: vi.fn((_opts, fn) => fn({ setStatus: vi.fn(), setAttribute: vi.fn() })),
}));
// The author line uses <Link>; stub it to a plain anchor so the panel renders
// without a Router context (the panel only consumes Link from react-router-dom).
vi.mock("react-router-dom", () => ({
  Link: ({
    to,
    children,
    state: _state,
    ...props
  }: { to: string; children: ReactElement; state?: unknown }) => (
    <a href={typeof to === "string" ? to : "#"} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@parity/product-sdk-host", () => ({
  // Tests run outside a host container, so the in-host nav branch is never
  // taken; the stub just lets the import resolve and stays defensive if a
  // handler ever fires.
  isInsideContainerSync: vi.fn(() => false),
  getTruApi: vi.fn(() =>
    Promise.resolve({
      navigateTo: vi.fn(() => Promise.resolve({ isErr: () => false })),
    }),
  ),
}));
vi.mock("./lib/telemetry", () => ({
  journeyTracker: {
    start: vi.fn(),
    milestone: vi.fn(),
    addAttributes: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    abandon: vi.fn(),
    isActive: vi.fn(() => false),
  },
  addUserActionBreadcrumb: vi.fn(),
  addUiBreadcrumb: vi.fn(),
  captureWarning: vi.fn(),
  isSigningRejection: vi.fn(() => false),
}));
// `./utils` barrel re-exports from `./utils/contracts.ts`, which on module
// load eagerly calls `getChainAPI(CHAIN)` — that throws `Host provider
// unavailable` in Node. So we can NOT importActual the barrel; instead we
// provide stand-ins for the symbols AppDetailPanel actually uses
// (`cardColorForDomain`, `stringify`, `useIconUrl`). cardColorForDomain +
// stringify come from sibling util files that have no chain dep, so we
// re-import those directly. useIconUrl returns null — same effect as
// out-of-host.
vi.mock("./utils", async () => {
  const placeholders = await vi.importActual<typeof import("./utils/placeholders")>(
    "./utils/placeholders",
  );
  const stringifyMod = await vi.importActual<typeof import("./utils/stringify")>(
    "./utils/stringify",
  );
  return {
    cardColorForDomain: placeholders.cardColorForDomain,
    stringify: stringifyMod.stringify,
    useIconUrl: () => null,
    // Author line: no registry username in tests → falls back to short H160.
    useRegistryUsername: () => ({ username: null, pending: false, claiming: null }),
    displayNameForAccount: (username: string | null | undefined, address?: string) =>
      username ?? (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""),
  };
});
vi.mock("./utils/contracts.ts", () => ({
  contractsReady: Promise.resolve({}),
  registryReady: Promise.resolve({}),
  signerManager: {
    connect: vi.fn(() => Promise.resolve()),
    getState: vi.fn(() => ({ status: "disconnected", selectedAccount: null })),
    subscribe: vi.fn(() => () => undefined),
  },
  useSignerState: vi.fn(() => ({ status: "disconnected", selectedAccount: null, accounts: [], error: null })),
}));
vi.mock("./utils/event-stream/EventStream.tsx", () => ({
  default: () => null,
}));
// Controllable onboarding state. The detail-page star handler gates on
// `account && !hasIdentity` (connected non-builder → "become a builder" nudge
// instead of a doomed tx). Default to a signed-out shape so the gate stays
// inert for the existing star tests; the gate tests mutate it per-case and
// afterEach resets it.
const { onboardingState } = vi.hoisted(() => ({
  onboardingState: {
    account: undefined as string | undefined,
    hasIdentity: false,
    identityResolved: true,
    hasResources: true,
    startBecomeBuilder: vi.fn(),
  },
}));
vi.mock("./OnboardingProvider", () => ({
  useOnboarding: () => onboardingState,
  OnboardingProvider: ({ children }: { children: ReactElement }) => children,
}));

import AppDetailPanel from "./AppDetailPanel";
import { VISIBILITY_PUBLIC, type AppEntry, type AppDetails } from "./App";
import { CLI_COMMAND } from "./config";
import type { SignerState } from "@parity/product-sdk-signer";

const OWNER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const baseEntry: AppEntry = {
  domain: "example.dot",
  owner: OWNER_ADDRESS,
  visibility: VISIBILITY_PUBLIC,
};

const baseDetails: AppDetails = {
  metadata: {
    name: "Example App",
    description: "An example for unit tests.",
    repository: "https://github.com/paritytech/example",
    tag: "utility",
    readme: "# Hello\n\nA readme with **bold** text.",
  },
  starCount: 7,
  modCount: 0,
};

// Minimal SignerState — disconnected by default so the rating form shows the
// connect prompt rather than the editable stars. Tests that need a signed-in
// state override via `signedInState(...)`.
const disconnectedState: SignerState = {
  status: "disconnected",
  selectedAccount: null,
  accounts: [],
  error: null,
} as unknown as SignerState;

function signedInState(h160Address: string): SignerState {
  return {
    status: "connected",
    selectedAccount: { h160Address, address: "5..." },
    accounts: [{ h160Address, address: "5..." }],
    error: null,
  } as unknown as SignerState;
}

const noopProps = {
  fetchHasStarred: vi.fn(() => Promise.resolve(false)),
  onClose: vi.fn(),
  onStar: vi.fn(() => Promise.resolve()),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset the shared onboarding state so a gate test doesn't leak into the
  // next case (clearAllMocks resets the spy but not these plain fields).
  onboardingState.account = undefined;
  onboardingState.hasIdentity = false;
});

describe("AppDetailPanel — rendering", () => {
  it("renders the app name, description, and tag from metadata", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
      />,
    );

    expect(screen.getByTestId("detail-name")).toHaveTextContent("Example App");
    expect(screen.getByTestId("detail-description")).toHaveTextContent(
      "An example for unit tests.",
    );
    expect(screen.getByTestId("detail-tag")).toHaveTextContent("utility");
  });

  it("falls back to the domain (minus .dot) when no name is provided", () => {
    // The fallback is `entry.domain.replace(/\.dot$/, "")`. A fresh registry
    // entry whose metadata hasn't loaded yet (or never had a name) renders
    // the domain stem instead of "undefined" — assertion catches the
    // regression where the fallback shape changes.
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={{ ...baseDetails, metadata: undefined }}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("detail-name")).toHaveTextContent("example");
  });

  it("renders the mod command for the domain", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("mod-command")).toHaveTextContent(`${CLI_COMMAND} mod example`);
  });

  it("renders the RevX link with the modded-from query param", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    const link = screen.getByTestId("detail-revx-link");
    // Spec requires SINGLE Open-in-RevX button + no &quest= param — the
    // level picker happens inside RevX (CLAUDE.md "RevX deep-link contract").
    // Assert the URL shape.
    const href = link.getAttribute("href")!;
    expect(href).toContain("mod=example.dot");
    expect(href).not.toContain("quest=");
  });

  it("renders the readme as sanitised HTML, not raw markdown", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    const readme = screen.getByTestId("detail-readme");
    // marked → DOMPurify → innerHTML. Bold should be a <strong> element,
    // not literal `**bold**`.
    expect(readme.innerHTML).toContain("<strong>");
    expect(readme.innerHTML).not.toContain("**bold**");
  });

  it("sanitises script injection out of the readme", () => {
    // DOMPurify must strip <script> tags — a malicious metadata.readme
    // is otherwise an XSS vector inside the panel. This is a security
    // regression test: catches the day someone "simplifies" away the
    // DOMPurify.sanitize call.
    const malicious: AppDetails = {
      ...baseDetails,
      metadata: {
        ...baseDetails.metadata!,
        readme: "Hello<script>window.__pwned=true</script> world",
      },
    };
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={malicious}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("detail-readme").innerHTML).not.toContain("<script");
  });

  it("shows the play-only banner when no repository is published", () => {
    // The Moddable signal hinges on `metadata.repository`. Absent → app is
    // play-only; the Mod section renders the explanatory copy instead of
    // the RevX button and dot-mod command.
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={{ ...baseDetails, metadata: { ...baseDetails.metadata!, repository: undefined } }}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("detail-play-only")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-revx-link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mod-command")).not.toBeInTheDocument();
  });

  it("renders the cumulative star count when starCount > 0", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("detail-star-count")).toHaveTextContent("7");
  });

  it("does not render the star count when starCount is 0", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={{ ...baseDetails, starCount: 0 }}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.queryByTestId("detail-stars")).not.toBeInTheDocument();
  });
});

describe("AppDetailPanel — star toggle", () => {
  it("shows the connect prompt when no signer is selected", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("star-connect-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("star-toggle-btn")).toBeNull();
  });

  it("disables starring your own app (mirrors the contract's SelfStarForbidden guard)", () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OWNER_ADDRESS)}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("star-self-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("star-toggle-btn")).toBeNull();
  });

  it("renders the Star button for non-owners when the viewer has not starred yet", async () => {
    const fetchHasStarred = vi.fn(() => Promise.resolve(false));
    const onStar = vi.fn(() => Promise.resolve());
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OTHER_ADDRESS)}
        {...noopProps}
        fetchHasStarred={fetchHasStarred}
        onStar={onStar}
      />,
    );
    // Initial render: button visible, not yet starred.
    const btn = await screen.findByTestId("star-toggle-btn");
    expect(btn).toHaveAttribute("data-starred", "false");
    expect(btn).toHaveTextContent(/star/i);
    expect(fetchHasStarred).toHaveBeenCalledWith("example.dot", OTHER_ADDRESS);
  });

  it("marks the app as Starred and calls onStar exactly once when clicked", async () => {
    const onStar = vi.fn(() => Promise.resolve());
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OTHER_ADDRESS)}
        {...noopProps}
        fetchHasStarred={vi.fn(() => Promise.resolve(false))}
        onStar={onStar}
      />,
    );
    const btn = await screen.findByTestId("star-toggle-btn");

    await act(async () => {
      fireEvent.click(btn);
      // Let onStar resolve and the state update flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onStar).toHaveBeenCalledTimes(1);
    expect(onStar).toHaveBeenCalledWith("example.dot");
    expect(btn).toHaveAttribute("data-starred", "true");
    expect(btn).toHaveTextContent(/starred/i);
    expect(btn).toBeDisabled();
  });

  it("does not submit another transaction when the viewer already starred", async () => {
    const onStar = vi.fn(() => Promise.resolve());
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OTHER_ADDRESS)}
        {...noopProps}
        // Pre-existing star — the contract's has_starred returns true.
        fetchHasStarred={vi.fn(() => Promise.resolve(true))}
        onStar={onStar}
      />,
    );
    // Wait for the effect that reads has_starred to flush.
    const btn = await screen.findByTestId("star-toggle-btn");
    await act(async () => { await Promise.resolve(); });
    expect(btn).toHaveAttribute("data-starred", "true");
    expect(btn).toBeDisabled();

    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onStar).not.toHaveBeenCalled();
    expect(btn).toHaveAttribute("data-starred", "true");
  });

  it("opens the become-a-builder nudge for a connected non-builder instead of starring", async () => {
    // Connected (account set) but no claimed identity → the star tap must
    // surface the LockedHint nudge rather than submit a tx the contract will
    // reject. Mirrors the feed-card gate in App.tsx's AppCard.
    onboardingState.account = OTHER_ADDRESS;
    onboardingState.hasIdentity = false;
    const onStar = vi.fn(() => Promise.resolve());
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OTHER_ADDRESS)}
        {...noopProps}
        fetchHasStarred={vi.fn(() => Promise.resolve(false))}
        onStar={onStar}
      />,
    );
    const btn = await screen.findByTestId("star-toggle-btn");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(screen.getByTestId("locked-hint")).toBeInTheDocument();
    expect(onStar).not.toHaveBeenCalled();
    expect(btn).toHaveAttribute("data-starred", "false");
  });

  it("stars normally for a connected builder (gate passes through)", async () => {
    onboardingState.account = OTHER_ADDRESS;
    onboardingState.hasIdentity = true;
    const onStar = vi.fn(() => Promise.resolve());
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OTHER_ADDRESS)}
        {...noopProps}
        fetchHasStarred={vi.fn(() => Promise.resolve(false))}
        onStar={onStar}
      />,
    );
    const btn = await screen.findByTestId("star-toggle-btn");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("locked-hint")).toBeNull();
    expect(onStar).toHaveBeenCalledTimes(1);
    expect(onStar).toHaveBeenCalledWith("example.dot");
  });
});

describe("AppDetailPanel — ownership + admin", () => {
  it('sets data-is-owner="true" when the signer matches the entry owner (case-insensitive)', () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        // Match the owner address, but in different case — the comparison
        // must lowercase both sides. h160 addresses can come back in either
        // case from different SDKs.
        signer={signedInState(OWNER_ADDRESS.toUpperCase())}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("app-detail-panel")).toHaveAttribute(
      "data-is-owner",
      "true",
    );
  });

  it('sets data-is-owner="false" for a non-owner signer', () => {
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OTHER_ADDRESS)}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("app-detail-panel")).toHaveAttribute(
      "data-is-owner",
      "false",
    );
  });

  it("swaps the star section for the visibility toggle on an owned app (with onSetVisibility)", () => {
    // Owner + onSetVisibility → the Public/Private toggle occupies the star
    // control's slot; the star button and the self-star notice are both gone.
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OWNER_ADDRESS)}
        {...noopProps}
        onSetVisibility={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.getByTestId("detail-visibility-section")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-public-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("star-toggle-btn")).toBeNull();
    expect(screen.queryByTestId("star-self-notice")).toBeNull();
  });

  it("falls back to the self-star notice for an owner without onSetVisibility", () => {
    // No visibility callback → the swap can't happen, so the owner still sees
    // the "you can't star your own app" notice (graceful degradation).
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={signedInState(OWNER_ADDRESS)}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("star-self-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-visibility-section")).toBeNull();
  });

  it("renders the pin toggle for admins (with onTogglePin)", () => {
    const onTogglePin = vi.fn();
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        isAdmin
        onTogglePin={onTogglePin}
        {...noopProps}
      />,
    );
    expect(screen.getByTestId("detail-pin-btn")).toBeInTheDocument();
  });

  it("hides the pin toggle when isAdmin=false but shows the readonly indicator if isPinned", () => {
    // Non-admin viewing a pinned app: read-only pin icon, no button.
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        isAdmin={false}
        isPinned
        onTogglePin={vi.fn()}
        {...noopProps}
      />,
    );
    expect(screen.queryByTestId("detail-pin-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("detail-pin-indicator")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <AppDetailPanel
        entry={baseEntry}
        details={baseDetails}
        signer={disconnectedState}
        {...noopProps}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("detail-close-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
