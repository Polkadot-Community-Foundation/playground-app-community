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

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// Same mocking pattern as AppDetailPanel.test.tsx — the App.tsx module
// pulls in chain-init side effects via `./utils` that throw in Node. We
// shim the barrel to expose the symbols AppCard actually needs.
vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  startSpan: vi.fn((_opts: unknown, fn: (s: unknown) => unknown) =>
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
  addAdminActionBreadcrumb: vi.fn(),
  captureWarning: vi.fn(),
  isSigningRejection: vi.fn(() => false),
  SpanOp: { BULLETIN_UPLOAD: "bulletin.upload", CHAIN_TX: "chain.tx" },
}));
// `./utils` barrel re-exports `./utils/contracts.ts` which eagerly calls
// `getChainAPI(CHAIN)` on import — throws in Node. Stand in the three
// symbols AppCard actually consumes.
vi.mock("./utils", async () => {
  const placeholders = await vi.importActual<typeof import("./utils/placeholders")>(
    "./utils/placeholders",
  );
  const readme = await vi.importActual<typeof import("./utils/readme")>(
    "./utils/readme",
  );
  return {
    cardColorForDomain: placeholders.cardColorForDomain,
    useIconUrl: () => null, // null → AppCard shows the per-app colour block
    readmeBlurb: readme.readmeBlurb, // pure, no chain dep
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

import { AppCard, VISIBILITY_PRIVATE } from "./App";
import { VISIBILITY_PUBLIC, type AppEntry } from "./registryTypes";
import type { AppDetails } from "./App";

afterEach(cleanup);

const baseEntry: AppEntry = {
  domain: "example.dot",
  owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  visibility: VISIBILITY_PUBLIC,
};

describe("AppCard — rendering with no metadata loaded", () => {
  it("falls back to domain (stripped of .dot) as the name when no metadata", () => {
    render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    // App.tsx:1216 — `entry.domain.replace(/\.dot$/, "")`
    expect(screen.getByTestId("card-name")).toHaveTextContent("example");
  });

  it("renders an empty description blurb when no metadata", () => {
    render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-desc")).toHaveTextContent("");
  });

  it("omits the tag chip when no metadata.tag", () => {
    render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("card-tag")).toBeNull();
  });

  it("sets data-metadata-loaded='false' when details is undefined", () => {
    const { container } = render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    const card = container.querySelector('[data-testid="app-card"]')!;
    expect(card.getAttribute("data-metadata-loaded")).toBe("false");
  });

  it("shows the loading shimmer placeholder for the fav count while ratingCount is undefined", () => {
    const { container } = render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    // No fixed count is rendered yet; the shimmer placeholder takes its slot.
    expect(screen.queryByTestId("card-fav-count")).toBeNull();
    expect(container.querySelector(".bar-count.is-loading")).not.toBeNull();
  });

  it("does NOT render the moddable chip when details/repository is missing", () => {
    render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("card-moddable-chip")).toBeNull();
  });
});

describe("AppCard — rendering with metadata loaded", () => {
  const details: AppDetails = {
    metadata: {
      name: "Example App",
      description: "A real description",
      tag: "social",
      repository: "https://github.com/example/repo",
    },
    starCount: 12,
    modCount: 3,
  };

  it("renders metadata.name when present", () => {
    render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-name")).toHaveTextContent("Example App");
  });

  it("renders metadata.description when present", () => {
    render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-desc")).toHaveTextContent("A real description");
  });

  it("derives the blurb from the README when description is absent", () => {
    const withReadme: AppDetails = {
      metadata: {
        name: "Example App",
        readme: "# Example App\n\nA neat little game you can mod and deploy.",
      },
    };
    render(<AppCard entry={baseEntry} details={withReadme} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-desc")).toHaveTextContent(
      "A neat little game you can mod and deploy.",
    );
  });

  it("renders metadata.tag when present", () => {
    render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-tag")).toHaveTextContent("social");
  });

  it("renders the 'site' category chip (Site Builder deploys are a visible category)", () => {
    const siteDetails: AppDetails = { metadata: { name: "A Site", tag: "site" } };
    render(<AppCard entry={baseEntry} details={siteDetails} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-tag")).toHaveTextContent("site");
  });

  it("sets data-metadata-loaded='true' when metadata is present", () => {
    const { container } = render(
      <AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />,
    );
    const card = container.querySelector('[data-testid="app-card"]')!;
    expect(card.getAttribute("data-metadata-loaded")).toBe("true");
  });

  it("sets data-tag from metadata.tag", () => {
    const { container } = render(
      <AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />,
    );
    expect(container.querySelector('[data-testid="app-card"]')!.getAttribute("data-tag"))
      .toBe("social");
  });
});

describe("AppCard — badges", () => {
  it("renders the moddable chip when details.metadata.repository is set", () => {
    const details: AppDetails = {
      metadata: {
        name: "Moddable App",
        repository: "https://github.com/example/repo",
      },
    };
    render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-moddable-chip")).toBeInTheDocument();
  });

  it("sets data-moddable='true' when repository present, 'false' when absent", () => {
    const moddable: AppDetails = { metadata: { name: "A", repository: "https://x" } };
    const plain: AppDetails = { metadata: { name: "B" } };

    const r1 = render(<AppCard entry={baseEntry} details={moddable} onSelect={vi.fn()} />);
    expect(r1.container.querySelector('[data-testid="app-card"]')!.getAttribute("data-moddable"))
      .toBe("true");
    r1.unmount();

    const r2 = render(<AppCard entry={baseEntry} details={plain} onSelect={vi.fn()} />);
    expect(r2.container.querySelector('[data-testid="app-card"]')!.getAttribute("data-moddable"))
      .toBe("false");
  });

  it("renders the Private badge when visibility === VISIBILITY_PRIVATE", () => {
    const privateEntry: AppEntry = { ...baseEntry, visibility: VISIBILITY_PRIVATE };
    render(<AppCard entry={privateEntry} onSelect={vi.fn()} />);
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("does NOT render the Private badge for public entries", () => {
    render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    expect(screen.queryByText("Private")).toBeNull();
  });

  it("sets data-pinned='true' when entry.pinned, 'false' otherwise", () => {
    const pinned: AppEntry = { ...baseEntry, pinned: true };

    const r1 = render(<AppCard entry={pinned} onSelect={vi.fn()} />);
    expect(r1.container.querySelector('[data-testid="app-card"]')!.getAttribute("data-pinned"))
      .toBe("true");
    r1.unmount();

    const r2 = render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    expect(r2.container.querySelector('[data-testid="app-card"]')!.getAttribute("data-pinned"))
      .toBe("false");
  });
});

describe("AppCard — stars", () => {
  it("renders the star count when starCount > 0", () => {
    const details: AppDetails = {
      metadata: { name: "X" },
      starCount: 7,
    };
    render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-stars")).toHaveTextContent("7");
  });

  it("hides the star count when starCount is 0 or undefined", () => {
    const r1 = render(
      <AppCard entry={baseEntry} details={{ metadata: { name: "X" }, starCount: 0 }} onSelect={vi.fn()} />,
    );
    expect(r1.container.querySelector('[data-testid="card-stars"]')).toBeNull();
    r1.unmount();

    const r2 = render(<AppCard entry={baseEntry} details={{ metadata: { name: "X" } }} onSelect={vi.fn()} />);
    expect(r2.container.querySelector('[data-testid="card-stars"]')).toBeNull();
  });

  it("does not render a rating average (rating UI removed in favour of binary star)", () => {
    const details: AppDetails = { metadata: { name: "X" }, starCount: 3 };
    const { container } = render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(container.querySelector(".card-rating-avg")).toBeNull();
  });
});

describe("AppCard — mods", () => {
  it("renders the modder count when modCount > 0", () => {
    const details: AppDetails = {
      metadata: { name: "X" },
      modCount: 4,
    };
    render(<AppCard entry={baseEntry} details={details} onSelect={vi.fn()} />);
    expect(screen.getByTestId("card-modcount")).toHaveTextContent("4× modded");
  });

  it("hides the modder count when modCount is 0 or undefined", () => {
    const r1 = render(
      <AppCard entry={baseEntry} details={{ metadata: { name: "X" }, modCount: 0 }} onSelect={vi.fn()} />,
    );
    expect(r1.container.querySelector('[data-testid="card-modcount"]')).toBeNull();
    r1.unmount();

    const r2 = render(<AppCard entry={baseEntry} details={{ metadata: { name: "X" } }} onSelect={vi.fn()} />);
    expect(r2.container.querySelector('[data-testid="card-modcount"]')).toBeNull();
  });
});

describe("AppCard — interaction", () => {
  it("invokes onSelect with the entry when the card is clicked", () => {
    const onSelect = vi.fn();
    render(<AppCard entry={baseEntry} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("app-card"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(baseEntry);
  });

  it("sets data-domain to the entry's domain for grid-scoped locators", () => {
    // e2e helpers rely on `[data-testid="app-card"][data-domain="<x>"]` selectors;
    // pin this attribute so a refactor that drops it surfaces in unit tests
    // before breaking the whole e2e suite.
    const { container } = render(<AppCard entry={baseEntry} onSelect={vi.fn()} />);
    const card = container.querySelector('[data-testid="app-card"]')!;
    expect(card.getAttribute("data-domain")).toBe("example.dot");
  });
});
