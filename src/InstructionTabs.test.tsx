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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// Control the auto-detected default tab.
vi.mock("./utils/environment", () => ({
  detectEnvironment: vi.fn(() => "web"),
}));

import InstructionTabs from "./InstructionTabs";
import { detectEnvironment } from "./utils/environment";

const mockDetect = vi.mocked(detectEnvironment);

function renderTabs(opts: { mobile?: boolean } = {}) {
  return render(
    <InstructionTabs
      desktop={<p>desktop steps</p>}
      web={<p>web steps</p>}
      mobile={opts.mobile ? <p>mobile steps</p> : undefined}
    />,
  );
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("InstructionTabs", () => {
  beforeEach(() => mockDetect.mockReturnValue("web"));
  afterEach(cleanup);

  it("always renders Desktop / Web / Mobile tabs", () => {
    renderTabs();
    expect(tab(/desktop/i)).toBeInTheDocument();
    expect(tab(/web/i)).toBeInTheDocument();
    expect(tab(/mobile/i)).toBeInTheDocument();
  });

  it("defaults to the detected environment's tab", () => {
    mockDetect.mockReturnValue("mobile");
    renderTabs({ mobile: true });
    expect(tab(/mobile/i)).toHaveAttribute("aria-selected", "true");
    expect(tab(/desktop/i)).toHaveAttribute("aria-selected", "false");
  });

  it("switches tabs on click", () => {
    renderTabs();
    expect(tab(/web/i)).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tab(/desktop/i));
    expect(tab(/desktop/i)).toHaveAttribute("aria-selected", "true");
    expect(tab(/web/i)).toHaveAttribute("aria-selected", "false");
  });

  it("shows the supplied mobile content when present", () => {
    mockDetect.mockReturnValue("mobile");
    renderTabs({ mobile: true });
    expect(tab(/mobile/i)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("mobile steps")).toBeInTheDocument();
    expect(screen.queryByText(/need a computer/i)).not.toBeInTheDocument();
  });

  it("explains a computer is needed when there is no mobile path", () => {
    mockDetect.mockReturnValue("mobile");
    renderTabs({ mobile: false });
    expect(tab(/mobile/i)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/need the help of a computer to complete this quest/i)).toBeInTheDocument();
  });
});
