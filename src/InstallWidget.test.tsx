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

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

// Same App.tsx module-graph mocking pattern as AppCard.test.tsx /
// AppDetailPanel.test.tsx — `./utils` barrel re-exports chain-init side
// effects that throw in Node.
vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  startSpan: vi.fn((_o: unknown, fn: (s: unknown) => unknown) =>
    fn({ setStatus: vi.fn(), setAttribute: vi.fn() }),
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
// vi.mock factories are hoisted above this file's const decls — use
// vi.hoisted so the spy exists in time for the factory to reference it.
const { addUserActionBreadcrumb } = vi.hoisted(() => ({
  addUserActionBreadcrumb: vi.fn(),
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
  addUserActionBreadcrumb,
  addUiBreadcrumb: vi.fn(),
  addAdminActionBreadcrumb: vi.fn(),
  captureWarning: vi.fn(),
  isSigningRejection: vi.fn(() => false),
  SpanOp: { BULLETIN_UPLOAD: "bulletin.upload", CHAIN_TX: "chain.tx" },
}));
vi.mock("./utils", async () => {
  const placeholders = await vi.importActual<typeof import("./utils/placeholders")>(
    "./utils/placeholders",
  );
  return { cardColorForDomain: placeholders.cardColorForDomain, useIconUrl: () => null };
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

import { InstallWidget } from "./App";
import { CLI_COMMAND, INSTALL_CMD } from "./config";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom doesn't ship a navigator.clipboard by default — stub it.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  writeText.mockClear();
  addUserActionBreadcrumb.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InstallWidget", () => {
  it("renders the section title", () => {
    render(<InstallWidget />);
    expect(screen.getByText(new RegExp(`install ${CLI_COMMAND} cli`, "i"))).toBeInTheDocument();
  });

  it("renders the literal INSTALL_CMD string from the source", () => {
    // Pinning the actual command makes accidental edits to INSTALL_CMD
    // surface in tests (e.g. someone changes the URL but doesn't update
    // docs). Read the source value rather than hard-coding the string.
    render(<InstallWidget />);
    expect(screen.getByText(INSTALL_CMD)).toBeInTheDocument();
  });

  it("renders a $ prompt indicator before the command", () => {
    const { container } = render(<InstallWidget />);
    expect(container.querySelector(".install-line-prompt")!.textContent).toBe("$");
  });

  it("shows the Copy icon (not Check) on first render", () => {
    const { container } = render(<InstallWidget />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    // copied state defaults false → tooltip is in DOM but not visible-class
    const tooltip = container.querySelector(".install-line-tooltip")!;
    expect(tooltip.className).not.toContain("install-line-tooltip-visible");
  });

  it("clicking the install-line writes INSTALL_CMD to the clipboard", () => {
    const { container } = render(<InstallWidget />);
    fireEvent.click(container.querySelector(".install-line")!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(INSTALL_CMD);
  });

  it("clicking fires the breadcrumb for telemetry", () => {
    const { container } = render(<InstallWidget />);
    fireEvent.click(container.querySelector(".install-line")!);
    expect(addUserActionBreadcrumb).toHaveBeenCalledWith("Copy install command");
  });

  it("clicking flips state so the tooltip becomes visible + Check icon shows", () => {
    const { container } = render(<InstallWidget />);
    fireEvent.click(container.querySelector(".install-line")!);
    // copied → tooltip-visible class + install-line-copied modifier
    expect(container.querySelector(".install-line")!.className)
      .toContain("install-line-copied");
    expect(container.querySelector(".install-line-tooltip")!.className)
      .toContain("install-line-tooltip-visible");
  });

  it("reverts to the un-copied state after 2000ms (matches App.tsx:1279 timeout)", () => {
    const { container } = render(<InstallWidget />);
    fireEvent.click(container.querySelector(".install-line")!);
    expect(container.querySelector(".install-line")!.className)
      .toContain("install-line-copied");

    // Advance just shy — still in copied state.
    act(() => { vi.advanceTimersByTime(1999); });
    expect(container.querySelector(".install-line")!.className)
      .toContain("install-line-copied");

    // Cross the threshold.
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector(".install-line")!.className)
      .not.toContain("install-line-copied");
    expect(container.querySelector(".install-line-tooltip")!.className)
      .not.toContain("install-line-tooltip-visible");
  });
});
