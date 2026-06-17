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

import { defineConfig } from "bulletin-deploy";

declare const process: { env?: Record<string, string | undefined> };

// Set APP_DOTNS_DOMAIN to the bare label, e.g. `playground` or `playgroundtest`.
const domain = process.env?.APP_DOTNS_DOMAIN;
if (!domain) throw new Error("APP_DOTNS_DOMAIN is required");
const label = domain.toLowerCase().replace(/\.dot$/, "");

export default defineConfig({
  domain: `${label}.dot`,
  displayName: "playground.dot",
  description:
    "Build and mod sovereign apps on Polkadot. A registry browser and quest platform for the Web3 Summit Developer Lab.",
  icon: { path: "./assets/icon.png", format: "png" },
  executables: [
    {
      kind: "app",
      path: "./dist",
      appVersion: [0, 1, 0],
    },
    // Widget is staged but not yet a separate build target — the SPA serves
    // the widget UI at /widget today (see src/MyAppsWidget.tsx). Add a
    // `build:widget` script that outputs ./dist/widget, then uncomment.
    // {
    //   kind: "widget",
    //   path: "./dist/widget",
    //   appVersion: [0, 1, 0],
    //   description: "Your published apps and XP at a glance.",
    //   dimensions: { height: [4, 8], width: 1 },
    // },
  ],
});
