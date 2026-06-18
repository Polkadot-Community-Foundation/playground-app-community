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

import type { MouseEvent } from "react";
import { ExternalLink } from "lucide-react";
import { handleExternalClick } from "./utils/externalNavigation.ts";
import { addUserActionBreadcrumb } from "./lib/telemetry";

interface LaunchButtonProps {
  /** The app's `.dot` domain — its live URL is derived as `https://<slug>.dot.li`. */
  domain: string;
  className?: string;
  "data-testid"?: string;
}

/** Filled "Launch" pill that opens an app's live `*.dot.li` URL. Shared by the
 *  Apps grid cards and the App Detail Page so both stay in lockstep. */
export default function LaunchButton({ domain, className, "data-testid": testId = "app-post-launch" }: LaunchButtonProps) {
  const slug = domain.replace(/\.dot$/, "");
  const launchHref = `https://${slug}.dot.li`;

  const handleLaunch = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    addUserActionBreadcrumb("Launch app", { domain });
    handleExternalClick(e);
  };

  return (
    <a
      className={className ? `btn-primary ${className}` : "btn-primary"}
      href={launchHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleLaunch}
      data-testid={testId}
    >
      <ExternalLink size={14} aria-hidden="true" />
      <span>Launch</span>
    </a>
  );
}
