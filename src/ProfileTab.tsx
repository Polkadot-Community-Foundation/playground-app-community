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

import { MyApps } from "./App";
import SectionBoundary from "./SectionBoundary.tsx";
import type { SignerState } from "./utils";
import type { AppEntry } from "./registryTypes";

type Props = {
  signer: SignerState;
  isAdmin: boolean;
  onMod: (entry: AppEntry) => void;
  /** Bumped on every point-award event — refreshes the XP total live. */
  pointsRefresh: number;
  /** Star an app. Threaded to AppCard so cards on a profile are starrable. */
  onStar: (domain: string) => Promise<void>;
};

export default function ProfileTab({ signer, isAdmin, onMod, pointsRefresh, onStar }: Props) {
  return (
    <div className="tab tab-profile">
      <SectionBoundary name="my-apps">
        <MyApps
          signer={signer}
          onMod={onMod}
          pointsRefresh={pointsRefresh}
          isAdmin={isAdmin}
          onStar={onStar}
        />
      </SectionBoundary>
    </div>
  );
}
