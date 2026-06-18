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

import { LaptopMinimal } from "lucide-react";
import { useIsMobile } from "./utils";

type Props = {
  /**
   * Mobile-only line under the pill (e.g. "Building happens on your laptop —
   * come back to these steps there."). Omit on compact surfaces like the
   * island quest windows, where the pill alone carries the message.
   */
  notice?: string;
};

/**
 * "Laptop required" pill marking RevX/CLI instructions — on a phone the host
 * covers the site builder, starring, and usernames only; building happens on
 * a laptop. Mobile-only: on a desktop viewport the reader is already on a
 * laptop, so the whole flag renders nothing.
 */
export default function LaptopRequiredFlag({ notice }: Props) {
  const isMobile = useIsMobile();
  if (!isMobile) return null;
  return (
    <div className="laptop-flag" data-testid="laptop-required-flag">
      <span className="filter-pill is-filled laptop-badge" data-tag="laptop">
        <LaptopMinimal size={14} aria-hidden="true" />
        Laptop required
      </span>
      {notice && (
        <p className="laptop-notice" data-testid="laptop-required-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
