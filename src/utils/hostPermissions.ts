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

// Shared host-permission grants, each cached per page session so the onboarding
// "Collect my resources" step and the later write/publish paths share ONE grant
// apiece — granting during onboarding makes subsequent writes/uploads prompt-free.

import { requestPermission } from "@parity/product-sdk-host";
import { SIGN_DEADLINE_MS, withDeadline } from "./deadline.ts";

// requestPermission prompts over the desktop↔phone bridge — the same transport
// that can WEDGE (WebView frozen mid-approval) and never settle. Unbounded, a
// hung prompt pins whatever awaits the grant: the deploy store is covered by an
// outer deadline in deploy.ts, but the image-upload path (storeBytes host
// route) is not — its spinner would spin forever. Deadline every grant so a
// dead bridge falls through to the best-effort catch instead of hanging; the
// sign/submit that follows is the real authority anyway. SIGN_DEADLINE_MS (90s)
// leaves room for a genuine first-time approval on the phone.
function requestPermissionBounded(
  permission: Parameters<typeof requestPermission>[0],
): Promise<boolean> {
  return withDeadline(requestPermission(permission), SIGN_DEADLINE_MS, "Requesting host permission");
}

// ChainSubmit — the host "broadcast signed transactions" permission, which gates
// signing on the product-account path. Idempotent per page session, best-effort:
// if the host denies / is unavailable, the sign call itself is the authority.
let chainSubmitGranted = false;
export async function ensureChainSubmitPermission(): Promise<void> {
  if (chainSubmitGranted) return;
  try {
    if (await requestPermissionBounded({ tag: "ChainSubmit", value: undefined })) {
      chainSubmitGranted = true;
    }
  } catch {
    // Fall through — the sign call itself is the authority.
  }
}

// RFC-0002 PreimageSubmit — the host Bulletin preimage-submission permission.
// Idempotent per session, best-effort: a host without RFC-0002 prompts (or fails
// loud) at submit time.
let preimageGranted = false;
export async function ensurePreimagePermission(): Promise<void> {
  if (preimageGranted) return;
  try {
    if (await requestPermissionBounded({ tag: "PreimageSubmit", value: undefined })) {
      preimageGranted = true;
    }
  } catch {
    // Fall through — the submit itself is the authority.
  }
}
