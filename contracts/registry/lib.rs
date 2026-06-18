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

#![no_main]
#![no_std]

extern crate pvm_contract as pvm_contract_sdk;

use alloc::string::String;
use common::revert;
use core::ops::Bound;
use parity_scale_codec::{Decode, Encode};
use pvm::storage::{Mapping, OrderedIndex};
use pvm::{Address, caller};
use pvm_contract as pvm;

/// Visibility levels for apps.
pub const VISIBILITY_PRIVATE: u8 = 0;
pub const VISIBILITY_PUBLIC: u8 = 1;
pub const MAX_VISIBILITY: u8 = 1; // bump when adding levels

/// Final XP amounts per issue #286. Numbers must match `src/xpValues.ts` on
/// the frontend; see that file for the award semantics and rationale.
pub const DEPLOY_XP: u128 = 100;
pub const MOD_RECEIVED_XP: u128 = 50;
pub const STAR_RECEIVED_XP: u128 = 10;
/// Awarded once on first verified identity bind.
pub const IDENTITY_BONUS_XP: u128 = 25;
/// Paseo Asset Hub uses 10 decimals: 1 PAS = 10^10 planck.
pub const PAS: u128 = 10_000_000_000;
/// Native-token amount sent by the contract-funded faucet.
pub const FAUCET_AMOUNT: u128 = 100 * PAS;
/// Revive `call` values are EVM-denominated wei (18 decimals), while PAS
/// native balances are planck-denominated with 10 decimals.
pub const WEI_PER_PLANCK: u128 = 100_000_000;
pub const FAUCET_CALL_VALUE: u128 = FAUCET_AMOUNT * WEI_PER_PLANCK;
pub const DEV_SIGNER_H160: [u8; 20] = [
    0x35, 0xcd, 0xb2, 0x3f, 0xf7, 0xfc, 0x86, 0xe8, 0xdc, 0xcd,
    0x57, 0x7c, 0xa3, 0x09, 0xbf, 0xea, 0x9c, 0x97, 0x8d, 0x20,
];
pub const BUILDER_DEV_SIGNER_H160: [u8; 20] = [
    0x41, 0xdc, 0xcb, 0xd4, 0x9b, 0x26, 0xc5, 0x0d, 0x34, 0x35,
    0x5e, 0xd8, 0x6f, 0xf0, 0xfa, 0x9e, 0x48, 0x9d, 0x1e, 0x01,
];

/// Lifetime cap on deploy XP awards granted per owner ("granted" = the
/// owner's `account_points` actually increased; nothing to do with tx
/// fees). The gate counts grants (`deploy_award_count`), not list slots —
/// publishes that award nothing (dev-signer, blacklisted) don't consume a
/// slot, so a developer who got their bearings on a dev signer still earns on
/// their first real deploys.
pub const DEPLOY_REWARD_COUNT: u32 = 3;

fn is_known_dev_signer(addr: &Address) -> bool {
    let bytes = *addr.as_fixed_bytes();
    bytes == DEV_SIGNER_H160 || bytes == BUILDER_DEV_SIGNER_H160
}

fn u128_to_u256_le(value: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&value.to_le_bytes());
    out
}

fn u256_max() -> [u8; 32] {
    [u8::MAX; 32]
}

#[derive(Default, Clone, Encode, Decode)]
pub struct AppInfo {
    pub owner: Address,
    pub visibility: u8,
    /// The `env::caller()` that submitted the first `publish` for this
    /// domain. Stored alongside `owner` so dev-mode iteration works: the
    /// CLI can publish with the user's H160 as `owner` (so the app shows
    /// in MyApps), then re-deploy many times signed by Alice without
    /// running into `Unauthorized` on subsequent updates. See
    /// `is_authorized` below for the auth-side use.
    pub publisher: Address,
}

/// One mod-lineage edge, stored SCALE-encoded in the append-only `lineage_at`
/// list. `child` was published as a mod of `source`. Recorded once per child
/// (see `publish`; also `import_lineage` for backfill).
#[derive(Default, Clone, Encode, Decode)]
pub struct LineageEdge {
    pub child: String,
    pub source: String,
}

#[derive(pvm::SolAbi)]
pub struct AppEntry {
    pub index: u32,
    pub domain: String,
    pub metadata_uri: String,
    pub owner: Address,
    pub visibility: u8,
    pub publisher: Address,
}

#[derive(pvm::SolAbi)]
pub struct AppData {
    pub domain: String,
    pub metadata_uri: Option<String>,
    pub owner: Address,
    pub visibility: u8,
    pub publisher: Address,
    pub star_count: u32,
    pub mod_count: u32,
    pub has_starred: bool,
}

#[derive(pvm::SolAbi)]
pub struct AppImport {
    pub domain: String,
    pub owner: Address,
    pub publisher: Address,
    pub visibility: u8,
    pub metadata_uri: String,
    /// Whether the source app was moddable on first publish — drives the
    /// launch-point award (2, or 3 if true) when the migration script
    /// replays this entry. The off-chain script reads this from the
    /// Bulletin metadata's `repository` field.
    pub is_moddable: bool,
}

#[derive(pvm::SolAbi)]
pub struct AppsPage {
    pub total: u32,
    pub scanned: u32,
    pub entries: Vec<AppEntry>,
}

/// ABI-encoded return row for `get_lineage` (storage uses SCALE; this is the
/// external read shape). `child` was published as a mod of `source`.
#[derive(pvm::SolAbi)]
pub struct LineageEntry {
    pub child: String,
    pub source: String,
}

/// Migration replay row for `import_lineage`.
#[derive(pvm::SolAbi)]
pub struct LineageImport {
    pub child: String,
    pub source: String,
}

/// Migration replay row for `import_points` — authoritative leaderboard total.
#[derive(pvm::SolAbi)]
pub struct PointImport {
    pub account: Address,
    pub total: u128,
}

/// Migration replay row for `import_social_counts` — per-domain star/mod counters.
#[derive(pvm::SolAbi)]
pub struct SocialImport {
    pub domain: String,
    pub star_count: u32,
    pub mod_count: u32,
}

/// Migration replay row for `import_identities` — verified root pubkey per
/// product account.
#[derive(pvm::SolAbi)]
pub struct IdentityImport {
    pub account: Address,
    pub root_pubkey: [u8; 32],
}

// ---------------------------------------------------------------------------
// Events — topic[0] is keccak256 of the event name, data is the domain bytes
//
// NOTE: this encoding is NOT compatible with standard Ethereum tooling.
// Solidity convention is `topic[0] = keccak256("Published(string)")` (full
// signature with parameter types) and ABI-encoded data. We use the bare event
// name and raw UTF-8 bytes for the domain because consumers are limited to
// this codebase's frontend listener. If we ever need viem/ethers/Etherscan
// compatibility, switch to: keccak256("EventName(types...)") for topic[0]
// and SolAbi-encode the payload.
// ---------------------------------------------------------------------------

fn event_topic(name: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pvm::api::hash_keccak_256(name, &mut out);
    out
}

fn emit_event(name: &[u8], domain: &String) {
    let topic = event_topic(name);
    pvm::api::deposit_event(&[topic], domain.as_bytes());
}

/// Emit an event whose data is SCALE-encoded from a typed payload. Used for
/// the points/mod/star events whose payloads carry more than just a domain.
/// Topic[0] is keccak256(event_name); data is the SCALE encoding of `payload`.
fn emit_typed_event<E: Encode>(name: &[u8], payload: &E) {
    let topic = event_topic(name);
    pvm::api::deposit_event(&[topic], &payload.encode());
}

/// Reconstruct the INNER identity-binding message the root account signs when
/// binding to `caller`:
///
///   "playground.dot identity v1\n" || contractAddr(20) || callerH160(20)
///
/// The host wraps this in `<Bytes>…</Bytes>` before sr25519-signing, so
/// `verify_identity_signature` reconstructs the wrapped form and verifies the
/// signature against it.
fn build_identity_message(caller_h160: &Address) -> Vec<u8> {
    let mut contract_addr = [0u8; 20];
    pvm::api::address(&mut contract_addr);
    let mut m = Vec::new();
    m.extend_from_slice(b"playground.dot identity v1\n");
    m.extend_from_slice(&contract_addr);
    m.extend_from_slice(caller_h160.as_fixed_bytes());
    m
}

/// Wrap `inner` in the `<Bytes>…</Bytes>` tags the host prepends/appends before
/// raw-signing (see `build_identity_message`).
fn wrap_in_bytes_tag(inner: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(inner.len() + b"<Bytes>".len() + b"</Bytes>".len());
    m.extend_from_slice(b"<Bytes>");
    m.extend_from_slice(inner);
    m.extend_from_slice(b"</Bytes>");
    m
}

/// Verify `signature` proves the holder of `pubkey` authorized binding
/// `caller_h160`. The host wraps the message in `<Bytes>…</Bytes>` before
/// sr25519-signing (the standard raw-signing convention), so reconstruct that
/// wrapped form and verify against it.
fn verify_identity_signature(signature: &[u8; 64], caller_h160: &Address, pubkey: &[u8; 32]) -> bool {
    let inner = build_identity_message(caller_h160);
    let wrapped = wrap_in_bytes_tag(&inner);
    verify_sr25519(signature, &wrapped, pubkey)
}

// ---------------------------------------------------------------------------
// sr25519 signature verification via the pallet-revive System precompile
//
// The System precompile (0x09..00) exposes a Solidity-ABI method
// `sr25519Verify(uint8[64] signature, bytes message, bytes32 publicKey)
// returns (bool)`. We build the calldata by hand and dispatch a read-only
// low-level `call` to it. See `verify_sr25519` for the encoding details.
//
// Why hand-roll the precompile call instead of the native host function?
// `pallet_revive_uapi` DOES expose `fn sr25519_verify(&[u8;64], &[u8], &[u8;32])`,
// but it is gated behind the crate's `unstable-hostfn` feature, which
// `pvm_contract` does not enable — so `pvm::api::sr25519_verify` does not exist
// in this build and calling it fails to compile. The System precompile is the
// only stable surface available, hence the manual ABI encoding below. Do NOT
// "simplify" this to a direct host-fn call without first enabling that feature
// upstream in `pvm_contract`.
// ---------------------------------------------------------------------------

/// System precompile exposing `sr25519Verify`. Equals
/// `pallet_revive_uapi::SYSTEM_PRECOMPILE_ADDR`; hardcoded here as the bare
/// 20-byte array because `hex_literal` is not a direct dependency.
const SYSTEM_PRECOMPILE_ADDR: [u8; 20] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x00,
];

/// `keccak256("sr25519Verify(uint8[64],bytes,bytes32)")[0..4]`.
/// Derived + verified in Task 1: keccak256 of the canonical signature string
/// is `0x307a575dd17a89609ce4399bd4e53bfb1761982d294b226933eaa63a25f90b3f`,
/// whose first 4 bytes are `30 7a 57 5d`. (Cross-checked with viem's
/// `toFunctionSelector` and a raw `keccak256(utf8(sig))`.)
const SR25519_VERIFY_SELECTOR: [u8; 4] = [0x30, 0x7a, 0x57, 0x5d];

