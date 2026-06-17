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

/**
 * Username display helpers: the deterministic anonymous-name generator, the
 * profile-identifier resolver, and the profile-route / hue / short-address
 * utilities. Display fallbacks live in `displayNameForAccount` so the same
 * precedence (verified username → deterministic generated name) is used
 * everywhere. Username reading + claiming has moved to the verified-identity
 * flow (`utils/identity.ts`): `useRootUsername` / `useRootUsernamesBatch` for
 * reads, `revealIdentity` for the write (becoming a builder).
 */

export const ZERO_H160 = `0x${"0".repeat(40)}` as const;

/**
 * Truncate an H160 to "0xabcd…1234" for compact display. Mirrors
 * `Leaderboard.shortAddr` but lives here so it can be shared without an
 * import cycle through the leaderboard component.
 */
export function shortAddr(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function isH160Address(input: string): input is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(input);
}

const ANONYMOUS_DESCRIPTORS = [
  "anonymous",
  "clandestine",
  "concealed",
  "cloaked",
  "covert",
  "cryptic",
  "disguised",
  "faceless",
  "furtive",
  "ghosted",
  "hidden",
  "hushed",
  "lowkey",
  "mysterious",
  "mystery",
  "masked",
  "nameless",
  "obscure",
  "incognito",
  "phantom",
  "private",
  "pseudonymous",
  "shrouded",
  "secret",
  "shadow",
  "silent",
  "stealthy",
  "unknown",
  "unseen",
  "veiled",
] as const;

const ANIMALS = [
  "aardvark",
  "albatross",
  "alpaca",
  "antelope",
  "armadillo",
  "axolotl",
  "badger",
  "barracuda",
  "beaver",
  "bison",
  "bobcat",
  "bonobo",
  "buffalo",
  "camel",
  "capybara",
  "caracal",
  "cassowary",
  "cheetah",
  "chinchilla",
  "chimera",
  "cobra",
  "cougar",
  "coyote",
  "crane",
  "crocodile",
  "deer",
  "dingo",
  "dolphin",
  "donkey",
  "dragon",
  "eagle",
  "echidna",
  "eel",
  "elephant",
  "elk",
  "falcon",
  "ferret",
  "flamingo",
  "fox",
  "frog",
  "gazelle",
  "gecko",
  "giraffe",
  "goat",
  "goose",
  "gorilla",
  "griffin",
  "hare",
  "hawk",
  "hedgehog",
  "heron",
  "hippo",
  "hippogriff",
  "hyena",
  "ibex",
  "iguana",
  "jackal",
  "jaguar",
  "jellyfish",
  "kangaroo",
  "kestrel",
  "kiwi",
  "koala",
  "kraken",
  "lemur",
  "leopard",
  "leviathan",
  "lion",
  "llama",
  "lobster",
  "lynx",
  "macaw",
  "manatee",
  "manticore",
  "manta",
  "marten",
  "meerkat",
  "minotaur",
  "moose",
  "narwhal",
  "newt",
  "nightingale",
  "orca",
  "oryx",
  "ostrich",
  "otter",
  "owl",
  "panda",
  "panther",
  "parrot",
  "peacock",
  "pegasus",
  "penguin",
  "phoenix",
  "platypus",
  "porcupine",
  "puffin",
  "python",
  "quokka",
  "rabbit",
  "raven",
  "salamander",
  "seal",
  "serval",
  "shark",
  "skink",
  "sloth",
  "sparrow",
  "sphinx",
  "squid",
  "stoat",
  "swan",
  "tapir",
  "tiger",
  "toad",
  "toucan",
  "turtle",
  "unicorn",
  "viper",
  "wallaby",
  "whale",
  "wolf",
  "wombat",
  "wyvern",
  "yak",
  "zebra",
] as const;

function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pickDeterministic<const T extends readonly string[]>(
  words: T,
  seed: string,
  salt: string,
): T[number] {
  return words[hashString(`${seed}:${salt}`) % words.length];
}

/**
 * A short, stable, per-account discriminator: the last 4 hex of the address.
 * There are only ANONYMOUS_DESCRIPTORS × ANIMALS (~3.8k) animal-name pairs, so
 * by the birthday bound two accounts start sharing a pair at ~70 users — and
 * since "Stay anon" *claims* the animal handle on-chain (one global owner per
 * name), a bare pair would make most users unable to claim their own anonymous
 * name. Appending the address tail lifts the space to ~3.8k × 65,536 ≈ 248M,
 * so the handle is effectively always free to claim. Derived from the same
 * lowercased seed as the word picks, so it's deterministic and case-insensitive
 * (non-hex chars are stripped first, guarding against a non-H160 seed).
 */
