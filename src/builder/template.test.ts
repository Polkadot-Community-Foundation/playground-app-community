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

import { describe, it, expect } from "vitest";
import { descriptionFromHtml, firstImageCidFromHtml } from "./template.ts";

describe("firstImageCidFromHtml", () => {
  it("extracts the CID from the first Bulletin <img>", () => {
    const html = `<h1>Hi</h1><img src="https://gw.example/ipfs/QmABC123" alt="x">`;
    expect(firstImageCidFromHtml(html)).toBe("QmABC123");
  });

  it("stops at a path / query / fragment after the CID", () => {
    expect(
      firstImageCidFromHtml(`<img src="https://gw/ipfs/QmABC/file.png?v=2#frag">`),
    ).toBe("QmABC");
  });

  it("takes the FIRST image when several are present", () => {
    const html = `<img src="https://gw/ipfs/QmFIRST"><img src="https://gw/ipfs/QmSECOND">`;
    expect(firstImageCidFromHtml(html)).toBe("QmFIRST");
  });

  // The auto-icon must stay absent when the page has no real image, so the
  // listing keeps today's placeholder tile instead of a broken icon link.
  it("returns undefined for no image, the placeholder stub, or an empty src", () => {
    expect(firstImageCidFromHtml("<h1>No images here</h1>")).toBeUndefined();
    expect(firstImageCidFromHtml(`<img src="https://">`)).toBeUndefined();
    expect(firstImageCidFromHtml(`<img src="">`)).toBeUndefined();
  });
});

describe("descriptionFromHtml", () => {
  it("takes the first paragraph and strips inner tags", () => {
    expect(descriptionFromHtml("<h1>Title</h1><p>Hello <b>world</b></p>")).toBe(
      "Hello world",
    );
  });

  it("decodes common entities and collapses whitespace", () => {
    expect(descriptionFromHtml("<p>A &amp;  B\n  C</p>")).toBe("A & B C");
  });

  it("returns empty string when there is no paragraph", () => {
    expect(descriptionFromHtml("<h1>Just a heading</h1>")).toBe("");
  });

  it("truncates past maxLen with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = descriptionFromHtml(`<p>${long}</p>`, 160);
    expect(out.length).toBe(160);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched (no ellipsis)", () => {
    const out = descriptionFromHtml("<p>Short and sweet</p>", 160);
    expect(out).toBe("Short and sweet");
  });
});