/// Call the System precompile's `sr25519Verify`. `message` is the EXACT signed
/// bytes. Returns `true` iff the signature is valid for `(message, public_key)`.
///
/// Calldata layout (standard Solidity ABI):
///   - 4-byte selector
///   - `uint8[64]` FIXED array → 64 words of 32 bytes, each signature byte in
///     the LAST byte (offset +31) of its word (2048 bytes total)
///   - `bytes message` → a 32-byte head offset pointing at the tail, then in
///     the tail a 32-byte big-endian length followed by the data right-padded
///     to a 32-byte boundary
///   - `bytes32 publicKey` → inline 32 bytes
fn verify_sr25519(signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool {
    const SIG_WORDS_LEN: usize = 64 * 32; // uint8[64] fixed array
    let head_len = 4 + SIG_WORDS_LEN + 32 + 32; // selector + sig + msgOffset + pubkey
    let msg_words = message.len().div_ceil(32) * 32;
    let mut calldata = alloc::vec![0u8; head_len + 32 + msg_words];
    calldata[0..4].copy_from_slice(&SR25519_VERIFY_SELECTOR);
    for (i, b) in signature.iter().enumerate() {
        calldata[4 + i * 32 + 31] = *b; // each uint8 right-aligned in its word
    }
    let msg_offset = (head_len - 4) as u32; // offset measured from end of selector
    let off_slot = 4 + SIG_WORDS_LEN;
    calldata[off_slot + 28..off_slot + 32].copy_from_slice(&msg_offset.to_be_bytes());
    let pk_slot = 4 + SIG_WORDS_LEN + 32;
    calldata[pk_slot..pk_slot + 32].copy_from_slice(public_key);
    let len_slot = head_len;
    calldata[len_slot + 28..len_slot + 32].copy_from_slice(&(message.len() as u32).to_be_bytes());
    calldata[len_slot + 32..len_slot + 32 + message.len()].copy_from_slice(message);

    let mut out_buf = [0u8; 32];
    let mut out: &mut [u8] = &mut out_buf;
    let deposit = [0u8; 32];
    let value = [0u8; 32];
    let res = pvm::api::call(
        pvm::CallFlags::READ_ONLY,
        &SYSTEM_PRECOMPILE_ADDR,
        u64::MAX,
        u64::MAX,
        &deposit,
        &value,
        &calldata,
        Some(&mut out),
    );
    if res.is_err() {
        return false;
    }
    out_buf[31] == 1
}

// ---------------------------------------------------------------------------
// Event payload types — SCALE-encoded into deposit_event data
// ---------------------------------------------------------------------------

/// Used by DeployPointAwarded / PlaygroundPublishPointAwarded / ModdablePointAwarded.
#[derive(Encode, Decode)]
pub struct PointAwardEvent {
    pub recipient: Address,
    pub domain: String,
}

/// Used by ModPointAwarded.
#[derive(Encode, Decode)]
pub struct ModPointEvent {
    pub recipient: Address,
    pub source_domain: String,
    pub modder: Address,
    pub mod_domain: String,
}

/// Used by StarPointAwarded. Stars are permanent and star XP is awarded at
/// most once per `(voter, domain)`, see `star_awarded`.
#[derive(Encode, Decode)]
pub struct StarPointEvent {
    pub recipient: Address,
    pub domain: String,
    pub voter: Address,
}

/// SCALE payload for the identity events (`IdentityLinked`, `IdentityCleared`,
/// `IdentityBonusAwarded`). `root_pubkey` is the bound People-chain
/// `AccountId32`, zeroed on `IdentityCleared`.
#[derive(Encode)]
struct IdentityEvent {
    recipient: Address,
    root_pubkey: [u8; 32],
}

/// SCALE payload for `FaucetFailed`, emitted when the contract-funded faucet
/// cannot transfer native PAS to `recipient` — almost always because the
/// contract account itself is dry. The faucet is best-effort and NEVER reverts
/// its caller (so a reveal / anonymous-bonus / direct `faucet()` call still
/// succeeds), which makes this event the only on-chain signal that a top-up
/// silently failed. `amount` is the native-token value in planck that was
/// attempted, so a consumer can see how much the faucet still owes.
#[derive(Encode)]
struct FaucetEvent {
    recipient: Address,
    amount: u128,
}

// ---------------------------------------------------------------------------
// Points helpers
// ---------------------------------------------------------------------------

/// Return shape for `get_top_builders`. SolAbi for ABI-encoded reads.
#[derive(pvm::SolAbi)]
pub struct TopBuilderEntry {
    pub account: Address,
    pub score: u128,
}

/// Per-account points summary for the frontend. `total` matches the leaderboard
/// score. For ABI compatibility, `star_points` and `mod_points` currently carry
/// visible star/mod counts summed over the account's published apps, while
/// `launch_points` is unused.
#[derive(pvm::SolAbi)]
pub struct PointBreakdown {
    pub launch_points: u128,
    pub mod_points: u128,
    pub star_points: u128,
    pub total: u128,
}

/// Award `delta` points to `account`. Updates the running total and moves the
/// `points_index` entry from the old score to the new one so the leaderboard
/// stays sorted. Saturating on overflow.
///
/// `points_index` is keyed on `u128::MAX - score` so an ascending range scan
/// returns highest-scoring accounts first. Removal uses
/// `remove_by_nonce(&key, nonce)` with the insertion nonce persisted in
/// `points_nonce` — O(log n) regardless of how many accounts are tied at the
/// same score. The previous value-based `remove(&K, &V)` walked every tied
/// duplicate (O(D * log n) in the tie size D) and out-gassed on-chain once a
/// few hundred accounts shared a score. If the nonce mapping is missing for a
/// live entry (pre-nonce data, e.g. lazy backfill), we fall back to the old
/// value-based removal.
fn award_points(account: Address, delta: u128) {
    if delta == 0 {
        return;
    }
    let cur = Storage::account_points().get(&account).unwrap_or(0);
    let new_score = cur.saturating_add(delta);
    if cur > 0 {
        if let Some(nonce) = Storage::points_nonce().get(&account) {
            Storage::points_index().remove_by_nonce(&(u128::MAX - cur), nonce);
        } else {
            // Defensive fallback: entry predates nonce bookkeeping.
            Storage::points_index().remove(&(u128::MAX - cur), &account);
        }
    }
    let nonce = Storage::points_index().insert(&(u128::MAX - new_score), &account);
    Storage::points_nonce().insert(&account, &nonce);
    Storage::account_points().insert(&account, &new_score);
}

/// Internal/migration-only: SET `account`'s points to an absolute `total`,
/// reconciling `points_index`. Unlike `award_points` (which adds a delta), this
/// overwrites — correcting any launch-point seed left by `import_one`. Evicts at
/// 0. Do not expose this as an admin method; admin corrections should mutate the
/// specific bucket that explains the point delta.
fn set_points(account: Address, total: u128) {
    let cur = Storage::account_points().get(&account).unwrap_or(0);
    if cur == total {
        return;
    }
    if cur > 0 {
        if let Some(nonce) = Storage::points_nonce().get(&account) {
            Storage::points_index().remove_by_nonce(&(u128::MAX - cur), nonce);
        } else {
            // Defensive fallback: entry predates nonce bookkeeping.
            Storage::points_index().remove(&(u128::MAX - cur), &account);
        }
    }
    if total > 0 {
        let nonce = Storage::points_index().insert(&(u128::MAX - total), &account);
        Storage::points_nonce().insert(&account, &nonce);
        Storage::account_points().insert(&account, &total);
    } else {
        Storage::account_points().remove(&account);
        Storage::points_nonce().remove(&account);
    }
}

/// Subtract points from `account`, reconciling `points_index`. Saturates at 0
/// because legacy/imported totals may not perfectly match derived social state.
fn subtract_points(account: Address, delta: u128) {
    if delta == 0 {
        return;
    }
    let cur = Storage::account_points().get(&account).unwrap_or(0);
    set_points(account, cur.saturating_sub(delta));
}

/// Move `account` by the difference between two absolute point amounts.
/// Positive deltas bypass the blacklist: this is used for explicit admin
/// corrections, not organic awards.
fn adjust_points(account: Address, old_amount: u128, new_amount: u128) {
    if new_amount > old_amount {
        award_points(account, new_amount - old_amount);
    } else if old_amount > new_amount {
        subtract_points(account, old_amount - new_amount);
    }
}

/// Award gated on the known dev signer, the blacklist, and identity reveal.
/// Returns `true` when the award actually landed so callers can gate event
/// emission on it — the CLI dev signer, any recipient the team adds with
/// `set_blacklisted`, and any account that has not revealed a verified identity
/// silently no-op, keeping them off the leaderboard AND out of the event log.
///
/// The reveal check is the RECIPIENT side of the contest gate: XP only ever
/// credits an account that has revealed itself, regardless of who triggered the
/// award. This closes the cross-account hole the caller-side `require_revealed`
/// can't — e.g. an anonymous app owner accruing star/mod XP from other,
/// revealed, users' actions. Operator/migration paths that SET absolute totals
/// (`set_points` / `adjust_points`, used by `import_points` and the admin
/// corrections) bypass this helper by design, so reveal does not block restoring
/// or correcting scores.
fn try_award(account: Address, delta: u128) -> bool {
    if is_known_dev_signer(&account)
        || Storage::blacklisted().get(&account).unwrap_or(false)
        || !is_revealed(&account)
    {
        return false;
    }
    award_points(account, delta);
    true
}

// ---------------------------------------------------------------------------
// Social-index helpers. `star_index` / `mod_index` store
// (count_key, domain_idx) — the domain's slot in `domain_at`, which is
// stable for the lifetime of the contract (see `unpublish`).
// ---------------------------------------------------------------------------

/// Set `domain`'s `star_count` to `new_count`, moving its `star_index`
/// entry from the old bucket to the new one. `domain_idx` is the domain's
/// permanent slot from `index_of`.
fn set_star_count(domain: &String, domain_idx: u32, new_count: u32) {
    let cur = Storage::star_count().get(domain).unwrap_or(0);
    if cur == new_count {
        return;
    }
    if cur > 0 {
        if let Some(nonce) = Storage::star_nonce().get(&domain_idx) {
            Storage::star_index().remove_by_nonce(&(u32::MAX - cur), nonce);
        } else {
            // Defensive fallback: entry predates nonce bookkeeping (or the
            // count was lazily backfilled by `import_social_counts` without
            // an index entry — a silent no-op either way).
            Storage::star_index().remove(&(u32::MAX - cur), &domain_idx);
        }
    }
    Storage::star_count().insert(domain, &new_count);
    if new_count > 0 {
        let nonce = Storage::star_index().insert(&(u32::MAX - new_count), &domain_idx);
        Storage::star_nonce().insert(&domain_idx, &nonce);
    } else {
        Storage::star_nonce().remove(&domain_idx);
    }
}

/// Resolve a `domain_at` slot to an `AppEntry`, applying the same
/// public-or-own-private visibility filter as `get_apps`. Returns `None`
/// when the slot is currently unpublished or invisible to `caller_addr`.
fn try_build_entry(idx: u32, caller_addr: Address) -> Option<AppEntry> {
    let domain = Storage::domain_at().get(&idx)?;
    let metadata_uri = Storage::metadata_uri().get(&domain)?;
    let info = Storage::info().get(&domain)?;
    if info.visibility < VISIBILITY_PUBLIC && info.owner != caller_addr {
        return None;
    }
    Some(AppEntry {
        index: idx,
        domain,
        metadata_uri,
        owner: info.owner,
        visibility: info.visibility,
        publisher: info.publisher,
    })
}

/// Build an `AppsPage` from a slice of `(neg_count, domain_idx)` index
/// entries returned by `star_index.range` / `mod_index.range`. `scanned`
/// reflects index consumption (not filtered entry count) so callers can
/// advance pagination correctly when the page is short due to filtering.
fn index_page_to_apps(raw: Vec<(u32, u32)>, total: u32) -> AppsPage {
    let scanned = raw.len() as u32;
    let caller_addr = caller();
    let mut entries: Vec<AppEntry> = Vec::with_capacity(raw.len());
    for (_neg_count, idx) in raw {
        if let Some(entry) = try_build_entry(idx, caller_addr) {
            entries.push(entry);
        }
    }
    AppsPage { total, scanned, entries }
}

/// Set `domain`'s `mod_count` to `new_count`, moving its `mod_index`
/// entry. Same shape as `set_star_count`.
fn set_mod_count(domain: &String, domain_idx: u32, new_count: u32) {
    let cur = Storage::mod_count().get(domain).unwrap_or(0);
    if cur == new_count {
        return;
    }
    if cur > 0 {
        if let Some(nonce) = Storage::mod_nonce().get(&domain_idx) {
            Storage::mod_index().remove_by_nonce(&(u32::MAX - cur), nonce);
        } else {
            // Defensive fallback: see `set_star_count`.
            Storage::mod_index().remove(&(u32::MAX - cur), &domain_idx);
        }
    }
    Storage::mod_count().insert(domain, &new_count);
    if new_count > 0 {
        let nonce = Storage::mod_index().insert(&(u32::MAX - new_count), &domain_idx);
        Storage::mod_nonce().insert(&domain_idx, &nonce);
    } else {
        Storage::mod_nonce().remove(&domain_idx);
    }
}

fn social_points_for(star_count: u32, mod_count: u32) -> u128 {
    (star_count as u128)
        .saturating_mul(STAR_RECEIVED_XP)
        .saturating_add((mod_count as u128).saturating_mul(MOD_RECEIVED_XP))
}

/// Set the visible social counts for an app and reconcile the owner's awarded
/// app-scoped social XP. Used by admin corrections and by `unpublish` reset.
fn set_app_social_counts(domain: &String, owner: Address, star_count: u32, mod_count: u32) {
    let idx = match Storage::index_of().get(domain) {
        Some(i) => i,
        None => revert(b"DomainNotIndexed"),
    };
    let old_star_points = Storage::domain_star_points().get(domain).unwrap_or_else(|| {
        (Storage::star_count().get(domain).unwrap_or(0) as u128)
            .saturating_mul(STAR_RECEIVED_XP)
    });
    let old_mod_points = Storage::domain_mod_points().get(domain).unwrap_or_else(|| {
        (Storage::mod_count().get(domain).unwrap_or(0) as u128)
            .saturating_mul(MOD_RECEIVED_XP)
    });
    let old_points = old_star_points.saturating_add(old_mod_points);
    let new_star_points = (star_count as u128).saturating_mul(STAR_RECEIVED_XP);
    let new_mod_points = (mod_count as u128).saturating_mul(MOD_RECEIVED_XP);
    let new_points = social_points_for(star_count, mod_count);

    set_star_count(domain, idx, star_count);
    set_mod_count(domain, idx, mod_count);
    Storage::domain_star_points().insert(domain, &new_star_points);
    Storage::domain_mod_points().insert(domain, &new_mod_points);
    adjust_points(owner, old_points, new_points);
}

/// Pay the one-time identity bonus to `account`, deduped once-per-account-ever
/// via the shared `identity_bonus_awarded` marker. The live callers
/// (`set_identity` / `admin_set_identity`) both reveal an identity, so the award
/// always emits `IdentityBonusAwarded`. (The old anonymous path that emitted
/// `AnonymousBonusAwarded` is gone — `claim_anonymous_bonus` now reverts for the
/// reveal-to-earn contest.) The marker survives clear → re-bind, so a revealed
/// account earns the bonus exactly once across its lifetime.
///
/// Because the award routes through `try_award`, it only lands once `account`
/// is actually revealed — which it always is here, since both callers bind the
/// identity BEFORE invoking this helper.
///
/// Returns `true` iff the bonus was freshly awarded on THIS call (i.e. the
/// marker was just flipped). Callers use that to fire one-time side effects —
/// the identity-step faucet top-up — exactly once per account, so a repeat
/// reveal can't trigger them again.
fn award_identity_bonus_once(account: Address, root_pubkey: &[u8; 32]) -> bool {
    if Storage::identity_bonus_awarded().get(&account).unwrap_or(false) {
        return false;
    }
    if try_award(account, IDENTITY_BONUS_XP) {
        Storage::identity_bonus_awarded().insert(&account, &true);
        emit_typed_event(b"IdentityBonusAwarded", &IdentityEvent {
            recipient: account,
            root_pubkey: *root_pubkey,
        });
        return true;
    }
    false
}

/// Transfer the faucet amount (`FAUCET_CALL_VALUE`) in native tokens from this
/// contract account to `recipient`, returning whether the transfer succeeded.
/// Never reverts — the caller decides how to react to a dry contract.
fn try_faucet(recipient: Address) -> bool {
    let deposit = u256_max();
    let value = u128_to_u256_le(FAUCET_CALL_VALUE);
    let mut out: &mut [u8] = &mut [];
    let res = pvm::api::call(
        pvm::CallFlags::empty(),
        recipient.as_fixed_bytes(),
        0,
        0,
        &deposit,
        &value,
        &[],
        Some(&mut out),
    );
    res.is_ok()
}

/// Best-effort faucet top-up: send the faucet amount to `recipient` and, when
/// the transfer fails, emit `FaucetFailed` INSTEAD of reverting. This lets the
/// identity flows (`set_identity` reveal / `claim_anonymous_bonus`) and a direct
/// `faucet()` call complete even when the contract has run dry; off-chain
/// monitoring watches `FaucetFailed` to learn the faucet needs refunding.
fn faucet_or_emit(recipient: Address) {
    if !try_faucet(recipient) {
        emit_typed_event(b"FaucetFailed", &FaucetEvent {
            recipient,
            amount: FAUCET_AMOUNT,
        });
    }
}

/// Bind `account -> root_pubkey` while maintaining the reverse
/// `root_pubkey -> account` index. Reverts when another account already owns
/// the root. Re-setting the same root for the same account is idempotent.
fn set_identity_binding(account: Address, root_pubkey: [u8; 32]) {
    if let Some(owner) = Storage::account_for_identity().get(&root_pubkey) {
        if owner != account {
            revert(b"IdentityRootTaken");
        }
    }

    if let Some(previous_root) = Storage::identity_of().get(&account) {
        if previous_root != root_pubkey {
            clear_identity_reverse(&previous_root, account);
        }
    }

    Storage::identity_of().insert(&account, &root_pubkey);
    Storage::account_for_identity().insert(&root_pubkey, &account);
}

fn clear_identity_reverse(root_pubkey: &[u8; 32], account: Address) {
    if let Some(owner) = Storage::account_for_identity().get(root_pubkey) {
        if owner == account {
            Storage::account_for_identity().remove(root_pubkey);
        }
    }
}

fn clear_identity_binding(account: Address) -> bool {
    if let Some(root_pubkey) = Storage::identity_of().get(&account) {
        Storage::identity_of().remove(&account);
        clear_identity_reverse(&root_pubkey, account);
        true
    } else {
        false
    }
}

/// Returns true if caller is the domain owner, the sudo admin, or an admin.
///
/// Owner-only by design. `unpublish` / `set_visibility` and any future
/// destructive call site gate on this so a dev publisher (e.g. Alice from
/// the CLI's dev-mode flow) CANNOT permanently delete a user-owned app or
/// flip its visibility. The publisher branch lives separately in
/// `is_authorized_to_republish` and is only consumed by `publish`.
fn is_authorized(domain: &String) -> bool {
    let caller = caller();
    if let Some(info) = Storage::info().get(domain) {
        if info.owner == caller {
            return true;
        }
    }
    is_sudo_or_admin(&caller)
}

/// Like `is_authorized`, but also accepts the original publisher. Used
/// exclusively by `publish` for re-deploys, so a dev signer (Alice) can
/// keep iterating on an app whose ownership was assigned to the user's
/// H160 via the `owner` parameter of the first `publish`. Re-publish
/// preserves the stored owner + publisher, so the only side effect
/// available to a publisher is updating `metadata_uri` and `visibility`
/// — they cannot rewrite ownership or unpublish.
///
/// Note: this is asymmetric across signer modes. An app first published
/// in phone mode (caller = user H160, publisher = user H160) CANNOT be
/// re-published from dev mode (caller = Alice, publisher = user H160) —
/// Alice is neither owner nor publisher of that record, so the
/// `Unauthorized` revert fires. The phone-first lock-in is intentional:
/// once a user "owns" an app from their phone, a shared dev key
/// shouldn't be able to touch it. To iterate on a phone-published app
/// in dev mode, the user must unpublish from phone mode first.
fn is_authorized_to_republish(domain: &String) -> bool {
    let caller = caller();
    if let Some(info) = Storage::info().get(domain) {
        if info.owner == caller || info.publisher == caller {
            return true;
        }
    }
    is_sudo_or_admin(&caller)
}

/// Returns true if the address is the sudo account or in the admins list.
fn is_sudo_or_admin(addr: &Address) -> bool {
    is_sudo(addr) || Storage::admins().get(addr.as_fixed_bytes()).unwrap_or(false)
}

fn is_sudo(addr: &Address) -> bool {
    Storage::sudo().get().map_or(false, |s| s == *addr)
}

fn require_sudo() {
    if !is_sudo(&caller()) {
        revert(b"Unauthorized");
    }
}

fn require_sudo_or_admin() {
    if !is_sudo_or_admin(&caller()) {
        revert(b"Unauthorized");
    }
}

fn require_unfrozen() {
    if Storage::frozen().get().unwrap_or(false) {
        revert(b"Frozen");
    }
}

/// True iff `addr` has revealed itself — i.e. carries a verified identity
/// binding from `set_identity` / `admin_set_identity`. This is the
/// contest-participation gate: an anonymous account (no binding) is NOT
/// revealed, so it cannot earn XP. Presence is the predicate: every write path
/// (`set_identity`, `admin_set_identity`, `import_identities`) rejects the zero
/// root, so a stored row is always a real binding — same idiom
/// `import_identities` already uses to test "is this account bound?".
fn is_revealed(addr: &Address) -> bool {
    Storage::identity_of().contains(addr)
}

/// Revert `NotRevealed` unless the caller has revealed a verified identity.
/// Gates the organic participation methods that move contest XP (`publish`,
/// `star`) so an anonymous account fails fast with a clear reason instead of
/// silently doing work for zero reward. The complementary RECIPIENT-side rule
/// lives in `try_award`, which refuses to credit XP to an unrevealed EARNER
/// even when that earner is not the caller (mod credit paid to a source app's
/// owner, star XP paid to an app's owner).
fn require_revealed() {
    if !is_revealed(&caller()) {
        revert(b"NotRevealed");
    }
}

/// Single-entry replay used by both `import_app` and `import_apps`. The
/// sudo gate is asserted by the caller. Idempotent per domain: no-op when
/// the domain already exists; reverts on invalid visibility so callers
/// catch bad input early rather than silently dropping rows.
///
/// Awards `DEPLOY_XP` to the imported owner while the owner's
/// `deploy_award_count` is below `DEPLOY_REWARD_COUNT` (the first eligible
/// imports per owner that actually land an award earn the launch reward, the rest
/// earn 0 — matching what a fresh `publish()` would have produced; imports
/// that award nothing don't consume a slot). Visibility does not affect the
/// deploy award: a private app is still published to Playground. The
/// `is_moddable` argument is preserved on the ABI for callers but no longer
/// changes the award (#286 dropped the moddable bonus).
/// Sudo should call `import_points` after the bulk import to overwrite totals
/// when exact pre-migration scores are needed.
///
/// Reveal gate caveat: the `DEPLOY_XP` seed routes through `try_award`, which
/// now refuses unrevealed earners, so an imported owner who has not (yet)
/// revealed in this deployment seeds 0 launch XP here. This is harmless — the
/// authoritative totals come from `import_points` (which SETS via `set_points`,
/// bypassing the reveal gate), and the anti-farming sentinels stay closed: a
/// re-publish of an imported domain can't re-mint because `import_one` already
/// populated `index_of`, so the domain is no longer `truly_fresh`.
fn import_one(
    domain: &String,
    owner: Address,
    publisher: Address,
    visibility: u8,
    metadata_uri: &String,
    is_moddable: bool,
) {
    let _ = is_moddable;
    if visibility > MAX_VISIBILITY {
        revert(b"InvalidVisibility");
    }
    if Storage::info().contains(domain) {
        return;
    }
    let owner_bytes = *owner.as_fixed_bytes();
    append_app_indices(domain, &owner_bytes);
    Storage::info().insert(domain, &AppInfo { owner, visibility, publisher });
    Storage::metadata_uri().insert(domain, metadata_uri);

    // Mirror publish(): award when the migrated app has not yet exhausted the
    // owner's DEPLOY_REWARD_COUNT deploy awards. Visibility is deliberately not
    // part of the gate: private apps are still published to Playground. Goes
    // through `try_award` so a known dev-signer H160 (e.g. carried over from a
    // prior registry's owner field) still respects the blacklist on replay. On
    // successful award we bump `deploy_award_count` (the slot is only consumed
    // when the award lands) and set `launch_awarded` so a subsequent re-publish
    // of the same domain in the new registry cannot re-earn.
    let awards_granted = Storage::deploy_award_count().get(&owner).unwrap_or(0);
    if awards_granted < DEPLOY_REWARD_COUNT && try_award(owner, DEPLOY_XP) {
        Storage::deploy_award_count().insert(&owner, &(awards_granted + 1));
        Storage::launch_awarded().insert(domain, &true);
    }
}

/// Append a new app to the global and per-owner indexes. Assumes the domain
/// is not already registered.
fn append_app_indices(domain: &String, owner_bytes: &[u8; 20]) {
    let count = Storage::app_count().get().unwrap_or(0);
    Storage::domain_at().insert(&count, domain);
    Storage::index_of().insert(domain, &count);
    Storage::app_count().set(&(count + 1));
    append_owner_app_index(domain, owner_bytes);
}

/// Append a domain to a specific owner's index. Used both during fresh
/// publish and during cross-owner republish where the global `domain_at`
/// slot is reused (preserving the domain's stable identifier) but the new
/// owner needs its own MyApps entry. Also records the permanent
/// `owner_list_member` marker so the re-claim branch in `publish` never
/// appends the same domain to the same owner's list twice.
fn append_owner_app_index(domain: &String, owner_bytes: &[u8; 20]) {
    let owner_count = Storage::owner_app_count().get(owner_bytes).unwrap_or(0);
    Storage::owner_domain_at().insert(&(*owner_bytes, owner_count), domain);
    Storage::owner_index_of().insert(domain, &owner_count);
    Storage::owner_list_member().insert(&(*owner_bytes, domain.clone()), &true);
    Storage::owner_app_count().insert(owner_bytes, &(owner_count + 1));
}

/// Add a domain to the pinned list. Assumes the domain is not already pinned.
fn add_to_pinned(domain: &String) {
    let count = Storage::pinned_count().get().unwrap_or(0);
    Storage::pinned_at().insert(&count, domain);
    Storage::pinned_index_of().insert(domain, &count);
    Storage::pinned_count().set(&(count + 1));
}

/// Remove a domain from the pinned index, shifting subsequent entries down.
/// Emits `Unpinned` when the domain was actually pinned. No-op if not pinned.
fn remove_from_pinned(domain: &String) {
    let idx = match Storage::pinned_index_of().get(domain) {
        Some(i) => i,
        None => return,
    };
    let count = Storage::pinned_count().get().unwrap_or(0);
    // Shift entries down to fill the gap
    for i in idx..(count - 1) {
        if let Some(next_domain) = Storage::pinned_at().get(&(i + 1)) {
            Storage::pinned_at().insert(&i, &next_domain);
            Storage::pinned_index_of().insert(&next_domain, &i);
        }
    }
    Storage::pinned_at().remove(&(count - 1));
    Storage::pinned_index_of().remove(domain);
    Storage::pinned_count().set(&(count - 1));
    emit_event(b"Unpinned", domain);
}

#[pvm::storage]
struct Storage {
    // --- Global index (Recents / All) ---
    app_count: u32,
    domain_at: Mapping<u32, String>,

    // --- Per-owner index (My Apps) ---
    /// `owner -> lifetime slot count` for `owner_domain_at`. Never
    /// decremented: per-owner lists are append-only (tombstones included).
    /// NOT the deploy-reward gate — that is `deploy_award_count`, which
    /// only counts awards actually granted.
    owner_app_count: Mapping<[u8; 20], u32>,
    /// `(owner, slot) -> domain`. Append-only per owner; entries are NEVER
    /// removed or compacted. When a domain is unpublished and later
    /// re-claimed by a DIFFERENT owner, the previous owner's entry is left
    /// in place as a TOMBSTONE and the domain is appended to the new
    /// owner's list (see the re-claim branch in `publish`). Attribution
    /// therefore follows the current `info.owner`, never bare list
    /// membership: `get_owner_domain_at` hides slots whose domain is
    /// currently owned by someone else, and `get_point_breakdown` only
    /// counts domains whose `info.owner` matches the queried account.
    owner_domain_at: Mapping<([u8; 20], u32), String>,
    /// `(owner, domain) -> true` once `domain` has EVER been appended to
    /// `owner`'s list above. Permanent (never cleared) — the membership
    /// test for the cross-owner re-claim branch in `publish`, which must
    /// not append a duplicate when an owner re-claims a domain already in
    /// their (possibly tombstoned) list. `owner_index_of` cannot answer
    /// this: it is keyed by domain only, so the slot it stores is
    /// meaningless without knowing whose list it indexes.
    owner_list_member: Mapping<([u8; 20], String), bool>,

    // --- Reverse index (domain → slot) ---
    index_of: Mapping<String, u32>,
    /// `domain -> slot in the CURRENT owner's per-owner list` (repointed by
    /// `append_owner_app_index` on a cross-owner re-claim). Keyed by domain
    /// only — recovering WHOSE list the slot indexes requires the current
    /// `info.owner`. Survives `unpublish`. Currently write-mostly: the
    /// publish re-claim branch tests membership via `owner_list_member`
    /// instead, precisely because this map can't distinguish owners.
    owner_index_of: Mapping<String, u32>,

    // --- Domain data ---
    metadata_uri: Mapping<String, String>,
    info: Mapping<String, AppInfo>,

    // --- Admin ---
    sudo: Address,
    admins: Mapping<[u8; 20], bool>,

    // --- Pinned apps ---
    pinned_count: u32,
    pinned_at: Mapping<u32, String>,
    pinned_index_of: Mapping<String, u32>,

    // --- Migration ---
    frozen: bool,

    // --- Points + leaderboard ---
    /// Single running total per scoring account. Eviction on score == 0.
    /// Mutated only by bucket-specific helpers so the leaderboard total tracks
    /// deploy, identity, app-star, and app-mod awards.
    account_points: Mapping<Address, u128>,
    /// B-tree sorted by `u128::MAX - score` so `range(0, N)` returns the
    /// top N in descending-score order. Value is the account; duplicates
    /// allowed (ties broken internally by insertion nonce).
    ///
    /// T=3, not T=4. With K=u128 + V=Address (20-byte H160) + 8-byte nonce,
    /// a T=4 internal node packs 7 entries plus 8 child links and busts
    /// the 416-byte `MAX_STORAGE_VALUE_BYTES` cap — verified empirically
    /// (`OrderedIndexNodeTooLarge` reverts at ~31 inserted rows). T=3
    /// packs at most 5 entries + 6 children and survives 240+ rows.
    points_index: OrderedIndex<u128, Address, 3>,
    /// `account -> insertion nonce` of its live `points_index` entry.
    /// Written on every insert, consumed by `remove_by_nonce` so entry
    /// removal stays O(log n) regardless of score ties. Removed when the
    /// account is evicted from the leaderboard (`set_points` to 0).
    points_nonce: Mapping<Address, u64>,
    // --- Mod tracking (no persisted modded_from link) ---
    /// `domain -> # of unique modders who have published a mod of it`.
    mod_count: Mapping<String, u32>,
    /// `domain -> MOD_RECEIVED_XP actually awarded to the current owner for
    /// this source app's mods`. This is the amount subtracted on unpublish.
    domain_mod_points: Mapping<String, u128>,
    /// `(modder, source_domain) -> already credited?`. Per-modder dedupe
    /// so the same account modding the same source twice can't double-
    /// credit the source's owner.
    mod_credited: Mapping<(Address, String), bool>,
    /// Domains sorted by `u32::MAX - mod_count`, value is the domain's
    /// stable slot in `domain_at`. Fixed-size (u32, u32) entries keep the
    /// `OrderedIndex` B-tree nodes bounded; reads dereference each
    /// `domain_idx` back to its current domain via `domain_at`.
    mod_index: OrderedIndex<u32, u32, 4>,
    /// `domain slot -> insertion nonce` of its live `mod_index` entry.
    /// See `points_nonce` for the rationale.
    mod_nonce: Mapping<u32, u64>,

    // --- Stars ---
    /// `domain -> cumulative star count`. Stars are permanent; this only
    /// increases through `star` after deployment.
    star_count: Mapping<String, u32>,
    /// `domain -> STAR_RECEIVED_XP actually awarded to the current owner for
    /// this app's stars`. This is the amount subtracted on unpublish.
    domain_star_points: Mapping<String, u128>,
    /// `(voter, domain) -> has permanently starred this domain?`. Absent or
    /// false means the voter has not starred under the current social state.
    star_given: Mapping<(Address, String), bool>,
    /// `(voter, domain) -> star XP already paid?`. PERMANENT award dedupe,
    /// same pattern as `launch_awarded` / `identity_bonus_awarded` /
    /// `mod_credited`: set the first time this voter's star pays the
    /// domain owner and NEVER cleared — not in `unpublish`. Kept separate
    /// from `star_given` so upgraded contracts with historical unstars can
    /// restore a visible star without re-minting STAR_RECEIVED_XP.
    star_awarded: Mapping<(Address, String), bool>,
    /// Domains sorted by `u32::MAX - star_count`, value is the domain's
    /// permanent slot in `domain_at`. See `mod_index` for the rationale.
    star_index: OrderedIndex<u32, u32, 4>,
    /// `domain slot -> insertion nonce` of its live `star_index` entry.
    /// See `points_nonce` for the rationale.
    star_nonce: Mapping<u32, u64>,

    // --- Points blacklist ---
    /// Addresses that can never earn points. Populated by sudo with the
    /// well-known dev signers (bulletin-deploy DEFAULT_MNEMONIC bare-root,
    /// Substrate //Alice) and any custom `--suri` mnemonics the team uses
    /// for testing. When a recipient is in this set, `award_points` is a
    /// no-op and the matching events are NOT emitted — so the leaderboard
    /// won't surface a dev key, and the frontend won't refresh chasing a
    /// non-change.
    blacklisted: Mapping<Address, bool>,

    /// Set to true the FIRST time launch points are awarded for a domain,
    /// and never cleared. Survives `unpublish()` (which removes `info` but
    /// must not refund the original launch reward). Subsequent publishes of
    /// the same domain (even after unpublish, even by a different owner)
    /// skip the launch + mod-credit award path entirely — without this
    /// marker, a user could publish → +3 → unpublish → publish → +3 again
    /// and farm the leaderboard with one domain.
    launch_awarded: Mapping<String, bool>,

    /// `owner -> number of deploy XP awards actually GRANTED` (i.e. the
    /// owner's `account_points` increased by DEPLOY_XP; unrelated to tx
    /// fees). Hard-capped at DEPLOY_REWARD_COUNT, lifetime. Incremented
    /// only when `try_award` lands — publishes that award nothing
    /// (dev-signer, blacklisted recipient) do NOT consume a slot, so a
    /// developer who got their bearings on a dev signer keeps their capped
    /// deploy awards for later real (mobile-signed) deploys.
    /// Never decremented. Farming is still closed: each award additionally
    /// requires a `truly_fresh` domain and sets `launch_awarded`, so no
    /// domain awards twice and no owner is granted more than
    /// DEPLOY_REWARD_COUNT awards.
    deploy_award_count: Mapping<Address, u32>,

    // --- Identity binding (root account ⇄ product account) ---
    /// Verified link from a product-account H160 (the `caller`) to the root
    /// People-chain `AccountId32` that signed the binding message. Absent /
    /// zero ⇒ anonymous (clients render a deterministic name from the H160).
    identity_of: Mapping<Address, [u8; 32]>,
    /// Reverse identity index: root People-chain `AccountId32` -> product
    /// account H160. Maintained with `identity_of` so one DotNS root cannot
    /// appear as multiple builders on the leaderboard.
    account_for_identity: Mapping<[u8; 32], Address>,
    /// Set true the FIRST time `set_identity` credits an account with
    /// `IDENTITY_BONUS_XP`; never cleared (bonus is once-per-account-ever,
    /// survives clear → re-bind). Replaces the old `username_bonus_awarded`.
    identity_bonus_awarded: Mapping<Address, bool>,

    // --- Mod lineage (constellation display) ---
    /// Number of recorded lineage edges. Index space for `lineage_at`.
    lineage_count: u32,
    /// Append-only list of mod edges, `index -> LineageEdge { child, source }`.
    /// Written once per child; never mutated or removed.
    lineage_at: Mapping<u32, LineageEdge>,
    /// `child domain -> already recorded?`. Guards a duplicate edge across
    /// re-entry (publish→unpublish→publish) and `import_lineage` re-runs.
    lineage_recorded: Mapping<String, bool>,
}

// Compile-time shape checks: a full B-tree node for each index must fit the
// 416-byte storage-value cap, otherwise inserts revert at runtime with
// `OrderedIndexNodeTooLarge`. Key/value sizes are max encoded bytes:
// u128 = 16, Address (H160) = 20, u32 = 4.
const _: () = assert!(OrderedIndex::<u128, Address, 3>::fits_storage_limit(16, 20));
const _: () = assert!(OrderedIndex::<u32, u32, 4>::fits_storage_limit(4, 4));

fn publish_inner(
    domain: String,
    metadata_uri: String,
    visibility: u8,
    owner: Option<Address>,
    modded_from: String,
    is_moddable: bool,
    allow_owner_override: bool,
    award_points: bool,
) {
    require_unfrozen();
    if visibility > MAX_VISIBILITY {
        revert(b"InvalidVisibility");
    }
    if metadata_uri.is_empty() {
        revert(b"EmptyMetadataUri");
    }
    if !modded_from.is_empty() && modded_from == domain {
        revert(b"InvalidModdedFrom");
    }
    if owner.is_some() && !allow_owner_override {
        revert(b"OwnerOverrideForbidden");
    }
    let caller = caller();

    // Captured BEFORE the match so the post-write award branch knows
    // whether this is a first publish (the only time points are awarded).
    let is_new_app = !Storage::info().contains(&domain);

    // Captured BEFORE any slot allocation below: true iff this domain has
    // NEVER been published, by anyone. `unpublish` clears `info` but
    // preserves `index_of`, so a freed-and-re-claimed domain is NOT
    // truly fresh — the launch-award gate below requires this flag, so a
    // domain that ever existed never re-earns launch XP.
    let truly_fresh = !Storage::index_of().contains(&domain);

    match Storage::info().get(&domain) {
        Some(existing) => {
            if !is_authorized_to_republish(&domain) {
                revert(b"Unauthorized");
            }
            // If changing to private, auto-unpin
            if visibility == VISIBILITY_PRIVATE {
                remove_from_pinned(&domain);
            }
            // Preserve owner + publisher: ownership is immutable after
            // first publish to block hostile rewrites.
            Storage::info().insert(&domain, &AppInfo {
                owner: existing.owner,
                visibility,
                publisher: existing.publisher,
            });
        }
        None => {
            let effective_owner = owner.unwrap_or(caller);
            let owner_bytes = *effective_owner.as_fixed_bytes();
            if truly_fresh {
                append_app_indices(&domain, &owner_bytes);
            } else {
                // Re-claim of a previously-published domain. The global
                // `domain_at` slot stays put (preserves social-index
                // entries), but MyApps attribution must follow the NEW
                // owner. Membership is tested via the permanent
                // `owner_list_member` map — NOT via `owner_index_of`,
                // which is keyed by domain only and survives
                // `unpublish`: its presence says nothing about WHOSE
                // list holds the slot, so the old
                // `!owner_index_of().contains()` guard was dead code and
                // a cross-owner re-claim left the domain attributed to
                // the previous owner. (Comparing
                // `owner_domain_at((new_owner, slot))` instead would
                // mis-answer after an X → Y → X re-claim ping-pong and
                // duplicate the domain in X's list — the membership map
                // is exact.) The previous owner's `owner_domain_at`
                // entry is left behind as a tombstone; readers filter by
                // the current `info.owner` (see the field docs). No
                // launch XP is at stake either way: the award gate below
                // requires `truly_fresh`.
                let already_in_owner_list = Storage::owner_list_member()
                    .get(&(owner_bytes, domain.clone()))
                    .unwrap_or(false);
                if !already_in_owner_list {
                    append_owner_app_index(&domain, &owner_bytes);
                }
            }
            Storage::info().insert(&domain, &AppInfo {
                owner: effective_owner,
                visibility,
                publisher: caller,
            });
        }
    }

    Storage::metadata_uri().insert(&domain, &metadata_uri);
    emit_event(b"Published", &domain);

    if !is_new_app {
        return;
    }

    // --- Mod lineage (constellation display) ---
    // Record the source→child edge exactly once for any genuinely-new app
    // that declares a non-empty `modded_from` whose source exists. This is
    // independent of points, so dev-mode publishes still appear in lineage.
    if !modded_from.is_empty()
        && Storage::info().contains(&modded_from)
        && !Storage::lineage_recorded().get(&domain).unwrap_or(false)
    {
        let idx = Storage::lineage_count().get().unwrap_or(0);
        Storage::lineage_at().insert(&idx, &LineageEdge {
            child: domain.clone(),
            source: modded_from.clone(),
        });
        Storage::lineage_count().set(&(idx.saturating_add(1)));
        Storage::lineage_recorded().insert(&domain, &true);
    }

    if !award_points {
        return;
    }

    // Block reward re-issuance for any domain that has previously
    // received a launch award — prevents publish → unpublish → publish
    // farming. `launch_awarded` is set on the first successful award
    // and persists through unpublish, so a stale-but-rewarded domain
    // stays locked out forever, even after a new owner re-claims it.
    if Storage::launch_awarded().get(&domain).unwrap_or(false) {
        return;
    }

    // First publish of a new domain — award the deploy-class points to
    // the recorded owner. `info.owner` was set above.
    let owner_addr = match Storage::info().get(&domain) {
        Some(i) => i.owner,
        None => return,
    };

    // Launch award rule (#286 / #288): launch XP is awarded ONLY for
    // never-before-published domains (`truly_fresh`), regardless of visibility,
    // and only until the owner has been granted DEPLOY_REWARD_COUNT deploy
    // awards. The slot gate counts awards actually granted
    // (`deploy_award_count`), NOT `owner_app_count` — a blacklisted publish
    // awards nothing and consumes nothing.
    // `truly_fresh` stays load-bearing: a domain that ever existed —
    // even one unpublished and re-claimed — never awards, so preserved
    // slots can't be combined with republishing to re-mint, and the
    // per-owner counter hard-caps lifetime launch XP at
    // DEPLOY_REWARD_COUNT × DEPLOY_XP. The moddable bonus is gone;
    // `is_moddable` stays on the ABI for callers but no longer changes
    // the award amount.
    let _ = is_moddable;
    let awards_granted = Storage::deploy_award_count().get(&owner_addr).unwrap_or(0);
    if truly_fresh
        && awards_granted < DEPLOY_REWARD_COUNT
        && try_award(owner_addr, DEPLOY_XP)
    {
        Storage::deploy_award_count().insert(&owner_addr, &(awards_granted + 1));
        Storage::launch_awarded().insert(&domain, &true);
        emit_typed_event(b"DeployPointAwarded", &PointAwardEvent {
            recipient: owner_addr,
            domain: domain.clone(),
        });
    }

    // Mod credit. Dedupe keys on CALLER, not owner_addr. owner_addr can be a
    // soft hint passed via `owner` in dev mode; trusting it for dedupe would
    // let one signer publish N mods of the same source with N throwaway H160s.
    if !modded_from.is_empty() {
        let src = modded_from;
        if let Some(src_info) = Storage::info().get(&src) {
            if src_info.owner != owner_addr {
                let dedupe_key = (caller, src.clone());
                let already = Storage::mod_credited().get(&dedupe_key).unwrap_or(false);
                if !already {
                    Storage::mod_credited().insert(&dedupe_key, &true);
                    let cur = Storage::mod_count().get(&src).unwrap_or(0);
                    let src_idx = match Storage::index_of().get(&src) {
                        Some(i) => i,
                        None => revert(b"DomainNotIndexed"),
                    };
                    set_mod_count(&src, src_idx, cur.saturating_add(1));
                    if !Storage::domain_mod_points().contains(&src) {
                        Storage::domain_mod_points().insert(&src, &0);
                    }
                    // Social tracking has landed; award + event are still
                    // gated by the recipient blacklist.
                    if try_award(src_info.owner, MOD_RECEIVED_XP) {
                        let cur_points = Storage::domain_mod_points().get(&src).unwrap_or(0);
                        Storage::domain_mod_points()
                            .insert(&src, &cur_points.saturating_add(MOD_RECEIVED_XP));
                        emit_typed_event(b"ModPointAwarded", &ModPointEvent {
                            recipient: src_info.owner,
                            source_domain: src,
                            modder: owner_addr,
                            mod_domain: domain,
                        });
                    }
                }
            }
        }
    }
}

#[pvm::contract(cdm = "@w3s/playground-registry")]
mod playground_registry {
    use super::*;

    /// Records the deployer as `sudo`. Everything else is created lazily on
    /// first write (or seeded by the migration `import_*` methods).
    #[pvm::constructor]
    pub fn new() -> Result<(), Error> {
        Storage::sudo().set(&caller());

        Ok(())
    }

    /// TEMP (Task 1 spike). Proves the sr25519Verify precompile calldata
    /// encoding works on-chain. Remove after on-chain verification.
    ///
    /// `signature` is taken as `bytes` (not `bytes64` — the SolAbi ABI only
    /// supports fixed byte arrays of {1,2,4,8,16,20,32}); we require exactly
    /// 64 bytes and convert to the fixed array the helper expects.
    #[pvm::method]
    pub fn spike_verify(signature: Vec<u8>, message: Vec<u8>, public_key: [u8; 32]) -> bool {
        let sig: [u8; 64] = match signature.as_slice().try_into() {
            Ok(s) => s,
            Err(_) => return false,
        };
        verify_sr25519(&sig, &message, &public_key)
    }

    /// Publish or update an app entry from the mobile-authenticated path.
    ///
    /// The individuality runtime gates this selector, so this method is the
    /// scoring path: fresh publishes can award deploy XP regardless of
    /// visibility, and fresh `modded_from` publishes can increment the source
    /// app's mod count and mod XP. `owner: Some(...)` is rejected here;
    /// phone/mobile callers publish as themselves. The retained `is_dev_signer`
    /// argument is ignored for ABI compatibility. If a known dev signer reaches
    /// this method directly outside the production runtime guard, it is still
    /// treated as non-scoring.
    ///
    /// Contest gate: the caller must have revealed a verified identity, else
    /// this reverts `NotRevealed` before doing any work. The scored publish is a
    /// participation action, and a fresh publish awards the caller deploy XP, so
    /// an anonymous caller is blocked at the door rather than silently earning
    /// nothing. The ungated dev-signer path lives in `publish_dev` and is NOT
    /// reveal-gated (it awards nothing and is an operator/CLI tool).
    #[pvm::method]
    pub fn publish(
        domain: String,
        metadata_uri: String,
        visibility: u8,
        owner: Option<Address>,
        // `Option<String>` was originally used here, but the on-chain SolAbi
        // decoder (`pvm_contract::abi::Option<T> for T: IS_DYNAMIC`) declares
        // a 64-byte head while viem (the TS SDK encoder) writes only a
        // 32-byte offset slot for a dynamic tuple — shifting every later
        // param by 32 bytes and silently corrupting `is_moddable` /
        // `is_dev_signer`. Plain `String` with `""` as the "no source"
        // sentinel sidesteps the bug entirely.
        modded_from: String,
        is_moddable: bool,
        is_dev_signer: bool,
    ) {
        require_revealed();
        let _ = is_dev_signer;
        let award_points = !is_known_dev_signer(&caller());
        publish_inner(
            domain,
            metadata_uri,
            visibility,
            owner,
            modded_from,
            is_moddable,
            false,
            award_points,
        );
    }

    /// Publish or update from the ungated dev-signer path.
    ///
    /// Only known dev signers can call this method. It may pass
    /// `owner: Some(user_h160)` so apps still appear in the user's My Apps, but
    /// this path never awards deploy XP and never increments/awards source-app
    /// mod credit. It still records metadata, ownership, visibility, and lineage.
    #[pvm::method]
    pub fn publish_dev(
        domain: String,
        metadata_uri: String,
        visibility: u8,
        owner: Option<Address>,
        modded_from: String,
        is_moddable: bool,
    ) {
        if !is_known_dev_signer(&caller()) {
            revert(b"Unauthorized");
        }
        publish_inner(
            domain,
            metadata_uri,
            visibility,
            owner,
            modded_from,
            is_moddable,
            true,
            false,
        );
    }

    /// Remove an app from the registry. Caller must be domain owner, sudo, or
    /// admin. This is delete/unpublish semantics, not privacy semantics:
    /// app-scoped star/mod XP is removed from the current owner and the visible
    /// social counts reset to zero. Deploy/identity XP remain lifetime rewards,
    /// and removing a modded child does not retract mod credit from its source
    /// app.
    #[pvm::method]
    pub fn unpublish(domain: String) {
        require_unfrozen();
        if !is_authorized(&domain) {
            revert(b"Unauthorized");
        }
        let info = match Storage::info().get(&domain) {
            Some(i) => i,
            None => revert(b"AppNotFound"),
        };
        set_app_social_counts(&domain, info.owner, 0, 0);
        // Mark as unpublished by clearing only `info` + `metadata_uri` +
        // pin status. `domain_at`, `index_of`, `owner_domain_at`,
        // `owner_index_of`, and `owner_list_member`. The permanent award
        // markers (`launch_awarded`, `star_awarded`, `mod_credited`) are
        // intentionally preserved so clearing social counts does not re-arm
        // old voters/modders for duplicate awards.
        Storage::metadata_uri().remove(&domain);
        Storage::info().remove(&domain);
        remove_from_pinned(&domain);
        emit_event(b"Unpublished", &domain);
    }

    // --- Stars (permanent; first star per (voter, domain) pays
    //     STAR_RECEIVED_XP once, ever — no refund, no re-award) ---

    /// Star an app permanently. The first visible star from a voter on a
    /// domain increments `star_count`; STAR_RECEIVED_XP is paid to the app's
    /// owner at most once ever, tracked by the permanent `star_awarded`
    /// marker. Caller cannot star their own app (`SelfStarForbidden`) and
    /// cannot star the same app twice (`AlreadyStarred`). The dedupe is on
    /// the caller's H160, so upstream PoP-gated account scarcity is the Sybil
    /// bound.
    ///
    /// Contest gate: the voter must have revealed a verified identity, else
    /// this reverts `NotRevealed`. Starring is a participation action that pays
    /// XP to the owner, so only revealed accounts may cast one — this also keeps
    /// `star_count` (a public social signal) free of anonymous inflation. The
    /// owner is separately required to be revealed to actually receive the star
    /// XP (the recipient check inside `try_award`).
    #[pvm::method]
    pub fn star(domain: String) {
        require_unfrozen();
        require_revealed();
        let info = match Storage::info().get(&domain) {
            Some(i) => i,
            None => revert(b"AppNotFound"),
        };
        let voter = caller();
        if voter == info.owner {
            revert(b"SelfStarForbidden");
        }
        let key = (voter, domain.clone());
        let already = Storage::star_given().get(&key).unwrap_or(false);
        if already {
            revert(b"AlreadyStarred");
        }
        Storage::star_given().insert(&key, &true);
        let cur = Storage::star_count().get(&domain).unwrap_or(0);
        // index_of must be populated — domain is in `info`, so it had to
        // go through `publish` which assigned a slot.
        let idx = match Storage::index_of().get(&domain) {
            Some(i) => i,
            None => revert(b"DomainNotIndexed"),
        };
        set_star_count(&domain, idx, cur.saturating_add(1));
        if !Storage::domain_star_points().contains(&domain) {
            Storage::domain_star_points().insert(&domain, &0);
        }
        // Permanent award dedupe (mirrors `launch_awarded` /
        // `identity_bonus_awarded`): pay the owner only the FIRST time this
        // voter stars this domain. This remains separate from `star_given`
        // for upgrade compatibility with historical unstars: a restored
        // visible star should not mint STAR_RECEIVED_XP again. The marker is
        // set BEFORE the award call (so even a blacklisted voter's star
        // permanently consumes the one-shot) and is never cleared.
        let already_awarded = Storage::star_awarded().get(&key).unwrap_or(false);
        if !already_awarded {
            Storage::star_awarded().insert(&key, &true);
            // Social tracking above always lands; point award + event gated
            // by the blacklist.
            if try_award(info.owner, STAR_RECEIVED_XP) {
                let cur_points = Storage::domain_star_points().get(&domain).unwrap_or(0);
                Storage::domain_star_points()
                    .insert(&domain, &cur_points.saturating_add(STAR_RECEIVED_XP));
                emit_typed_event(b"StarPointAwarded", &StarPointEvent {
                    recipient: info.owner,
                    domain,
                    voter,
                });
            }
        }
    }

    // --- Global queries ---

    #[pvm::method]
    pub fn get_app_count() -> u32 {
        Storage::app_count().get().unwrap_or(0)
    }

    #[pvm::method]
    pub fn get_domain_at(index: u32) -> Option<String> {
        Storage::domain_at().get(&index)
    }

    // --- Per-owner queries ---

    #[pvm::method]
    pub fn get_owner_app_count(owner: Address) -> u32 {
        Storage::owner_app_count().get(owner.as_fixed_bytes()).unwrap_or(0)
    }

    /// Raw slot read for an owner's MyApps list. Per-owner lists are
    /// append-only with tombstones: a slot whose domain has since been
    /// re-claimed by a DIFFERENT owner is hidden here (returns `None`) so
    /// pagination and attribution always follow the current `info.owner` —
    /// both frontends stamp the queried address as the entry's owner, so
    /// leaking a tombstone would show someone else's app under this owner.
    /// Slots whose domain is merely unpublished (no `info`) are still
    /// returned, matching prior behavior; callers already skip those via
    /// the missing `metadata_uri`.
    #[pvm::method]
    pub fn get_owner_domain_at(owner: Address, index: u32) -> Option<String> {
        let domain = Storage::owner_domain_at().get(&(*owner.as_fixed_bytes(), index))?;
        if let Some(info) = Storage::info().get(&domain) {
            if info.owner != owner {
                // Tombstone: re-claimed by another owner after unpublish.
                return None;
            }
        }
        Some(domain)
    }

    // --- Admin management ---

    #[pvm::method]
    pub fn get_sudo() -> Address {
        Storage::sudo().get().unwrap_or_default()
    }

    /// Add an address to the admins list. Sudo/admin only.
    #[pvm::method]
    pub fn add_admin(admin: Address) {
        require_unfrozen();
        require_sudo_or_admin();
        Storage::admins().insert(admin.as_fixed_bytes(), &true);
    }

    /// Remove an address from the admins list. Sudo only.
    #[pvm::method]
    pub fn remove_admin(admin: Address) {
        require_unfrozen();
        require_sudo();
        Storage::admins().remove(admin.as_fixed_bytes());
    }

    /// Check if an address is an admin.
    #[pvm::method]
    pub fn is_admin(addr: Address) -> bool {
        Storage::admins().get(addr.as_fixed_bytes()).unwrap_or(false)
    }

    /// Admin/sudo: set the number of deploy XP awards credited to an account
    /// and reconcile the matching points delta. `count` is capped to the same
    /// capped deploy reward model used by organic publishes.
    #[pvm::method]
    pub fn admin_set_deploy_award_count(account: Address, count: u32) {
        require_unfrozen();
        require_sudo_or_admin();
        if count > DEPLOY_REWARD_COUNT {
            revert(b"DeployAwardCountTooHigh");
        }
        let old_count = Storage::deploy_award_count().get(&account).unwrap_or(0);
        if old_count == count {
            return;
        }
        if count > 0 {
            Storage::deploy_award_count().insert(&account, &count);
        } else {
            Storage::deploy_award_count().remove(&account);
        }
        adjust_points(
            account,
            (old_count as u128).saturating_mul(DEPLOY_XP),
            (count as u128).saturating_mul(DEPLOY_XP),
        );
    }

    /// Admin/sudo: set an app's visible star/mod counts and reconcile the
    /// current owner's app-scoped social XP. This is the targeted correction
    /// tool for star/mod buckets; `unpublish` uses the same helper with zeros.
    #[pvm::method]
    pub fn admin_set_app_social_counts(domain: String, star_count: u32, mod_count: u32) {
        require_unfrozen();
        require_sudo_or_admin();
        let info = match Storage::info().get(&domain) {
            Some(i) => i,
            None => revert(b"AppNotFound"),
        };
        set_app_social_counts(&domain, info.owner, star_count, mod_count);
    }

    // --- Points blacklist (defense-in-depth for non-awardable recipients) ---

    /// Add or remove one or more addresses from the points-blacklist. Sudo/admin
    /// only. Blacklisted recipients silently no-op out of `award_points` —
    /// existing points are NOT cleared, only future awards are blocked.
    /// Pass a single-element vector for one-off changes; pass the full set
    /// when bootstrapping the list with known dev-signer H160s.
    #[pvm::method]
    pub fn set_blacklisted(accounts: Vec<Address>, value: bool) {
        require_unfrozen();
        require_sudo_or_admin();
        for account in accounts {
            if value {
                Storage::blacklisted().insert(&account, &true);
            } else {
                Storage::blacklisted().remove(&account);
            }
        }
    }

    /// Public read: is this address blocked from earning points?
    #[pvm::method]
    pub fn is_blacklisted(account: Address) -> bool {
        Storage::blacklisted().get(&account).unwrap_or(false)
    }

    // --- Visibility ---

    /// Change the visibility of an app without re-uploading metadata. This does
    /// not touch deploy XP, star/mod counts, or app-scoped social XP; private
    /// apps remain owner-visible and keep their rewards.
    #[pvm::method]
    pub fn set_visibility(domain: String, visibility: u8) {
        require_unfrozen();
        if visibility > MAX_VISIBILITY {
            revert(b"InvalidVisibility");
        }
        if !is_authorized(&domain) {
            revert(b"Unauthorized");
        }
        let mut info = match Storage::info().get(&domain) {
            Some(i) => i,
            None => revert(b"AppNotFound"),
        };
        if visibility == VISIBILITY_PRIVATE {
            remove_from_pinned(&domain);
        }
        info.visibility = visibility;
        Storage::info().insert(&domain, &info);
        emit_event(b"VisibilityChanged", &domain);
    }

    /// Get the visibility of an app.
    #[pvm::method]
    pub fn get_visibility(domain: String) -> u8 {
        Storage::info()
            .get(&domain)
            .map(|i| i.visibility)
            .unwrap_or(VISIBILITY_PRIVATE)
    }

    // --- Pin management ---

    /// Pin an app to the top of the list. Admin or sudo only. App must be public.
    #[pvm::method]
    pub fn pin(domain: String) {
        require_unfrozen();
        if !is_sudo_or_admin(&caller()) {
            revert(b"Unauthorized");
        }
        let info = match Storage::info().get(&domain) {
            Some(i) => i,
            None => revert(b"AppNotFound"),
        };
        if info.visibility < VISIBILITY_PUBLIC {
            revert(b"CannotPinPrivateApp");
        }
        if Storage::pinned_index_of().contains(&domain) {
            revert(b"AlreadyPinned");
        }
        add_to_pinned(&domain);
        emit_event(b"Pinned", &domain);
    }

    /// Unpin an app. Admin or sudo only.
    #[pvm::method]
    pub fn unpin(domain: String) {
        require_unfrozen();
        if !is_sudo_or_admin(&caller()) {
            revert(b"Unauthorized");
        }
        if !Storage::pinned_index_of().contains(&domain) {
            revert(b"NotPinned");
        }
        remove_from_pinned(&domain);
        emit_event(b"Unpinned", &domain);
    }

    /// Check if an app is pinned.
    #[pvm::method]
    pub fn is_pinned(domain: String) -> bool {
        Storage::pinned_index_of().contains(&domain)
    }

    /// Return all pinned app entries (only public ones).
    #[pvm::method]
    pub fn get_pinned_apps() -> Vec<AppEntry> {
        let count = Storage::pinned_count().get().unwrap_or(0);
        let mut entries: Vec<AppEntry> = Vec::new();
        for i in 0..count {
            if let Some(domain) = Storage::pinned_at().get(&i) {
                if let Some(metadata_uri) = Storage::metadata_uri().get(&domain) {
                    let info = Storage::info().get(&domain);
                    let visibility = info.as_ref().map(|i| i.visibility).unwrap_or(VISIBILITY_PRIVATE);
                    if visibility < VISIBILITY_PUBLIC { continue; }
                    let owner = info.as_ref().map(|i| i.owner).unwrap_or_default();
                    let publisher = info.as_ref().map(|i| i.publisher).unwrap_or_default();
                    let idx = Storage::index_of().get(&domain).unwrap_or(0);
                    entries.push(AppEntry { index: idx, domain, metadata_uri, owner, visibility, publisher });
                }
            }
        }
        entries
    }

    // --- Paginated query ---

    /// Return a page of app entries starting at offset `start` (in reverse/newest-first order).
    /// Returns up to `count` entries. Includes public apps and the caller's own private apps.
    #[pvm::method]
    pub fn get_apps(start: u32, count: u32) -> AppsPage {
        let total = Storage::app_count().get().unwrap_or(0);
        let mut entries: Vec<AppEntry> = Vec::new();
        let mut scanned = 0u32;

        if total > 0 && start < total {
            let mut idx = total - 1 - start;
            loop {
                if entries.len() as u32 >= count || start + scanned >= total {
                    break;
                }
                if let Some(domain) = Storage::domain_at().get(&idx) {
                    if let Some(metadata_uri) = Storage::metadata_uri().get(&domain) {
                        let info = Storage::info().get(&domain);
                        let owner = info.as_ref().map(|i| i.owner).unwrap_or_default();
                        let publisher = info.as_ref().map(|i| i.publisher).unwrap_or_default();
                        let visibility = info.as_ref().map(|i| i.visibility).unwrap_or(VISIBILITY_PRIVATE);
                        // Read-side visibility check is owner-only: a private
                        // app is visible to its claimed owner, never to the
                        // (possibly shared) publisher account. Otherwise any
                        // reader using a dev-key origin (e.g. the CLI's
                        // read-only registry client which queries as Alice)
                        // would see every dev-mode private app published in
                        // the registry. Write-side auth in `is_authorized`
                        // is a separate concern.
                        if visibility >= VISIBILITY_PUBLIC || owner == caller() {
                            entries.push(AppEntry { index: idx, domain, metadata_uri, owner, visibility, publisher });
                        }
                    }
                }
                scanned += 1;
                if idx == 0 { break; }
                idx -= 1;
            }
        }

        AppsPage { total, scanned, entries }
    }

    /// Return a page of app entries ordered by `star_count` DESCENDING.
    /// `start` is an offset into `star_index`; `count` is the page size.
    /// `total` is `star_index.len()` — an upper bound on visible entries
    /// since the page filters out entries whose domain is currently
    /// unpublished (info absent) or private to a non-caller. `scanned` is
    /// the number of index entries the call consumed (= `count` when the
    /// index isn't exhausted); the caller advances pagination by
    /// `scanned`, not `entries.len()`.
    #[pvm::method]
    pub fn get_top_starred(start: u32, count: u32) -> AppsPage {
        let raw = Storage::star_index().range(
            Bound::Unbounded,
            Bound::Unbounded,
            start as u64,
            count as u64,
        );
        let total = Storage::star_index().len() as u32;
        index_page_to_apps(raw, total)
    }

    /// Return a page of app entries ordered by `mod_count` DESCENDING.
    /// Same shape and pagination semantics as `get_top_starred`.
    #[pvm::method]
    pub fn get_top_modded(start: u32, count: u32) -> AppsPage {
        let raw = Storage::mod_index().range(
            Bound::Unbounded,
            Bound::Unbounded,
            start as u64,
            count as u64,
        );
        let total = Storage::mod_index().len() as u32;
        index_page_to_apps(raw, total)
    }

    // --- Mod-lineage queries (constellation display) ---

    /// Total number of recorded mod-lineage edges.
    #[pvm::method]
    pub fn get_lineage_count() -> u32 {
        Storage::lineage_count().get().unwrap_or(0)
    }

    /// Page of mod-lineage edges from `start`, up to `count`, oldest-first.
    /// Each `{ child, source }`: `child` was published as a mod of `source`.
    #[pvm::method]
    pub fn get_lineage(start: u32, count: u32) -> Vec<LineageEntry> {
        let total = Storage::lineage_count().get().unwrap_or(0);
        let mut entries: Vec<LineageEntry> = Vec::new();
        if count == 0 || start >= total {
            return entries;
        }
        let mut idx = start;
        while idx < total && (entries.len() as u32) < count {
            if let Some(edge) = Storage::lineage_at().get(&idx) {
                entries.push(LineageEntry { child: edge.child, source: edge.source });
            }
            idx = idx.saturating_add(1);
        }
        entries
    }

    // --- Domain data queries ---

    #[pvm::method]
    pub fn get_metadata_uri(domain: String) -> Option<String> {
        Storage::metadata_uri().get(&domain)
    }

    #[pvm::method]
    pub fn get_app_data(domains: Vec<String>, voter: Address) -> Vec<AppData> {
        domains
            .into_iter()
            .map(|domain| {
                let metadata_uri = Storage::metadata_uri().get(&domain);
                let info = Storage::info().get(&domain);
                let owner = info.as_ref().map(|i| i.owner).unwrap_or_default();
                let visibility = info.as_ref().map(|i| i.visibility).unwrap_or(VISIBILITY_PRIVATE);
                let publisher = info.as_ref().map(|i| i.publisher).unwrap_or_default();
                let star_count = Storage::star_count().get(&domain).unwrap_or(0);
                let mod_count = Storage::mod_count().get(&domain).unwrap_or(0);
                let has_starred = Storage::star_given()
                    .get(&(voter, domain.clone()))
                    .unwrap_or(false);
                AppData {
                    domain,
                    metadata_uri,
                    owner,
                    visibility,
                    publisher,
                    star_count,
                    mod_count,
                    has_starred,
                }
            })
            .collect()
    }

    #[pvm::method]
    pub fn get_owner(domain: String) -> Address {
        Storage::info()
            .get(&domain)
            .map(|i| i.owner)
            .unwrap_or_default()
    }

    // --- Points + leaderboard queries ---

    /// Cumulative XP for `account`. Returns 0 for unknown / zero-score
    /// accounts (the `account_points` slot is evicted on score == 0).
    #[pvm::method]
    pub fn get_points(account: Address) -> u128 {
        Storage::account_points().get(&account).unwrap_or(0)
    }

    /// Read up to `count` leaderboard entries starting at `start`, ordered
    /// by score DESCENDING. One contract call returns a pre-sorted page;
    /// the frontend renders without a client-side sort.
    ///
    /// Backing store: an OrderedIndex keyed on `u128::MAX - score`, so the
    /// natural ascending iteration yields highest scores first.
    #[pvm::method]
    pub fn get_top_builders(start: u32, count: u32) -> Vec<TopBuilderEntry> {
        let entries = Storage::points_index().range(
            Bound::Unbounded,
            Bound::Unbounded,
            start as u64,
            count as u64,
        );
        entries
            .into_iter()
            .map(|(neg_score, account)| TopBuilderEntry {
                account,
                score: u128::MAX - neg_score,
            })
            .collect()
    }

    /// Total number of unique-modder credits recorded against `domain`.
    /// Increments only when a fresh `(modder, source_domain)` pair publishes
    /// a mod for the first time — re-mods by the same modder do not re-count.
    #[pvm::method]
    pub fn get_mod_count(domain: String) -> u32 {
        Storage::mod_count().get(&domain).unwrap_or(0)
    }

    /// Cumulative permanent star count for `domain`.
    #[pvm::method]
    pub fn get_star_count(domain: String) -> u32 {
        Storage::star_count().get(&domain).unwrap_or(0)
    }

    /// Whether `voter` has permanently starred `domain`. Used by the
    /// frontend to disable the one-way star button after a successful star.
    #[pvm::method]
    pub fn has_starred(voter: Address, domain: String) -> bool {
        Storage::star_given().get(&(voter, domain)).unwrap_or(false)
    }

    /// Per-account points broken down by source. Single round-trip read so
    /// the profile UI doesn't fan out into per-app queries. Derived: only
    /// the total is stored; star and mod components are summed from the
    /// per-domain `star_count`/`mod_count` over the domains the account
    /// CURRENTLY owns (published, `info.owner == account` — tombstoned and
    /// unpublished list slots are skipped, see `owner_domain_at`).
    ///
    /// Cost: O(N_owned_apps) — bounded by `owner_app_count[account]`. For
    /// a typical user (≤ a dozen apps) this is a handful of mapping reads.
    #[pvm::method]
    pub fn get_point_breakdown(account: Address) -> PointBreakdown {
        let total = Storage::account_points().get(&account).unwrap_or(0);
        let owner_bytes = account.as_fixed_bytes();
        let owned = Storage::owner_app_count().get(owner_bytes).unwrap_or(0);
        let mut star_points: u128 = 0;
        let mut mod_points: u128 = 0;
        for i in 0..owned {
            if let Some(domain) = Storage::owner_domain_at().get(&(*owner_bytes, i)) {
                // Attribution follows the CURRENT `info.owner`: skip
                // tombstone slots (domain re-claimed by a different owner
                // after unpublish — its star/mod counts belong to the new
                // owner's breakdown now) and unpublished domains (no owner
                // at all; counting them under every list that ever held
                // them would double-attribute after a re-claim ping-pong).
                match Storage::info().get(&domain) {
                    Some(info) if info.owner == account => {}
                    _ => continue,
                }
                star_points = star_points
                    .saturating_add(Storage::star_count().get(&domain).unwrap_or(0) as u128);
                mod_points = mod_points
                    .saturating_add(Storage::mod_count().get(&domain).unwrap_or(0) as u128);
            }
        }
        // `launch_points` was once the residual (total - star_points -
        // mod_points). Under #286 the buckets are counts, not XP, so the
        // residual is meaningless. Kept in the struct for ABI stability;
        // frontends should read `get_owner_app_count` for the deploy count.
        PointBreakdown {
            launch_points: 0,
            mod_points,
            star_points,
            total,
        }
    }

    // --- Migration ---

    /// Toggle the freeze flag. Sudo only. Bypasses the freeze guard so an admin
    /// can re-open if needed.
    #[pvm::method]
    pub fn set_frozen(value: bool) {
        require_sudo();
        Storage::frozen().set(&value);
    }

    /// Returns whether writes are currently halted.
    #[pvm::method]
    pub fn is_frozen() -> bool {
        Storage::frozen().get().unwrap_or(false)
    }

    /// Replay an app entry from a prior registry deployment. Sudo only.
    /// Idempotent: no-op if `domain` is already in `info`.
    ///
    /// `publisher` is the recorded `env::caller()` of the original first
    /// publish. For migrations from a pre-publisher registry where that
    /// caller wasn't stored, the off-chain replay script should pass the
    /// stored `owner` as `publisher` — that yields a consistent post-
    /// migration state where the owner can still republish (it's both
    /// owner and publisher), which is the closest faithful approximation.
    #[pvm::method]
    pub fn import_app(
        domain: String,
        owner: Address,
        publisher: Address,
        visibility: u8,
        metadata_uri: String,
        is_moddable: bool,
    ) {
        require_sudo();
        import_one(&domain, owner, publisher, visibility, &metadata_uri, is_moddable);
    }

    /// Batched `import_app`. Per-entry semantics unchanged; off-chain callers
    /// must chunk to fit per-tx block-weight limits.
    #[pvm::method]
    pub fn import_apps(apps: Vec<AppImport>) {
        require_sudo();
        for app in apps {
            import_one(
                &app.domain,
                app.owner,
                app.publisher,
                app.visibility,
                &app.metadata_uri,
                app.is_moddable,
            );
        }
    }

    /// Replay a pinned entry from a prior registry deployment. Sudo only.
    /// Idempotent: no-op if `domain` is already pinned. Requires the app to
    /// have been imported first and to be public.
    #[pvm::method]
    pub fn import_pinned(domain: String) {
        require_sudo();
        let info = match Storage::info().get(&domain) {
            Some(i) => i,
            None => revert(b"AppNotFound"),
        };
        if info.visibility < VISIBILITY_PUBLIC {
            revert(b"CannotPinPrivateApp");
        }
        if Storage::pinned_index_of().contains(&domain) {
            return;
        }
        add_to_pinned(&domain);
    }

    /// Replay mod-lineage edges (backfill / prior deployment). Sudo only.
    /// Idempotent via `lineage_recorded` (one edge per child). Skips empties.
    /// Does NOT require `source` to exist — trusted sudo backfill data.
    #[pvm::method]
    pub fn import_lineage(entries: Vec<LineageImport>) {
        require_sudo();
        for e in entries {
            if e.child.is_empty() || e.source.is_empty() {
                continue;
            }
            if Storage::lineage_recorded().get(&e.child).unwrap_or(false) {
                continue;
            }
            let idx = Storage::lineage_count().get().unwrap_or(0);
            Storage::lineage_at().insert(&idx, &LineageEdge {
                child: e.child.clone(),
                source: e.source,
            });
            Storage::lineage_count().set(&(idx.saturating_add(1)));
            Storage::lineage_recorded().insert(&e.child, &true);
        }
    }

    /// Replay authoritative leaderboard scores. Sudo only. SETS each total
    /// (overwriting any `import_apps` launch seed), so MUST run AFTER all
    /// `import_apps`. Idempotent.
    #[pvm::method]
    pub fn import_points(entries: Vec<PointImport>) {
        require_sudo();
        for e in entries {
            set_points(e.account, e.total);
        }
    }

    /// Replay per-domain star/mod counters. Sudo only. SETS the counters
    /// (overwrite, idempotent). Skips unknown domains. Does NOT touch
    /// account_points (use `import_points`) and does NOT repopulate the
    /// star_given / mod_credited dedupe maps (they reset — see runbook).
    /// Seeds the app-scoped social XP buckets so a later unpublish can retract
    /// the imported app's visible star/mod points.
    #[pvm::method]
    pub fn import_social_counts(entries: Vec<SocialImport>) {
        require_sudo();
        for e in entries {
            if Storage::info().contains(&e.domain) {
                // Lazy backfill: write the raw Mapping counts only, do
                // NOT touch star_index / mod_index (and therefore no
                // `*_nonce` entry either). The next live `star` /
                // mod-credit goes through `set_*_count`, which reads the
                // imported count, finds no stored nonce, and takes the
                // value-based `remove(MAX-cur, domain_idx)` fallback
                // — a silent no-op because that bucket was never written —
                // and then inserts the domain at the new bucket. Net
                // effect: a single live op promotes the imported domain
                // into the sorted set without double-counting, and the
                // migration tx itself stays light (no OrderedIndex churn
                // for hundreds of domains).
                Storage::star_count().insert(&e.domain, &e.star_count);
                Storage::mod_count().insert(&e.domain, &e.mod_count);
                Storage::domain_star_points().insert(
                    &e.domain,
                    &((e.star_count as u128).saturating_mul(STAR_RECEIVED_XP)),
                );
                Storage::domain_mod_points().insert(
                    &e.domain,
                    &((e.mod_count as u128).saturating_mul(MOD_RECEIVED_XP)),
                );
            }
        }
    }

    /// Sudo replay of verified bindings (future migration). Does NOT re-verify;
    /// skips accounts that already have a binding and roots already claimed by
    /// an earlier import row (idempotent per account/root).
    #[pvm::method]
    pub fn import_identities(entries: Vec<IdentityImport>) {
        require_sudo();
        for e in entries {
            if e.root_pubkey == [0u8; 32] {
                continue;
            }
            if !Storage::identity_of().contains(&e.account)
                && !Storage::account_for_identity().contains(&e.root_pubkey)
            {
                set_identity_binding(e.account, e.root_pubkey);
            }
        }
    }

    // --- Identity ---

    /// Bind the caller's product account to the root account `root_pubkey`,
    /// proving control via an sr25519 signature over the canonical identity
    /// message (see `build_identity_message`). Reverts `IdentitySigInvalid`
    /// when verification fails, `IdentitySigLen` if the signature isn't 64 bytes,
    /// and `IdentityRootTaken` if the root is already bound to another account.
    /// Idempotent for the same (caller, root_pubkey).
    ///
    /// `signature` is `Vec<u8>` (Solidity `uint8[]`), NOT `[u8; 64]` — pvm::SolAbi
    /// only implements fixed byte arrays for N ∈ {1,2,4,8,16,20,32}, so a
    /// `[u8;64]` method param does not compile (verified in Task 1).
    #[pvm::method]
    pub fn set_identity(root_pubkey: [u8; 32], signature: Vec<u8>) {
        require_unfrozen();
        let sig: [u8; 64] = match signature.as_slice().try_into() {
            Ok(s) => s,
            Err(_) => revert(b"IdentitySigLen"),
        };
        // Reject the all-zero pubkey: it aliases the "anonymous" sentinel that
        // get_root_account[s] return, so storing it would make a bound account
        // read back as unbound. No valid sr25519 signature exists for it either
        // (the all-zero point isn't a valid Ristretto key), but fail fast with a
        // clear reason rather than relying on the curve check.
        if root_pubkey == [0u8; 32] {
            revert(b"IdentityRootZero");
        }
        let caller_addr = caller();
        if !verify_identity_signature(&sig, &caller_addr, &root_pubkey) {
            revert(b"IdentitySigInvalid");
        }
        set_identity_binding(caller_addr, root_pubkey);
        emit_typed_event(b"IdentityLinked", &IdentityEvent {
            recipient: caller_addr,
            root_pubkey,
        });
        // Top the freshly-onboarded account up once, alongside the one-time
        // identity bonus. Gated on the bonus actually being awarded on THIS call
        // so a repeat reveal can't drain the faucet. Best-effort — emits
        // `FaucetFailed` instead of reverting if the contract is dry, so a dry
        // faucet never rolls back the reveal + bonus.
        if award_identity_bonus_once(caller_addr, &root_pubkey) {
            faucet_or_emit(caller_addr);
        }
    }

    /// DISABLED for the reveal-to-earn contest: there is no anonymous earning
    /// path. Previously this awarded the one-time `IDENTITY_BONUS_XP` to a caller
    /// who chose to stay anonymous; under the contest rules the only way to claim
    /// it is to reveal a verified identity via `set_identity`. Retained on the
    /// ABI for client compatibility — it now always reverts
    /// `AnonymousPathDisabled` so callers get a clear, actionable failure rather
    /// than a silent no-op. (Even without this explicit revert the award would
    /// no-op, because the recipient is anonymous and `try_award` refuses
    /// unrevealed earners — but failing loudly is the better contract surface.)
    #[pvm::method]
    pub fn claim_anonymous_bonus() {
        revert(b"AnonymousPathDisabled");
    }

    /// Remove the caller's identity binding (go anonymous). No bonus refund.
    #[pvm::method]
    pub fn clear_identity() {
        require_unfrozen();
        let caller_addr = caller();
        if clear_identity_binding(caller_addr) {
            emit_typed_event(b"IdentityCleared", &IdentityEvent {
                recipient: caller_addr,
                root_pubkey: [0u8; 32],
            });
        }
    }

    /// Root account bound to `account`, or 32 zero bytes when anonymous.
    #[pvm::method]
    pub fn get_root_account(account: Address) -> [u8; 32] {
        Storage::identity_of().get(&account).unwrap_or([0u8; 32])
    }

    /// Batch variant for the leaderboard. One entry per input, in order;
    /// 32 zero bytes for anonymous accounts. One storage read per address.
    #[pvm::method]
    pub fn get_root_accounts(accounts: Vec<Address>) -> Vec<[u8; 32]> {
        accounts
            .into_iter()
            .map(|a| Storage::identity_of().get(&a).unwrap_or([0u8; 32]))
            .collect()
    }

    /// Admin/sudo: directly set a binding (no signature check — operator override).
    /// Still respects root uniqueness; use admin_clear_identity on the old
    /// account first to transfer a root between accounts intentionally.
    #[pvm::method]
    pub fn admin_set_identity(account: Address, root_pubkey: [u8; 32]) {
        require_unfrozen();
        require_sudo_or_admin();
        // Same zero-sentinel guard as set_identity (use admin_clear_identity to
        // unbind; a zero binding would read back as anonymous).
        if root_pubkey == [0u8; 32] {
            revert(b"IdentityRootZero");
        }
        set_identity_binding(account, root_pubkey);
        emit_typed_event(b"IdentityLinked", &IdentityEvent { recipient: account, root_pubkey });
        // Operator override — award the bonus but deliberately NO faucet top-up:
        // the native gift is part of the user-driven reveal (`set_identity`), not
        // an admin grant. The freshly-awarded bool is intentionally discarded here.
        let _ = award_identity_bonus_once(account, &root_pubkey);
    }

    /// Admin/sudo: clear a binding.
    #[pvm::method]
    pub fn admin_clear_identity(account: Address) {
        require_unfrozen();
        require_sudo_or_admin();
        if clear_identity_binding(account) {
            emit_typed_event(b"IdentityCleared", &IdentityEvent { recipient: account, root_pubkey: [0u8; 32] });
        }
    }

    /// Send the faucet amount (`FAUCET_AMOUNT`, 100 PAS) in native tokens from
    /// this contract account to the caller.
    ///
    /// The contract must be funded separately. This is best-effort: if the
    /// transfer fails (most often because the contract is dry) it emits
    /// `FaucetFailed` rather than reverting, so a top-up is always non-fatal and
    /// off-chain monitoring can pick the failure up.
    #[pvm::method]
    pub fn faucet() {
        faucet_or_emit(caller());
    }

    #[pvm::fallback]
    pub fn fallback() -> Result<(), Error> {
        revert(b"Unknown");
    }

}
