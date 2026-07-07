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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectEnvironment } from "./environment";

// Each host injects different window globals; these helpers paint one host's
// signals so detectEnvironment can be exercised in isolation.
function setViewportMobile(matches: boolean) {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches } as MediaQueryList) as typeof window.matchMedia;
}

describe("detectEnvironment", () => {
  beforeEach(() => {
    delete window.__HOST_WEBVIEW_MARK__;
    delete window.Android;
    delete window.webkit;
    setViewportMobile(false); // wide viewport unless a test says otherwise
  });

  it("returns 'mobile' for any mobile-sized viewport — even inside the Desktop host", () => {
    // The viewport check comes first: a mobile browser is mobile, and a Desktop
    // window narrowed past the breakpoint matches its reordered mobile layout.
    window.__HOST_WEBVIEW_MARK__ = true;
    setViewportMobile(true);
    expect(detectEnvironment()).toBe("mobile");
  });

  it("returns 'mobile' for a plain mobile browser", () => {
    setViewportMobile(true);
    expect(detectEnvironment()).toBe("mobile");
  });

  it("returns 'mobile' for a wide-viewport iOS host (e.g. tablet)", () => {
    window.__HOST_WEBVIEW_MARK__ = true;
    window.webkit = { messageHandlers: { __container__: {} } };
    expect(detectEnvironment()).toBe("mobile");
  });

  it("returns 'mobile' for a wide-viewport Android host (e.g. tablet)", () => {
    window.__HOST_WEBVIEW_MARK__ = true;
    window.Android = { call: () => "" };
    expect(detectEnvironment()).toBe("mobile");
  });

  it("returns 'desktop' for Polkadot Desktop on a wide viewport", () => {
    // Webview mark set, no mobile bridge, wide viewport.
    window.__HOST_WEBVIEW_MARK__ = true;
    expect(detectEnvironment()).toBe("desktop");
  });

  it("returns 'web' for the dot.li gateway / plain browser on a wide viewport", () => {
    // dot.li injects nothing (no mark, no bridge); a wide browser is "web".
    expect(detectEnvironment()).toBe("web");
  });
});
