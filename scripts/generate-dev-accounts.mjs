// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Generate N dev accounts for testing-session use — substitutes for //Alice
 * that aren't drained by the rest of the ecosystem.
 *
 * Each account has:
 *   - label (playground-dev-NN)
 *   - mnemonic (BIP-39, 12 words)
 *   - SS58 address
 *   - H160 address (keccak256(publicKey)-derived, matching Revive's mapping)
 *
 * Outputs JSON to stdout. The artifact lives at e2e/dev-accounts.json once
 * committed. Generated mnemonics are stable in that file; do NOT re-run this
 * script and overwrite e2e/dev-accounts.json — that would silently replace
 * already-whitelisted addresses and bust the testing-session inventory.
 *
 * Whitelisted via paritytech/dotns#151 (filed 2026-05-12).
 *
 * Usage:
 *   pnpm tsx scripts/generate-dev-accounts.mjs > e2e/dev-accounts.json
 */

import { generateMnemonic, BIP39_EN_WORDLIST } from "@polkadot-labs/hdkd-helpers";
import { seedToAccount } from "@parity/product-sdk-keys";

const COUNT = 10;

const accounts = [];
for (let i = 1; i <= COUNT; i++) {
  // 128-bit entropy → 12 words. Standard BIP-39.
  const mnemonic = generateMnemonic(128, BIP39_EN_WORDLIST);
  // Empty-path derivation — matches what dotNS CLI and personhood-faucet
  // produce from a bare BIP-39 mnemonic, and matches the e2e funder's
  // convention. The SDK's default (//0) would produce a different keypair
  // that tools can't reach without a URI suffix — and the personhood-faucet
  // form does client-side BIP-39 validation that rejects URI input, so //0
  // accounts can't get PoP via the standard flow. Keep this as "".
  const derived = seedToAccount(mnemonic, "");
  accounts.push({
    label: `playground-dev-${i.toString().padStart(2, "0")}`,
    mnemonic,
    ss58: derived.ss58Address,
    h160: derived.h160Address,
  });
}

console.log(JSON.stringify({
  $comment: "Testnet-only dev accounts. Use as //Alice substitutes during " +
    "testing sessions; faucet-friendly. Addresses derive via empty-path " +
    "(seedToAccount(mnemonic, \"\")), matching the e2e funder + the " +
    "dotNS-CLI / personhood-faucet default for bare mnemonics — single " +
    "convention across the stack. dotNS whitelist tracked across " +
    "individual issues per address. #152..#161 are the obsolete //0 " +
    "whitelist set (filed 2026-05-12, replaced 2026-05-15 after " +
    "discovering the personhood-faucet form rejects URI-form mnemonics). " +
    "DO NOT commit this output — file is gitignored. If you regenerate, " +
    "file fresh whitelist issues for the new addresses and treat the " +
    "previous mnemonics as compromised.",
  generated: new Date().toISOString(),
  accounts,
}, null, 2));
