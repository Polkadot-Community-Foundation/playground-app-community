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

import { useSyncExternalStore } from "react";
import * as Sentry from "@sentry/react";
import { getChainAPI, type ChainClient, type PresetChains } from "@parity/product-sdk-chain-client";
import {
  ContractManager,
  type CdmJson,
  type Contract,
  type ContractDef,
  type Contracts,
} from "@parity/product-sdk-contracts";
import {
  HostProvider,
  SignerManager,
  type SignerAccount,
  type SignerState,
} from "@parity/product-sdk-signer";
import { requestResourceAllocation } from "@parity/product-sdk-host";
import type { PolkadotSigner } from "polkadot-api";
import { keccak256, utf8ToBytes, bytesToHex } from "@parity/product-sdk-utils";
import { deriveH160, ss58Decode, toGenericSs58 } from "@parity/product-sdk-address";
import { seedToAccount } from "@parity/product-sdk-keys";
import { DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { summit_asset_hub } from "@parity/product-sdk-descriptors/summit-asset-hub";
import { CHAIN, PLAYGROUND_DOTNS_ID } from "../config.ts";
import cdmJson from "../../cdm.json" with { type: "json" };
import {
  LIVE_CONTRACTS,
  PLAYGROUND_REGISTRY_CONTRACT,
  REPUTATION_CONTRACT,
} from "./contractManifest.ts";
import { captureWarning, journeyTracker } from "../lib/telemetry";
import { stringify } from "./stringify.ts";

export type { SignerState };

type ContractFor<K extends string> = K extends keyof Contracts
  ? Contracts[K] extends ContractDef
    ? Contract<Contracts[K]>
    : Contract<ContractDef>
  : Contract<ContractDef>;

export type PlaygroundRegistryContract = ContractFor<typeof PLAYGROUND_REGISTRY_CONTRACT>;
export type ReputationContract = ContractFor<typeof REPUTATION_CONTRACT>;

// Read origin for every query dry-run. This is deliberately separate from
// user transaction signing so public reads do not depend on the connected
// product account. Lazy so sr25519 derivation stays off the synchronous
// module-load path.
let _readOrigin: string | undefined;
const READ_ORIGIN_DERIVATION = "//playground-querier";
const getReadOrigin = () => (_readOrigin ??= seedToAccount(DEV_PHRASE, READ_ORIGIN_DERIVATION).ss58Address);

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

export const signerManager = new SignerManager({
  dappName: "playground-dot",
  createProvider: (type) =>
    type === "host"
      ? new HostProvider({ productAccount: { dotNsIdentifier: PLAYGROUND_DOTNS_ID } })
      : new HostProvider(),
  // Reads use the dedicated dry-run origin (no signerManager on the
  // ContractManager below), so allowance requests stay deferred until a
  // write action calls `ensureSignerReady`. `onConnect` runs the diagnostic
  // mapping check whenever a session opens.
  onConnect: async (account) => {
    await Promise.all([
      logAccountInfo(account),
      logReviveMappingStatus(account),
    ]);
  },
});

// The host derives a single product account for this dapp (no picker), so
// connecting on load is silent and re-attaches a persisted session without
// prompting. Allowances stay lazy via `ensureSignerReady`.
signerManager.connect().catch((cause) => {
  captureWarning("signer.autoconnect-failed", cause);
});

export function useSignerState(): SignerState {
  return useSyncExternalStore(
    (cb) => signerManager.subscribe(cb),
    () => signerManager.getState(),
  );
}

// Subscribed at module scope so the authenticate journey survives StrictMode
// remounts and isn't restarted on every component lifecycle.
let prevSignerStatus: SignerState["status"] | null = null;
let prevUserAddress: string | null = null;

// Truncated keccak256 of the H160 — stable per account, doesn't expose the raw
// address in the Sentry dashboard. Hash isn't a privacy guarantee (H160 is
// public), just removes incidental visibility from anyone with project access.
function hashedUserId(address: string): string {
  return bytesToHex(keccak256(utf8ToBytes(address.toLowerCase()))).slice(0, 16);
}

const unsubscribeSigner = signerManager.subscribe((state) => {
  const status = state.status;
  if (prevSignerStatus !== "connecting" && status === "connecting") {
    if (!journeyTracker.isActive("authenticate")) {
      journeyTracker.start("authenticate");
    }
    journeyTracker.milestone("authenticate", "connect-initiated");
  }
  if (prevSignerStatus !== "connected" && status === "connected" && state.selectedAccount) {
    if (journeyTracker.isActive("authenticate")) {
      journeyTracker.milestone("authenticate", "account-selected");
      journeyTracker.addAttributes("authenticate", { "auth.has_account": true });
      journeyTracker.complete("authenticate");
    }
  }
  if (status === "disconnected" && journeyTracker.isActive("authenticate")) {
    journeyTracker.abandon("authenticate");
  }
  prevSignerStatus = status;

  const currentAddress = state.selectedAccount?.h160Address ?? null;
  if (currentAddress !== prevUserAddress) {
    Sentry.setUser(currentAddress ? { id: hashedUserId(currentAddress) } : null);
    prevUserAddress = currentAddress;
  }
});

if (import.meta.hot) {
  // Without this, every dev save accumulates another subscriber and a fresh
  // page-load journey on top of the previous one.
  import.meta.hot.dispose(() => {
    unsubscribeSigner();
    if (journeyTracker.isActive("page-load")) {
      journeyTracker.abandon("page-load");
    }
  });
}

// ---------------------------------------------------------------------------
// Contracts — singleton, starts connecting on module load
//
// Hybrid resolution: ABI is read from cdm.json (snapshot captured at
// `cdm install` time, used for typing + decoding). The address is refreshed
// on boot from the on-chain CDM meta-registry, so a fresh deploy of a tracked
// contract is picked up without rebuilding the frontend. Falls back to the
// cdm.json snapshot if the meta-registry call fails.
// ---------------------------------------------------------------------------

type SummitChainClient = ChainClient<PresetChains<"summit">>;

export interface ContractsReady {
  client: SummitChainClient;
  registryAddress: string;
  registry: PlaygroundRegistryContract;
  reputation: ReputationContract;
}

// Module-load start; the journey is completed in App's loadMore/scheduleDetailsFlush.
journeyTracker.start("page-load");

export const contractsReady: Promise<ContractsReady> = (async () => {
  try {
    const client = await getChainAPI(CHAIN);

    // Live address resolution: the CDM meta-registry is queried at boot for
    // each library in LIVE_CONTRACTS, so a fresh deploy is picked up without
    // rebuilding the frontend. ABIs still come from the installed cdm.json
    // snapshot. Strict-fail: if the registry call rejects, this throws —
    // pairing a stale snapshot address with a newer ABI (or vice versa) is
    // worse than a hard boot failure.
    //
    // Deliberately no signerManager — reads use a dedicated dry-run origin
    // so the grid populates without prompting the user to sign in. Writes
    // pass an explicit `{ signer }` via `runTx`/`ensureSignerReady` instead.
    // Setting `defaultOrigin` also suppresses the SDK's per-query
    // `"No origin configured"` warning.
    const manager = await ContractManager.fromLiveClient(
      cdmJson as unknown as CdmJson,
      client.raw.assetHub,
      summit_asset_hub,
      {
        defaultOrigin: getReadOrigin(),
        registryOrigin: getReadOrigin(),
        libraries: LIVE_CONTRACTS,
      },
    );
    // Boot-time log of the addresses fromLiveClient pulled from the on-chain
    // CDM meta-registry. Cheap to print; saves a lot of guessing the next
    // time someone is staring at a blank registry grid wondering whether
    // the frontend resolved to the contract they think it did.
    console.info(
      `[contracts] live-resolved addresses: ` +
        LIVE_CONTRACTS.map((lib) => `${lib}=${manager.getAddress(lib as never)}`).join(", "),
    );
    journeyTracker.milestone("page-load", "contracts-ready");
    const registry = manager.getContract(PLAYGROUND_REGISTRY_CONTRACT);
    // Loud-fail guard: the resolved ABI must expose the surface this build of
    // the UI assumes. We hit this exact failure mode before — when the
    // frontend resolved to an older @w3s deploy that didn't have
    // setUsername / star / getPoints, calls degraded to silent
    // "Cannot read properties of undefined (reading 'tx')" deep in event
    // handlers. Throwing at boot with an actionable message lets the dev
    // know to set `VITE_PLAYGROUND_REGISTRY_PACKAGE=@staging/playground-registry`
    // in `.env.local`. The whitelist below is the methods the v13 surface
    // adds — keep it in sync with the contract or this guard rots.
    const REQUIRED_METHODS = ["setUsername", "getUsernameOwner", "star", "getPoints", "getTopBuilders"] as const;
    const missing = REQUIRED_METHODS.filter(
      (m) => typeof (registry as unknown as Record<string, { tx?: unknown; query?: unknown }>)[m] !== "object",
    );
    if (missing.length > 0) {
      throw new Error(
        `Resolved registry contract "${PLAYGROUND_REGISTRY_CONTRACT}" is missing methods: ${missing.join(", ")}. ` +
          `The deployed contract is older than this UI expects. ` +
          `For local development against staging, set ` +
          `VITE_PLAYGROUND_REGISTRY_PACKAGE=@staging/playground-registry in .env.local and restart vite.`,
      );
    }
    return {
      client,
      registryAddress: manager.getAddress(PLAYGROUND_REGISTRY_CONTRACT) as string,
      registry,
      reputation: manager.getContract(REPUTATION_CONTRACT),
    };
  } catch (err) {
    console.error(`[playground] contracts-init failed: ${stringify(err)}`);
    journeyTracker.fail("page-load", "contracts-init-failed", err);
    Sentry.captureException(err, { tags: { phase: "contracts-init" } });
    throw err;
  }
})();

export const registryReady = contractsReady.then(c => c.registry);
export const reputationReady = contractsReady.then(c => c.reputation);

// ---------------------------------------------------------------------------
// Pallet-revive auto-mapper (TEMP)
//
// Polkadot Mobile derives a fresh product account per app and doesn't register
// it with pallet-revive. Without the SS58↔H160 binding, eth_call dry-runs
// silently return success:false. We auto-submit Revive.map_account() once
// after sign-in.
//
// Failure modes that block this in practice: account has zero balance and
// can't pay the ~2 PAS deposit (Invalid::Payment), or the SSO sign flow is
// itself broken upstream. As a one-time bootstrap, run scripts/map-account.ts
// manually with the wallet mnemonic.
// ---------------------------------------------------------------------------
let mapAttempted = false;

async function ensureReviveMapped(account: SignerAccount): Promise<void> {
  if (mapAttempted) return;
  mapAttempted = true;
  const h160 = account.h160Address as `0x${string}`;
  try {
    const { client } = await contractsReady;
    const ah = client.assetHub;
    const existing = await ah.query.Revive.OriginalAccount.getValue(h160);
    if (existing) {
      console.info(`[playground] Revive already mapped for ${h160}`);
      return;
    }
    const rawSigner = signerManager.getSigner();
    if (!rawSigner) {
      mapAttempted = false;
      return;
    }
    const result = await ah.tx.Revive.map_account().signAndSubmit(rawSigner);
    console.info(
      `[playground] Revive.map_account() submitted: ${stringify(result)}`,
    );
    if (!result.ok) {
      // Reset so a subsequent state-change can retry — e.g. after the user
      // tops up the SS58 with PAS to cover the deposit.
      mapAttempted = false;
    }
  } catch (cause) {
    mapAttempted = false;
    console.warn(
      `[playground] Revive.map_account() failed: ${stringify(cause)}`,
    );
    Sentry.addBreadcrumb({
      category: "revive.map-account",
      message: "auto-map failed",
      level: "warning",
      data: { error: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

// Auto-mapping disabled while we debug post-tx chainHead disjoint issues.
// To re-enable, uncomment the subscription registration in the
// `requestProductPermissions` block below alongside the allowance request.
// Bootstrap mapping manually via `pnpm tsx scripts/map-account.ts` in the
// meantime (account must hold ~2 PAS to cover the deposit).
void ensureReviveMapped; // keep reference alive while disabled

const mappingChecked = new Set<string>();

// One-line connect log: address + native free balance. Catches the most
// common "why doesn't anything work" cause (zero balance can't pay the
// Revive deposit or extrinsic fees). Free is shown in planck and in PAS
// (10 decimals on Asset Hub).
async function logAccountInfo(account: SignerAccount): Promise<void> {
  try {
    const { client } = await contractsReady;
    const sysAccount = await client.assetHub.query.System.Account.getValue(account.address);
    const free = sysAccount.data.free;
    const pas = Number(free) / 1e10;
    console.info(
      `[playground] connected: ${account.address} (${account.h160Address}) free=${free} planck (~${pas.toFixed(4)} PAS)`,
    );
  } catch (cause) {
    console.warn(`[playground] account info lookup failed for ${account.address}: ${stringify(cause)}`);
  }
}

// Warn-on-failure check: an unmapped product account causes every contract
// dry-run to silently return success=false. Stays quiet on the happy path;
// shouts when the H160 has no SS58 origin in pallet-revive, or when the
// stored origin decodes to a different H160 (which would mean someone
// map_account()'d this H160 from a different account — a real bug).
async function logReviveMappingStatus(account: SignerAccount): Promise<void> {
  const h160 = account.h160Address.toLowerCase();
  if (mappingChecked.has(h160)) return;
  mappingChecked.add(h160);

  try {
    const { client } = await contractsReady;
    const mapped = await client.assetHub.query.Revive.OriginalAccount.getValue(
      account.h160Address as `0x${string}`,
    );
    if (!mapped) {
      console.warn(
        `[playground] Revive mapping missing for ${account.h160Address} — dry-runs will return success=false until the account is map_account()'d`,
      );
      return;
    }
    const mappedStr = String(mapped);
    try {
      const info = ss58Decode(mappedStr);
      const derivedH160 = deriveH160(info.publicKey).toLowerCase();
      if (derivedH160 !== h160) {
        console.warn(
          `[playground] Revive mapping mismatch for ${account.h160Address}: stored origin ${mappedStr} (generic=${toGenericSs58(mappedStr)}) decodes to ${derivedH160}`,
        );
      }
    } catch (cause) {
      console.warn(
        `[playground] Revive mapping for ${account.h160Address}: failed to decode stored origin ${mappedStr}: ${stringify(cause)}`,
      );
    }
  } catch (cause) {
    mappingChecked.delete(h160);
    console.warn(
      `[playground] Revive mapping check failed for ${account.h160Address}: ${stringify(cause)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Product-account permissions — request once per account, persisted locally
//
// The product account (derivation index 0) needs:
//   - `SmartContractAllowance(0)`: budget for contract calls signed by this
//     account, so users can rate apps / toggle visibility / etc. without
//     pre-funding the account.
//   - `AutoSigning`: skip per-tx host prompts after this one — turns rating
//     and other one-tap interactions into actual one-tap interactions.
// We request both in a single `host_request_resource_allocation` round-trip
// so the user sees at most one host UI for both. Outcomes are per-resource
// (`Allocated` / `Rejected` / `NotAvailable`), logged independently.
//
// The host does not remember the grant across page reloads — the product is
// expected to persist it. We mark an account as granted in localStorage once
// `SmartContractAllowance` comes back `Allocated` and skip the host round-trip
// on every subsequent load for that account. AutoSigning is currently
// unimplemented host-side and always returns `NotAvailable`, so we don't gate
// the cache on it; once the host ships it, bump the storage key version below
// to force a re-request that surfaces the new dialog. If contract calls later
// start failing the user can clear localStorage to force a re-request.
// ---------------------------------------------------------------------------
// Key version: bump when the acceptance policy in `requestProductPermissions`
// changes (e.g. AutoSigning moves from `NotAvailable=ok` to `Allocated-only`).
// Bumping invalidates every client's cached grant and forces a fresh
// host-prompt so the new policy actually takes effect.
const PERMISSION_STORAGE_PREFIX = "playground:permissions:v2:";

function permissionStorageKey(account: SignerAccount): string {
  return PERMISSION_STORAGE_PREFIX + account.h160Address.toLowerCase();
}

function hasGrantedPermissions(account: SignerAccount): boolean {
  try {
    return localStorage.getItem(permissionStorageKey(account)) === "granted";
  } catch {
    return false;
  }
}

function markPermissionsGranted(account: SignerAccount): void {
  try {
    localStorage.setItem(permissionStorageKey(account), "granted");
  } catch {
    // localStorage may be unavailable (private browsing, quota); the host
    // will just re-prompt next time, which is degraded but not broken.
  }
}

/**
 * Thrown by {@link ensureSignerReady} when the host prompt is cancelled or
 * the user denies a required allowance. Callers can branch on
 * `err.name === "PermissionDeniedError"` to surface a friendly cancellation
 * UX (close the modal, toast the reason) instead of treating it as a
 * generic failure.
 */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

async function requestProductPermissions(account: SignerAccount): Promise<void> {
  if (hasGrantedPermissions(account)) return;
  let outcomes;
  try {
    outcomes = await requestResourceAllocation([
      { tag: "SmartContractAllowance", value: 0 },
      // Bulletin uploads (icons, cover images, app bundles) need this — the
      // host rejects unallocated `preimage` submits with a generic
      // `{ reason: "message too big" }` IPC error. Bundling here means one
      // host dialog covers SmartContract + Bulletin + AutoSigning.
      { tag: "BulletinAllowance", value: undefined },
      { tag: "AutoSigning", value: undefined },
    ]);
  } catch (cause) {
    // The host throws here when the user dismisses / cancels the allowance
    // dialog. Re-raise as a typed error so callers can show a cancellation
    // toast instead of a generic save failure.
    console.warn(`[playground] product permissions: ${stringify(cause)}`);
    captureWarning("requestResourceAllocation failed", { error: stringify(cause) });
    throw new PermissionDeniedError("Permission request was cancelled.");
  }
  const [smartContract, bulletin, autoSigning] = outcomes;
  const msg = `SmartContractAllowance(0)=${smartContract?.tag ?? "?"}, BulletinAllowance=${bulletin?.tag ?? "?"}, AutoSigning=${autoSigning?.tag ?? "?"}`;
  // SmartContractAllowance MUST be Allocated for writes to succeed.
  // BulletinAllowance MUST be Allocated for cover-image / icon uploads.
  // AutoSigning is best-effort — the host hasn't shipped it yet, so we
  // don't gate the cache on it. When it ships, require Allocated and
  // bump PERMISSION_STORAGE_PREFIX so the looser cache invalidates.
  if (smartContract?.tag === "Allocated" && bulletin?.tag === "Allocated") {
    markPermissionsGranted(account);
    return;
  }
  console.warn(`[playground] product permissions: ${msg}`);
  captureWarning(`product permissions: ${msg}`, {
    smartContract: smartContract?.tag,
    bulletin: bulletin?.tag,
    autoSigning: autoSigning?.tag,
  });
  throw new PermissionDeniedError(
    `Required permissions not granted (smart contract: ${smartContract?.tag ?? "?"}, bulletin: ${bulletin?.tag ?? "?"}).`,
  );
}

/**
 * Connect (if needed) and request the SmartContractAllowance so a write
 * can proceed. Returns the PolkadotSigner for the connected account.
 *
 * Called by `runTx` so write actions trigger the host prompts; reads bypass
 * this path entirely and use the dedicated dry-run origin above.
 *
 * Concurrent callers share a single in-flight promise — without this, two
 * back-to-back writes from disconnected state would both call
 * `signerManager.connect()`, whose own `cancelConnect()` would abort the
 * earlier attempt and surface a spurious "connect failed" to the first
 * caller.
 */
let pendingSignerReady: Promise<PolkadotSigner> | null = null;
export function ensureSignerReady(): Promise<PolkadotSigner> {
  if (pendingSignerReady) return pendingSignerReady;
  pendingSignerReady = (async () => {
    let account = signerManager.getState().selectedAccount;
    if (!account) {
      const result = await signerManager.connect();
      if (!result.ok) throw result.error;
      account = signerManager.getState().selectedAccount;
      // connect() can resolve `ok` with an empty account list — the host
      // returned accounts but none matched the dotNS-derived product
      // account. Fall through to an explicit error so callers see the cause
      // instead of a `getSigner() returned null` later.
      if (!account) throw new Error("Signer connected without an account");
    }
    await requestProductPermissions(account);
    const signer = signerManager.getSigner();
    if (!signer) throw new Error("Signer connected without a usable PolkadotSigner");
    return signer;
  })().finally(() => {
    pendingSignerReady = null;
  });
  return pendingSignerReady;
}
