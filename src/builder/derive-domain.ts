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

// Pure string derivation — deliberately dependency-free so the editor UI can
// import it without pulling the chain stack (deploy.ts and everything under
// lib/) into the initial bundle.

// Latin letters that DON'T decompose to base+combining under NFD, so the
// diacritic strip can't reach them. Non-Latin scripts (Cyrillic, CJK, …)
// have no cheap transliteration and fall through to the "hello" fallback.
const LATIN_SPECIALS: Record<string, string> = {
    ø: "o", ß: "ss", æ: "ae", œ: "oe", đ: "d", ð: "d", ħ: "h",
    ł: "l", ŋ: "n", þ: "th", ŧ: "t", ı: "i", ĸ: "k",
};

// Auto-derive a NoStatus-shape label from the rendered header text. Matches
// `dot decentralize`'s rule: base ≥9 + exactly 2 trailing digits → NoStatus.
export function deriveDomain(seed: string): string {
    let s = seed
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics: café → cafe, not caf-
        .toLowerCase()
        .replace(/[øßæœđðħłŋþŧıĸ]/g, (c) => LATIN_SPECIALS[c] ?? c)
        .replace(/['’‘`´ʼ]/g, "") // sveta's → svetas, not sveta-s
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!s) s = "hello";
    if (s.length > 24) s = s.slice(0, 24).replace(/-+$/, "");
    const letters = Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map((b) => String.fromCharCode(97 + (b % 26)))
        .join("");
    const digits = String((crypto.getRandomValues(new Uint8Array(1))[0] % 90) + 10);
    const minPrefixLen = 9;
    const prefixLen = s.length + 1;
    const padded =
        prefixLen + letters.length >= minPrefixLen
            ? letters
            : letters + "abcd".slice(0, Math.max(0, minPrefixLen - prefixLen - letters.length));
    return `${s}-${padded}${digits}`;
}
