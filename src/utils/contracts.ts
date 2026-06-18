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
import { getAccountsProvider, requestResourceAllocation } from "@parity/product-sdk-host";
import type { PolkadotSigner } from "polkadot-api";
import { Enum } from "polkadot-api";
import { keccak256, utf8ToBytes, bytesToHex } from "@parity/product-sdk-utils";
import { deriveH160, ss58Decode, toGenericSs58 } from "@parity/product-sdk-address";
import { seedToAccount } from "@parity/product-sdk-keys";
import { DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { submitAndWait } from "../builder/submit-and-wait.ts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { summit_asset_hub } from "@parity/product-sdk-descriptors/summit-asset-hub";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";
import { summit_individuality } from "@parity/product-sdk-descriptors/summit-individuality";
import { CHAIN, ENVIRONMENT, type Environment, PLAYGROUND_DOTNS_ID, DEV_FUNDER_MNEMONIC } from "../config.ts";
import cdmJson from "../../cdm.json" with { type: "json" };
import {
  LIVE_CONTRACTS,
  PLAYGROUND_REGISTRY_CONTRACT,
} from "./contractManifest.ts";
import { captureWarning, journeyTracker } from "../lib/telemetry";
import { stringify } from "./stringify.ts";
import { confirmRegistryAddress } from "./snapshotCache.ts";
import { withDeadline, READ_DEADLINE_MS, SIGN_DEADLINE_MS, DeadlineError } from "./deadline.ts";
import { READ_ONLY_QUERY_ORIGIN } from "./readOrigin.ts";
import { ensureChainSubmitPermission, ensurePreimagePermission } from "./hostPermissions.ts";
import { faucetFailedFromEvents } from "./event-stream/txEvents.ts";
// Re-exported below for existing import sites; also used locally by the funder cascade.
import { getNativeBalance } from "./balances.ts";

export type { SignerState };

type ContractFor<K extends string> = K extends keyof Contracts
  ? Contracts[K] extends ContractDef
    ? Contract<Contracts[K]>
    : Contract<ContractDef>
  : Contract<ContractDef>;

export type PlaygroundRegistryContract = ContractFor<typeof PLAYGROUND_REGISTRY_CONTRACT>;

// Origin for every read-only query dry-run: pallet-revive's keyless pallet
// account (see `./readOrigin.ts` for the derivation + rationale). Deliberately
// separate from user transaction signing and not tied to any dev mnemonic.
// Passed explicitly as `defaultOrigin`/`registryOrigin` below so the SDK's
// per-query `"No origin configured"` warning never fires.

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

export const signerManager = new SignerManager({
  dappName: "playground-dot",
  createProvider: (type) =>
    type === "host"
      ? // `requestName: false` skips the host `getUserId` call at connect.
        // That call triggers an identity-permission prompt to populate
        // `SignerAccount.name`, but this app never reads it — display names go
        // registry username → "…" → deterministic H160 name (see
        // `displayNameForAccount`), so fetching the host wallet name only adds a
        // prompt with no payoff. Can still be fetched lazily via
        // `HostProvider.getUserId` if a surface ever needs it.
        // `requestChainSubmitPermission: false` skips the eager ChainSubmit
        // ("broadcast signed transactions to any Substrate chain") permission
        // the SDK otherwise requests inside `tryConnect`. That prompt would
        // fire on the page-load autoconnect below, breaking the prompt-free
        // first-contact experience. We request ChainSubmit lazily on the write
        // path instead (see `ensureChainSubmitPermission`), so the host only
        // asks on the first action that actually signs a transaction.
        new HostProvider({
          productAccount: { dotNsIdentifier: PLAYGROUND_DOTNS_ID, requestName: false },
          requestChainSubmitPermission: false,
        })
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

// Tracks the ENVIRONMENT-selected network ("paseo" | "summit"); the client and
// every descriptor below move together with it. getChainAPI(CHAIN) returns
// exactly this type, so no cast is needed at the assignment.
type ActiveChainClient = ChainClient<PresetChains<Environment>>;

// PAPI descriptors for the active network, selected from ENVIRONMENT in ONE
// place so Asset Hub and the People chain can't be half-wired when a network is
// added — extend this branch and both update together. (Bulletin's descriptor
// is picked inside the SDK from the `environment: CHAIN` string.)
// `ContractManager.fromLiveClient` is generic over its descriptor, so the
// cross-branch union type is accepted as-is.
const descriptors =
  ENVIRONMENT === "summit"
    ? { assetHub: summit_asset_hub, individuality: summit_individuality }
    : { assetHub: paseo_asset_hub, individuality: paseo_individuality };

export interface ContractsReady {
  client: ActiveChainClient;
  registryAddress: string;
  registry: PlaygroundRegistryContract;
}

// Module-load start; the journey is completed in App's loadMore/scheduleDetailsFlush.
journeyTracker.start("page-load");

export const contractsReady: Promise<ContractsReady> = (async () => {
  try {
    // The host transport's typical failure is to HANG, not reject (see
    // deadline.ts). Without a deadline a wedged connection leaves this
    // module-level promise pending forever, so every `await registryReady`
    // hangs and the Apps grid sits on skeletons until a hard refresh
    // re-evaluates the module. The deadline converts that into a rejection
    // the grid's load path surfaces as an actionable "reload" error. Mirrors
    // builder/chain.ts's getAssetHubClient.
    const client = await withDeadline(
      getChainAPI(CHAIN),
      READ_DEADLINE_MS,
      "Chain connection",
    );

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
    const manager = await withDeadline(
      ContractManager.fromLiveClient(
        cdmJson as unknown as CdmJson,
        client.raw.assetHub,
        descriptors.assetHub,
        {
          defaultOrigin: READ_ONLY_QUERY_ORIGIN,
          registryOrigin: READ_ONLY_QUERY_ORIGIN,
          libraries: LIVE_CONTRACTS,
        },
      ),
      READ_DEADLINE_MS,
      "Resolving contract addresses",
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
    // setIdentity / star / getPoints, calls degraded to silent
    // "Cannot read properties of undefined (reading 'tx')" deep in event
    // handlers. Throwing at boot with an actionable message lets the dev
    // know to set `VITE_PLAYGROUND_REGISTRY_PACKAGE=@staging/playground-registry`
    // in `.env.local`. The whitelist below is the methods the v13 surface
    // adds — keep it in sync with the contract or this guard rots.
    const REQUIRED_METHODS = ["setIdentity", "getRootAccount", "getRootAccounts", "star", "getPoints", "getTopBuilders", "getAppData"] as const;
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
    };
  } catch (err) {
    console.error(`[playground] contracts-init failed: ${stringify(err)}`);
    journeyTracker.fail("page-load", "contracts-init-failed", err);
    Sentry.captureException(err, { tags: { phase: "contracts-init" } });
    throw err;
  }
})();

export const registryReady = contractsReady.then(c => c.registry);

/** People/Individuality chain handle (host-routed, like assetHub). Used by the
 *  username resolver (Task 7) and DotNS identity signing (Task 8) so they share
 *  the single configured ENVIRONMENT and the one existing chain client — no
 *  second `getChainAPI` call. Resolves after the client is built, same as
 *  `registryReady`. */
export const individualityReady: Promise<ActiveChainClient["individuality"]> =
  contractsReady.then(c => c.client.individuality);

/** People-chain DESCRIPTOR (not a live client), ENVIRONMENT-selected to match
 *  the single configured chain. This is the value passed as `peopleChain` to
 *  product-sdk PR #212's `signMessageWithDotNsIdentity` — that API wants a chain
 *  descriptor and manages its own connection, unlike the display resolver which
 *  reads the live `individualityReady` handle. */
export const peopleChainDescriptor = descriptors.individuality;

// Arm the snapshot cache with the live-resolved registry address: purges
// snapshots from a previous deploy (a redeploy resets all XP) and enables
// writes. Failure is already reported inside contractsReady.
void contractsReady.then(c => confirmRegistryAddress(c.registryAddress), () => {});

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
// Product-account permission — SmartContractAllowance, verified on-chain
//
// Contract writes (star / unstar / visibility / username / pin) are paid by the
// product account's PGAS balance. `SmartContractAllowance(0)` is the host
// resource that claims that PGAS; it lands on the product account
// (`product/{id}/0` == this account) as an on-chain *balance*, not a host-side
// flag. Because it's a balance it survives a host restart — so the chain, not a
// localStorage memo, is the source of truth. We query the PGAS balance and only
// ask the host to provision the allowance when the account holds none. This is
// why a write no longer re-prompts after Polkadot Desktop is quit and reopened:
// the host drops its in-memory grant, but the PGAS balance is still on-chain.
//
// Playground does NOT request `BulletinAllowance` — the core app only does
// contract writes (no Bulletin uploads), so there's nothing to provision and
// nothing to cache.
// ---------------------------------------------------------------------------

// Balance readers, funds gate, and floor constants are in balances.ts.
// Re-exported here so existing import sites keep working without changes.
export {
  getPgasBalance,
  getNativeBalance,
  hasSufficientFunds,
  InsufficientFundsError,
  isInsufficientFundsError,
  MIN_NATIVE_PLANCK,
  MIN_PGAS,
} from "./balances.ts";
import { getPgasBalance } from "./balances.ts";

// Exported so the onboarding resources gate (`usePgasAllowance`) can reuse the
// same hardened, timeout-bounded balance check.
// Delegates to getPgasBalance (balances.ts) — keeps > 0 semantics: a non-zero
// PGAS balance means the SmartContractAllowance grant is already in place, so
// the host round-trip can be skipped.
export async function hasPgasOnChain(account: SignerAccount): Promise<boolean> {
  const bal = await getPgasBalance(account);
  // Conservative: null means the read failed or timed out — treat as "no PGAS"
  // so we fall through and ask the host (which travels over the host bridge, not
  // the possibly wedged chain socket, so it still succeeds).
  return bal !== null && bal > 0n;
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

// `requestResourceAllocation` prompts over the desktop↔phone bridge — the same
// transport that can WEDGE and never settle (WebView frozen mid-approval, or an
// expired Statement Store channel making every host call hang ~180s — the #344
// symptom documented in `Checking allowances in products.md`). Unbounded, a hung
// allocation pins whatever awaits the grant: the deploy "checking allowances"
// step rode the distant 90s outer `ensureAccountReady` deadline before failing,
// and the onboarding `provisionResources` → `requestAllAllowances` path has NO
// outer deadline at all, so it hung indefinitely. Bound it at the source — a
// dead bridge surfaces a retryable DeadlineError instead of an infinite spinner.
// SIGN_DEADLINE_MS (90s) leaves room for a genuine first-time phone approval (the
// host caps its own prompt at 60s). Mirrors hostPermissions.ts's
// `requestPermissionBounded`; this is the `requestResourceAllocation` analogue of
// PR #396's bounded on-chain PGAS query.
function requestResourceAllocationBounded(
  resources: Parameters<typeof requestResourceAllocation>[0],
): ReturnType<typeof requestResourceAllocation> {
  return withDeadline(
    requestResourceAllocation(resources),
    SIGN_DEADLINE_MS,
    "Requesting resources",
  );
}

// Per-account session memo: the address we've already requested (and been
// granted) `SmartContractAllowance` for this page session. The onboarding
// "Collect my resources" step (`requestAllAllowances`) and the write path
// (`requestProductPermissions`) BOTH request SmartContractAllowance; without
// this, a write fired right after onboarding re-prompts because the on-chain
// PGAS balance hasn't indexed yet (`hasPgasOnChain` still reads false for a
// block or two). Keyed by address — never short-circuits a *different* account.
let smartContractAllowanceGrantedFor: string | null = null;

async function requestProductPermissions(account: SignerAccount): Promise<void> {
  // Already granted for this account this session (e.g. onboarding just ran) —
  // don't re-prompt. PGAS is the authoritative fallback for a fresh session.
  if (smartContractAllowanceGrantedFor === account.address) return;
  // PGAS is authoritative on-chain — only ask the host to provision the
  // SmartContractAllowance if the product account holds no PGAS. PGAS persists
  // across a host restart, so this skips the prompt the old localStorage memo
  // used to (unreliably) skip.
  if (await hasPgasOnChain(account)) {
    smartContractAllowanceGrantedFor = account.address;
    return;
  }
  let outcomes;
  try {
    outcomes = await requestResourceAllocationBounded([
      { tag: "SmartContractAllowance", value: 0 },
    ]);
  } catch (cause) {
    // The host throws here when the user dismisses / cancels the allowance
    // dialog. Re-raise as a typed error so callers can show a cancellation
    // toast instead of a generic save failure.
    console.warn(`[playground] product permissions: ${stringify(cause)}`);
    captureWarning("requestResourceAllocation failed", { error: stringify(cause) });
    // A timeout (wedged host bridge) is NOT a cancel — surface DeadlineError's
    // "temporary connection problem, try again" message so the user retries
    // rather than thinking they dismissed the dialog.
    if (cause instanceof DeadlineError) throw cause;
    throw new PermissionDeniedError("Permission request was cancelled.");
  }
  const [smartContract] = outcomes;
  // SmartContractAllowance MUST be Allocated for writes to succeed.
  if (smartContract?.tag === "Allocated") {
    smartContractAllowanceGrantedFor = account.address;
    return;
  }
  const msg = `SmartContractAllowance(0)=${smartContract?.tag ?? "?"}`;
  console.warn(`[playground] product permissions: ${msg}`);
  captureWarning(`product permissions: ${msg}`, { smartContract: smartContract?.tag });
  throw new PermissionDeniedError(
    `Required permission not granted (smart contract: ${smartContract?.tag ?? "?"}).`,
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
    // Broadcast permission first, then the resource allowance — both are
    // needed before a write can land, and deferring both to here is what keeps
    // the page-load autoconnect prompt-free.
    await ensureChainSubmitPermission();
    await requestProductPermissions(account);
    const signer = signerManager.getSigner();
    if (!signer) throw new Error("Signer connected without a usable PolkadotSigner");
    return signer;
  })().finally(() => {
    pendingSignerReady = null;
  });
  return pendingSignerReady;
}

// ---------------------------------------------------------------------------
// Host user id — the wallet's `primaryUsername`, used only to pre-fill the
// Set-username input with a sensible default handle.
//
// `requestName: false` on the HostProvider (see the SignerManager factory
// above) skips this at connect, so the first call here is what triggers the
// host identity-permission prompt. Returns `null` on every non-happy path —
// host unavailable (plain browser), permission denied, no name set, codec
// drift — so the caller falls back to the deterministic generated name without
// having to care which it was.
//
// Memoised on success for the session: once a name comes back we don't
// re-prompt the next time the modal opens. A denial is deliberately NOT cached,
// so a user who dismissed the prompt can re-open the modal and grant it.
// ---------------------------------------------------------------------------
let cachedUserId: string | null = null;
let userIdInFlight: Promise<string | null> | null = null;

export function fetchHostUserId(): Promise<string | null> {
  if (cachedUserId !== null) return Promise.resolve(cachedUserId);
  if (userIdInFlight) return userIdInFlight;
  userIdInFlight = (async () => {
    try {
      const accounts = await getAccountsProvider();
      if (!accounts) return null;
      // `getUserId` returns a neverthrow ResultAsync — `.match` collapses the
      // PermissionDenied / NotConnected / Unknown error arm to null.
      const name = await accounts.getUserId().match(
        (ok) => ok.primaryUsername ?? "",
        () => "",
      );
      const trimmed = name.trim();
      if (trimmed) cachedUserId = trimmed;
      return trimmed || null;
    } catch (cause) {
      console.warn(`[playground] host getUserId failed: ${stringify(cause)}`);
      return null;
    } finally {
      userIdInFlight = null;
    }
  })();
  return userIdInFlight;
}

// ---------------------------------------------------------------------------
// Batched allowance provisioning — PROTOTYPE (prototype/batched-allowances)
//
// Goal: confirm the browser host accepts a single batched
// `requestResourceAllocation` call covering the deploy allowances we need
// (Bulletin + SmartContract — StatementStore is intentionally NOT requested,
// we don't use it yet), and pair that with a dev-only funder top-up (100 PAS
// stand-in for a real PGAS claim). This replaces the single-resource
// `SmartContractAllowance` path in `requestProductPermissions` for the
// onboarding "Collect my resources" step.
//
// On-chain spend txs (DotNS registration, registry publish, etc.) stay
// sequential as required by the PGAS fee model — batching the spend side
// would break PGAS fee payment. Only the host *permission* request is batched.
//
// ChainSubmit / PreimageSubmit consolidation (folding ensureChainSubmitPermission
// into this batch) is a deliberate follow-up; not in this prototype.
// ---------------------------------------------------------------------------

// 1 PAS = 10^10 planck (Asset Hub decimals).
const ONE_PAS = 10_000_000_000n;
// Dev stand-in: the build-configured funder sends 100 PAS to the product
// account so fees are covered for the prototype session. In production no
// funder is configured and this is skipped — fees come from the PGAS claim
// path (runtime-V5 extrinsic handled by the mobile app, not the Product SDK).
const DEV_FUNDER_TOPUP_PAS = 100n * ONE_PAS;
// Minimum the funder must retain after the top-up to cover its own fee headroom.
const DEV_FUNDER_SOURCE_BUFFER = ONE_PAS;
// Faucet fallback: if the product account holds less than this native balance
// after the dev-funder top-up (e.g. the funder was dry, or there is no funder
// configured on a real host), pull native PAS from the contract faucet instead.
// 11 PAS is what DotNS needs to register a new domain name (price + storage
// deposits), so an account below this can't complete a deploy and should be
// topped up.
const FAUCET_FALLBACK_MIN_PAS = 11n * ONE_PAS;

/**
 * Fire a single batched host allowance dialog covering the deploy allowances we
 * need: BulletinAllowance + SmartContractAllowance.
 *
 * StatementStoreAllowance is intentionally NOT requested — we don't use the
 * Statement Store at this time, so asking for it would add scope to the host
 * dialog for no payoff. Add it back here if/when an SSS surface lands.
 *
 * TAG SPELLING — this browser app talks to the Polkadot Desktop host via
 * `@parity/product-sdk-host` → `@novasamatech/host-api` (v0.8.x), which spells
 * the variant `BulletinAllowance`. The triangle-deploy CLI uses the legacy
 * `BulletInAllowance` (capital I) because its host-papp SSO codec retained the
 * old name — do NOT copy the CLI spelling here, the desktop host rejects it
 * (the whole batch comes back "cancelled"). Same resource `store.ts` documents
 * as enabling host-side Bulletin preimage submission.
 *
 * Outcome[1] (SmartContractAllowance) is REQUIRED — throws PermissionDeniedError
 * if not Allocated. Outcome[0] (BulletinAllowance) is best-effort — logged as a
 * warning if not Allocated but does not block. Full outcome array is logged at
 * info level so we can inspect exactly what the host accepted or rejected.
 *
 * Throws {@link PermissionDeniedError} if the user cancels or if the required
 * SmartContractAllowance is not granted.
 */
async function requestAllAllowances(): Promise<void> {
  let outcomes;
  try {
    // IMPORTANT: request order determines outcome index. SmartContractAllowance
    // is index 1 — the only hard requirement. Bulletin is provisioned alongside
    // it so a single host dialog covers the deploy surface area we use.
    //
    // Host-api v0.8 spelling: `BulletinAllowance` (NOT the CLI's legacy
    // `BulletInAllowance`). If the host ever rejects the batch, the cause is
    // logged in the catch below.
    outcomes = await requestResourceAllocationBounded([
      { tag: "BulletinAllowance", value: undefined },
      { tag: "SmartContractAllowance", value: 0 },
    ]);
  } catch (cause) {
    console.warn(`[playground] requestResourceAllocation(batched) failed: ${stringify(cause)}`);
    captureWarning("requestResourceAllocation(batched) failed", { error: stringify(cause) });
    // A timeout (wedged host bridge) is NOT a cancel — let DeadlineError's
    // retryable "try again" message reach the onboarding UI unchanged.
    if (cause instanceof DeadlineError) throw cause;
    throw new PermissionDeniedError("Permission request was cancelled.");
  }

  // Log the full outcome array so we can inspect exactly what the host accepted.
  // This is the core diagnostic signal for the prototype.
  console.info("[playground] batched allowances:", stringify(outcomes));

  // BulletinAllowance (index 0) — best-effort; warn but do not throw.
  const [bulletin, smartContract] = outcomes;
  if (bulletin?.tag !== "Allocated") {
    console.warn(`[playground] BulletinAllowance not allocated: ${bulletin?.tag ?? "?"}`);
    captureWarning("BulletinAllowance not allocated", { tag: bulletin?.tag ?? "?" });
  }

  // SmartContractAllowance (index 1) — REQUIRED. Mirrors the failure path in
  // `requestProductPermissions` so the error message is consistent.
  if (smartContract?.tag !== "Allocated") {
    const msg = `SmartContractAllowance(0)=${smartContract?.tag ?? "?"}`;
    console.warn(`[playground] batched allowances: ${msg}`);
    captureWarning(`batched allowances: ${msg}`, { smartContract: smartContract?.tag });
    throw new PermissionDeniedError(
      `Required permission not granted (smart contract: ${smartContract?.tag ?? "?"}).`,
    );
  }
}

/**
 * Best-effort dev funding: send 100 PAS to the product account from the first
 * funder that can cover it. NEVER throws — the whole body is wrapped in a
 * try/catch that only logs to the dev console.
 *
 * Funders are tried in order:
 *   1. the build-time `VITE_DEV_FUNDER_MNEMONIC` account (derived at path "")
 *   2. Alice (the well-known dev account) — fallback used only when (1) is the
 *      recipient itself or is short on funds
 *
 * This is a temporary stand-in for the production PGAS claim path (a runtime-V5
 * extrinsic issued by the Polkadot mobile app). When the real PGAS grant lands,
 * this function becomes a no-op and can be removed.
 *
 * Conditions under which the top-up is skipped (all silent):
 *   - VITE_DEV_FUNDER_MNEMONIC is unset — the default for public / production
 *     builds, so there is no funder and the Alice fallback is NOT attempted
 *   - every candidate funder is the recipient itself or has free balance
 *     < DEV_FUNDER_TOPUP_PAS + DEV_FUNDER_SOURCE_BUFFER
 *   - any chain/network error
 *
 * Returns `true` when a transfer completed (the account was funded by the
 * dedicated funder or Alice), `false` otherwise (no funder configured, every
 * candidate short, or any error). Never throws.
 */
export async function attemptMnemonicTopUp(recipientSs58: string): Promise<boolean> {
  // No funder configured (the default): skip the drip entirely — including the
  // Alice fallback. Real users on production builds get fees from the mobile-app
  // PGAS claim path instead.
  if (!DEV_FUNDER_MNEMONIC) return false;

  try {
    const { client } = await contractsReady;

    // Configured funder first, Alice as fallback. Each account is derived only
    // when the loop reaches it, so Alice's sr25519 derivation is skipped
    // entirely when the configured funder already covers the transfer.
    const funders = [
      { label: "configured funder", seed: DEV_FUNDER_MNEMONIC, path: "" },
      { label: "Alice fallback", seed: DEV_PHRASE, path: "//Alice" },
    ];

    for (const { label, seed, path } of funders) {
      const { signer, ss58Address } = seedToAccount(seed, path);

      // Skip if the product account IS this funder (self-transfer would fail).
      if (ss58Address === recipientSs58) continue;

      // Read the funder's native free balance to ensure it has enough headroom.
      const funderAccount = await client.assetHub.query.System.Account.getValue(ss58Address);
      const free = funderAccount.data.free;
      if (free < DEV_FUNDER_TOPUP_PAS + DEV_FUNDER_SOURCE_BUFFER) {
        console.warn(
          `[playground] dev funder top-up — ${label} has insufficient balance: ${free} planck (need ${DEV_FUNDER_TOPUP_PAS + DEV_FUNDER_SOURCE_BUFFER})`,
        );
        continue;
      }

      // Build and submit the transfer. Enum("Id", ...) is the MultiAddress
      // variant expected by Balances.transfer_allow_death on Asset Hub.
      const tx = client.assetHub.tx.Balances.transfer_allow_death({
        dest: Enum("Id", recipientSs58),
        value: DEV_FUNDER_TOPUP_PAS,
      });
      await submitAndWait(tx, signer, undefined, "inBlock");
      console.info(
        `[playground] dev funder top-up complete: sent 100 PAS to ${recipientSs58} from ${label}`,
      );
      return true;
    }

    console.warn(
      "[playground] dev funder top-up skipped — neither the configured funder nor the Alice fallback had enough balance",
    );
    return false;
  } catch (cause) {
    // Best-effort dev stand-in: NEVER surface to the user and don't even page
    // Sentry — a funder running dry / a network blip is an expected no-op here,
    // not a fault worth alerting on. A quiet dev-console line is all we keep.
    console.warn(`[playground] dev funder top-up skipped (non-fatal): ${stringify(cause)}`);
    return false;
  }
}

/**
 * True when the product account holds enough native PAS to complete a deploy
 * (free balance ≥ {@link FAUCET_FALLBACK_MIN_PAS}). Used both to gate the faucet
 * fallback (don't double-dip when already funded) and, after the funder cascade,
 * to decide authoritatively whether any source actually funded the account.
 * A failed/timed-out read (`getNativeBalance` → null) reads as "not funded".
 */
async function isProductAccountFunded(account: SignerAccount): Promise<boolean> {
  return ((await getNativeBalance(account)) ?? 0n) >= FAUCET_FALLBACK_MIN_PAS;
}

/**
 * Best-effort native-PAS fallback for when {@link attemptMnemonicTopUp} can't fund
 * the account — Alice is dry, or (the production case) there is no Alice key at
 * all. Calls the registry contract's `faucet()`, which sends native PAS from the
 * contract's own balance to the caller. The product account pays the call fee in
 * PGAS (granted just above in `provisionResources`) and receives the faucet
 * amount; this is the production-shaped analogue of the dev Alice transfer.
 *
 * NEVER throws. Skips silently when:
 *   - the account is already funded above {@link FAUCET_FALLBACK_MIN_PAS}
 *     (Alice succeeded, or the account was pre-funded),
 *   - no signer is available,
 *   - any chain/network error.
 *
 * The contract's `faucet()` is best-effort and does NOT revert when the contract
 * is dry — it emits a `FaucetFailed` event and the tx still reports `ok`. So a
 * successful tx here does not prove PAS arrived. We inspect the tx's events for
 * `FaucetFailed` and return `true` when the faucet was dry, so the onboarding
 * flow can tell the user it's a problem on our side instead of a false success.
 *
 * Returns `true` ONLY when the faucet was attempted and came back dry. The
 * already-funded early-return, a missing signer, and any thrown error all return
 * `false` (no dry-faucet signal to surface). Never throws.
 */
async function attemptFaucetTopUp(account: SignerAccount): Promise<boolean> {
  try {
    const { registry, registryAddress } = await contractsReady;

    if (await isProductAccountFunded(account)) return false; // already funded — don't double-dip.

    const signer = signerManager.getSigner();
    if (!signer) {
      console.warn("[playground] faucet top-up skipped — no signer available");
      return false;
    }

    // The caller (= the product account) receives the faucet's native PAS and
    // pays the call fee in PGAS. Origin pins the dry-run/caller to this account.
    const result = await registry.faucet.tx({ signer, origin: account.address });
    if ((result as { ok?: unknown })?.ok === false) {
      // faucet() no longer reverts on a dry contract (it emits FaucetFailed), so
      // ok === false now means a genuine submission/chain failure.
      console.warn(`[playground] faucet top-up tx not ok: ${stringify(result)}`);
      return false;
    }
    // The tx succeeding doesn't prove PAS arrived: a dry faucet emits FaucetFailed
    // and still reports ok. Detect that from the tx events so the caller surfaces
    // an "it's on us" message rather than a false "topped up".
    const events = (result as { events?: readonly unknown[] })?.events ?? [];
    if (faucetFailedFromEvents(events, registryAddress)) {
      console.warn(`[playground] faucet is dry — FaucetFailed for ${account.address}`);
      return true;
    }
    console.info(`[playground] faucet top-up submitted for ${account.address}`);
    return false;
  } catch (cause) {
    console.warn(`[playground] faucet top-up skipped (non-fatal): ${stringify(cause)}`);
    return false;
  }
}

/**
 * Provision all resources needed for the connected product account to write
 * on-chain. Called by the onboarding "Collect my resources" step.
 *
 * Four actions are performed in sequence:
 *
 * 1. **ChainSubmit** (best-effort) — front-loads the "broadcast signed
 *    transactions" host permission so later write paths don't re-prompt. Only
 *    SmartContractAllowance (step 2) is required and can throw PermissionDeniedError.
 *
 * 2. **Single batched host dialog** — `requestResourceAllocation` with the
 *    deploy allowances we use (BulletinAllowance + SmartContractAllowance).
 *    One dialog instead of separate prompts. SmartContractAllowance is
 *    required; Bulletin is best-effort. StatementStore is intentionally not
 *    requested (unused at this time).
 *
 * 3. **PreimageSubmit** (best-effort) — front-loads the Bulletin preimage
 *    submission permission so later Bulletin uploads don't re-prompt.
 *
 * 4. **Dev-only funder top-up** — when a `VITE_DEV_FUNDER_MNEMONIC` is set at
 *    build time, sends 100 PAS to the product account from that funder (or from
 *    Alice as a fallback if it's short on funds) so txs can be signed.
 *    Temporary stand-in for the production PGAS claim path (handled by the
 *    Polkadot mobile app, not the Product SDK). Best-effort: silently skips
 *    when no funder is configured, every funder is low, or the transfer fails.
 *
 * 5. **Faucet fallback** — if the account is still under-funded in native PAS
 *    after Alice (Alice dry, or no Alice key on a real host), call the registry
 *    contract's `faucet()` to pull native PAS from the contract. Best-effort:
 *    silently skips if already funded, no signer, or the faucet/contract is dry.
 *
 * Note: on-chain spend transactions (DotNS, registry publish, etc.) remain
 * sequential to satisfy the PGAS fee model — this function only batches the
 * host *permission* request, not the spend side.
 *
 * Throws {@link PermissionDeniedError} if the user cancels or if the required
 * SmartContractAllowance is not granted.
 *
 * Returns `{ funded }` — an authoritative post-cascade balance check. `false`
 * means every funder (dedicated mnemonic → Alice → contract faucet) failed and
 * the account holds no spendable tokens; callers use `funded === false` to tell
 * the user we're out of resources rather than report success.
 */
export async function provisionResources(): Promise<{ funded: boolean }> {
  // Mirror the connect block from `ensureSignerReady` so `provisionResources`
  // can be called as a standalone onboarding step before any write action.
  let account = signerManager.getState().selectedAccount;
  if (!account) {
    const result = await signerManager.connect();
    if (!result.ok) throw result.error;
    account = signerManager.getState().selectedAccount;
    if (!account) throw new Error("Signer connected without an account");
  }

  // Front-load broadcast permission so later writes don't re-prompt.
  await ensureChainSubmitPermission(); // best-effort: ChainSubmit permission
  // Single batched host dialog for all allowances (BulletinAllowance + SmartContractAllowance).
  await requestAllAllowances();        // required: SmartContractAllowance (+ Bulletin)
  // Record the grant so the write path (`requestProductPermissions`) doesn't
  // re-prompt for SmartContractAllowance on the first publish/star/claim — the
  // on-chain PGAS balance lags the grant by a block or two.
  smartContractAllowanceGrantedFor = account.address;
  // Front-load Bulletin preimage permission so later uploads don't re-prompt.
  await ensurePreimagePermission();    // best-effort: PreimageSubmit permission

  // Top-up funder cascade: D → A → F. Try the no-phone-signature mnemonic
  // funders first (dedicated → Alice), then fall back to the contract faucet
  // (which costs the user a phone signature) only if those didn't fund it.
  // Best-effort — never blocks or throws; no-ops unless a VITE_DEV_FUNDER_MNEMONIC
  // was set at build time.
  await attemptMnemonicTopUp(account.address);
  // Fallback: if the mnemonic funders couldn't fund the account, pull native PAS
  // from the contract faucet (the account pays the call fee in PGAS, granted
  // above). Best-effort — never blocks or throws.
  await attemptFaucetTopUp(account);
  // Authoritative result: re-read the balance so `funded` reflects what actually
  // landed, rather than trusting any single source's best-effort signal — a
  // funder can report no error yet leave the account unfunded (no signer, dry
  // faucet, thrown read). `funded === false` means every source failed.
  const funded = await isProductAccountFunded(account);
  return { funded };
}
