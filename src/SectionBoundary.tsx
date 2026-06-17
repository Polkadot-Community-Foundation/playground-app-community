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

import type { ReactNode } from "react";
import * as Sentry from "@sentry/react";

export default function SectionBoundary({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return (
    // Keyed by name: adjacent routes both rooted in a SectionBoundary occupy
    // the same tree position, so React reuses the instance across navigation
    // — INCLUDING its has-error state. Without the key, a crash in one
    // section showed the fallback for the NEXT section the user navigated
    // to, even though that section was fine.
    <Sentry.ErrorBoundary
      key={name}
      beforeCapture={(scope) => scope.setTag("boundary", name)}
      fallback={({ error, resetError }) => (
        <div className="empty">
          <p>Something went wrong here.</p>
          {/* Surface the cause: on devices without devtools (mobile host),
              this line is the only diagnostic anyone can read or report. */}
          <p className="boundary-error-detail">
            {error instanceof Error ? `${error.name}: ${error.message}` : String(error)}
          </p>
          <button className="btn btn-ghost" onClick={resetError}>Retry</button>
        </div>
      )}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
}