function accountDiscriminator(seed: string): string {
  return seed.replace(/[^0-9a-f]/g, "").slice(-4).padStart(4, "0");
}

/**
 * The anonymous identity for an account, as a ready-to-claim registry handle:
 * "<descriptor>-<animal>-<hex>" (e.g. "silent-stoat-1324"). This is shown
 * verbatim everywhere — profile, leaderboard, cards, the Set-username dialog —
 * and is exactly what "Stay anon" writes on-chain, so the displayed name never
 * changes shape when claimed. The `-hex` tail keeps it unique (see
 * `accountDiscriminator`); descriptor/animal are lowercase words, so the
 * hyphen-join is already a valid handle.
 */
export function deterministicNameForAccount(account: string | null | undefined): string {
  const seed = account?.trim().toLowerCase();
  if (!seed) return "";
  return [
    pickDeterministic(ANONYMOUS_DESCRIPTORS, seed, "anonymous"),
    pickDeterministic(ANIMALS, seed, "animal"),
    accountDiscriminator(seed),
  ].join("-");
}

// The palette's blue is reserved for the connected user's own profile; every
// other account hashes into the remaining hues so a builder keeps the same
// color on every visit and blue always means "me".
const PROFILE_HUE_SELF = "var(--cat-social)";
const PROFILE_HUES_OTHERS = [
  "var(--cat-site)",
  "var(--cat-utility)",
  "var(--cat-gaming)",
  "var(--cat-marketplace)",
  "var(--cat-chat)",
  "var(--cat-irl)",
] as const;

export function profileHueForAccount(
  account: string | null | undefined,
  isSelf: boolean,
): string {
  if (isSelf) return PROFILE_HUE_SELF;
  const seed = account?.trim().toLowerCase();
  if (!seed) return PROFILE_HUE_SELF;
  return pickDeterministic(PROFILE_HUES_OTHERS, seed, "hue");
}

/**
 * Public-profile route for an account. Always the H160 — `resolveProfileIdentifier`
 * is H160-only since usernames moved to the People chain (no contract-side
 * reverse index), so a username segment would dead-end on "Profile not found".
 * The displayed name (verified username / generated handle) is chosen separately
 * at the link's render site; only the URL is pinned to the address.
 */
export function profilePathForAccount(account: string): string {
  return `/profile/${encodeURIComponent(account)}`;
}

export type ProfileIdentifierResolution = {
  address: `0x${string}`;
  lookup: "address" | "username";
  normalizedInput: string;
};

/**
 * Resolve a public profile route segment into the owner H160 used by the
 * owner-app queries. Profile URLs are H160-only: a valid H160 passes through
 * directly; any non-H160 segment returns `null` (PublicProfilePage renders its
 * "Profile not found" state). The old username reverse-index lookup was dropped
 * with the move to the verified-identity model — usernames now live on the
 * People chain and have no contract-side reverse index. The async signature is
 * kept so callers don't need to change. `lookup` stays a union for the same
 * reason, though only `"address"` is ever returned now.
 */
export async function resolveProfileIdentifier(
  raw: string,
): Promise<ProfileIdentifierResolution | null> {
  const input = raw.trim();
  if (!input) return null;

  if (isH160Address(input)) {
    return {
      address: input.toLowerCase() as `0x${string}`,
      lookup: "address",
      normalizedInput: input.toLowerCase(),
    };
  }

  return null;
}

/**
 * Display-name precedence:
 *   1. registry username (the user's chosen handle)
 *   2. "…" while the username is still unknown (`undefined` — the chain
 *      read hasn't succeeded yet). The generated name must never paint
 *      over a real handle just because a query is slow or failed (#324).
 *   3. deterministic generated name — only once the chain CONFIRMED no
 *      name is set (`null`).
 * Stays in one place so leaderboard, MyApps header, and badge UIs all agree.
 */
export function displayNameForAccount(
  registryUsername: string | null | undefined,
  h160: string | null | undefined,
): string {
  const username = registryUsername?.trim();
  if (username) return username;
  if (registryUsername === undefined) return "…";
  return deterministicNameForAccount(h160);
}
