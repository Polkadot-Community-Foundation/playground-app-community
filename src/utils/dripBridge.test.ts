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
import { registerBecomeBuilderTrigger, triggerBecomeBuilder } from "./dripBridge.ts";

describe("dripBridge", () => {
  beforeEach(() => registerBecomeBuilderTrigger(null));
  it("forwards to the registered trigger", () => {
    const fn = vi.fn();
    registerBecomeBuilderTrigger(fn);
    triggerBecomeBuilder();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("is a no-op when nothing is registered", () => {
    expect(() => triggerBecomeBuilder()).not.toThrow();
  });
  it("unregisters with null", () => {
    const fn = vi.fn();
    registerBecomeBuilderTrigger(fn);
    registerBecomeBuilderTrigger(null);
    triggerBecomeBuilder();
    expect(fn).not.toHaveBeenCalled();
  });
});
