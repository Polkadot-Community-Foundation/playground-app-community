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

import { describe, expect, it } from "vitest";
import { readmeBlurb } from "./readme.ts";

describe("readmeBlurb", () => {
  it("returns undefined for empty / missing input", () => {
    expect(readmeBlurb(undefined)).toBeUndefined();
    expect(readmeBlurb("")).toBeUndefined();
    expect(readmeBlurb("\n\n   \n")).toBeUndefined();
  });

  it("skips the leading H1 title and gathers the opening prose across paragraphs", () => {
    const readme = "# My Cool App\n\nA tiny game you can mod and deploy.\n\nMore details.";
    expect(readmeBlurb(readme)).toBe("A tiny game you can mod and deploy. More details.");
  });

  it("stops gathering at the next structural block (heading / list / code)", () => {
    const readme = [
      "# Title",
      "",
      "The intro paragraph.",
      "",
      "## Install",
      "",
      "npm install whatever",
    ].join("\n");
    expect(readmeBlurb(readme)).toBe("The intro paragraph.");
  });

  it("skips a literal 'readme' heading", () => {
    const readme = "# README\n\nThe actual summary line.";
    expect(readmeBlurb(readme)).toBe("The actual summary line.");
  });

  it("skips badge / shield / image-only lines", () => {
    const readme = [
      "# Project",
      "",
      "[![CI](https://img.shields.io/badge/ci-passing-green)](https://ci.example)",
      "![hero](./hero.png)",
      "",
      "Prose starts here.",
    ].join("\n");
    expect(readmeBlurb(readme)).toBe("Prose starts here.");
  });

  it("strips inline markdown (links, emphasis, code)", () => {
    const readme = "Build with **Polkadot** and [the SDK](https://example.com) using `cargo`.";
    expect(readmeBlurb(readme)).toBe("Build with Polkadot and the SDK using cargo.");
  });

  it("skips horizontal rules and HTML comments", () => {
    const readme = "<!-- hidden -->\n---\n\nReal content.";
    expect(readmeBlurb(readme)).toBe("Real content.");
  });

  it("truncates long prose on a word boundary with an ellipsis", () => {
    const long = `# Title\n\n${"word ".repeat(120).trim()}.`;
    const out = readmeBlurb(long)!;
    expect(out.length).toBeLessThanOrEqual(301); // 300 cap + ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
  });

  it("handles a README that opens straight into prose", () => {
    expect(readmeBlurb("Just a description, no heading.")).toBe(
      "Just a description, no heading.",
    );
  });
});
