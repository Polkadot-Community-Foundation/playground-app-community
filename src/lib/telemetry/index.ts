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

export { journeyTracker, JourneyTracker } from "./journey-tracker.ts";
export type { AppJourneyType } from "./journey-tracker.ts";
export { SpanOp } from "./span-ops.ts";
export type { SpanOpValue } from "./span-ops.ts";
export { BreadcrumbCategory } from "./breadcrumb-categories.ts";
export type { BreadcrumbCategoryValue } from "./breadcrumb-categories.ts";
export {
  addUiBreadcrumb,
  addUserActionBreadcrumb,
  addAdminActionBreadcrumb,
  captureWarning,
} from "./breadcrumb-helpers.ts";
export { isExpectedError, isPaymentError, isSigningRejection } from "./expected-errors.ts";
