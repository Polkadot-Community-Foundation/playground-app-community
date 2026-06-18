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
import { celebrationForEvent } from "./xpCelebration";
import { XP_VALUES } from "./xpValues";

describe("celebrationForEvent", () => {
  it("celebrates a deploy award with the launch label and amount", () => {
    expect(celebrationForEvent({ name: "DeployPointAwarded", pointDelta: 1 })).toEqual({
      xp: XP_VALUES.deploy,
      label: "Site deployed!",
    });
  });

  it("celebrates a mod award", () => {
    expect(celebrationForEvent({ name: "ModPointAwarded", pointDelta: 1 })).toEqual({
      xp: XP_VALUES.modReceived,
      label: "Someone modded your app!",
    });
  });

  it("celebrates a star award", () => {
    expect(celebrationForEvent({ name: "StarPointAwarded", pointDelta: 1 })).toEqual({
      xp: XP_VALUES.starReceived,
      label: "Someone starred your app!",
    });
  });

  it("celebrates an identity bonus", () => {
    expect(celebrationForEvent({ name: "IdentityBonusAwarded", pointDelta: 1 })).toEqual({
      xp: XP_VALUES.identity,
      label: "You're a builder!",
    });
  });

  it("maps the legacy publish award to the deploy celebration", () => {
    expect(celebrationForEvent({ name: "PlaygroundPublishPointAwarded", pointDelta: 1 })).toEqual({
      xp: XP_VALUES.deploy,
      label: "Site deployed!",
    });
  });

  it("does not celebrate a score-decreasing event (refund)", () => {
    expect(celebrationForEvent({ name: "StarPointRefunded", pointDelta: -1 })).toBeNull();
  });

  it("does not celebrate a known award name carrying a non-award delta", () => {
    // Belt-and-suspenders: the delta guard wins even for a whitelisted name.
    expect(celebrationForEvent({ name: "StarPointAwarded", pointDelta: -1 })).toBeNull();
  });

  it("does not celebrate the legacy moddable award (unpriced, no longer emitted)", () => {
    expect(celebrationForEvent({ name: "ModdablePointAwarded", pointDelta: 1 })).toBeNull();
  });

  it("does not celebrate non-points events", () => {
    expect(celebrationForEvent({ name: "Published", pointDelta: undefined })).toBeNull();
    expect(celebrationForEvent({ name: "IdentityLinked", pointDelta: undefined })).toBeNull();
  });
});
