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
 * Layer (b) — contract test harness.
 *
 * Uses polkadot-api directly (NOT `@parity/product-sdk-chain-client`).
 * The chain-client routes RPC through the host transport and so throws
 * `BulletinHostUnavailableError` outside Polkadot Desktop/Mobile — that's
 * by design for the app's runtime, but unhelpful in Node.
 *
 * Two modes:
 *  - **Paseo** (default): connect to the live Paseo Asset Hub RPC. Read
 *    tests run here; they assert on the deployed registry contract's
 *    observable surface without mutating state.
 *  - **Local** (CONTRACT_RPC_URL=ws://localhost:9944): connect to a fresh
 *    revive-dev-node. Write tests run here; they need controllable state.
 *    Scaffolded — write tests are `.skip`-gated on `canWrite()` until the
 *    deploy harness lands.
 */

import { createClient, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  createContract,
  createContractRuntimeFromClient,
  type CdmJson,
  type Contract,
  type ContractDef,
  type ContractRuntime,
} from "@parity/product-sdk-contracts";
import {
  ensureAccountMapped,
  type MappingChecker,
  type ReviveApi,
} from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";
import { DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import type { HexString } from "polkadot-api";
import cdmJson from "../../cdm.json" with { type: "json" };

/// Staging mode — set `STAGING_SURI` to a funded mnemonic / //suri to point
/// the suite at `@staging/playground-registry` on Paseo Next, using that
/// SURI's bare-root account as the publisher and its `//Bob` / `//Charlie`
/// / `//Dave` derivations as additional voter accounts (auto-funded from
/// the publisher in `ensureMapped`). Without `STAGING_SURI` the suite
/// targets `@w3s/playground-registry` as before and only writes locally.
export function isStaging(): boolean {
  return Boolean(process.env.STAGING_SURI);
}

export const REGISTRY_NAME = isStaging()
  ? "@staging/playground-registry"
  : "@w3s/playground-registry";
export const FIXTURE_DOMAIN = "playground-e2e-app.dot";

/// Default endpoint for the local revive-dev-node spun up by `cdm test`.
/// Override with CONTRACT_RPC_URL to point at a different port.
export const LOCAL_RPC_URL_DEFAULT = "ws://localhost:9944";

/// Gas / storage-deposit overrides for write txs. The auto-estimator dry-runs
/// at the prior-tx state, which under-counts when a serial sequence keeps
/// growing storage. Pinning the limits high bypasses the estimator entirely.
///
/// `waitFor: "finalized"` is the slow-but-correct default on PPN's
/// slow-finality chain. We tried `"best-block"` + a `dryRunCall` patch to
/// read at `"best"` (see getHandles) — reads worked, but PAPI's tx
/// pipeline still queries the signer's nonce from finalized state. The
/// pre-finalization view of nonce N leads to two txs signed at N → the
/// second one returns `InvalidTransaction::Stale` once block production
/// catches up. Until PPN auto-finalizes (chain-side config) or PAPI lets
/// us pin the nonce-read block to `"best"`, finalized is the only safe
/// choice. The dryRunCall patch is left in place as defense-in-depth for
/// any future read-after-best-block scenario.
export const WRITE_TX_OPTS = {
  // Asset Hub's normal-class per-extrinsic ceiling is ~75% of block (1.5T
  // ref_time, ~3.75MB proof_size). Pinning to the max headroom — the
  // OrderedIndex maintenance for star_index / mod_index reads more nodes
  // as the tree grows, and proof_size scales linearly with storage reads.
  // At ~30 entries we already see ~230KB proof_size; the Summit-scale
  // target (150 apps / 400 stars) needs room to grow.
  gasLimit: { ref_time: 1_500_000_000_000n, proof_size: 3_500_000n },
  storageDepositLimit: 1_000_000_000_000n,
  waitFor: "finalized" as const,
} as const;

/// A dev-phrase-derived account. Local revive-dev-node / PPN pre-funds the
/// standard dev paths (`//Alice`, `//Bob`, ...). Use these for multi-signer
/// scenarios that need distinct on-chain callers (e.g. star/mod dedupe).
export interface DevAccount {
  name: string;
  h160: `0x${string}`;
  ss58: string;
  signer: PolkadotSigner;
}

export function devAccount(name: string, path: `//${string}`): DevAccount {
  // In staging mode the SURI's bare-root account is the funded publisher
  // (mapped to the `Alice` slot used by every existing test); other slots
  // are derived sub-accounts of the same SURI that get auto-funded +
  // auto-mapped on first use. Outside staging, the public DEV_PHRASE feeds
  // the well-known //Alice / //Bob / ... dev accounts that PPN pre-funds.
  if (isStaging()) {
    const seed = process.env.STAGING_SURI!;
    const derivePath = name === "Alice" ? "" : path;
    const acct = seedToAccount(seed, derivePath);
    return {
      name,
      h160: acct.h160Address.toLowerCase() as `0x${string}`,
      ss58: acct.ss58Address,
      signer: acct.signer,
    };
  }
  const acct = seedToAccount(DEV_PHRASE, path);
  return {
    name,
    h160: acct.h160Address.toLowerCase() as `0x${string}`,
    ss58: acct.ss58Address,
    signer: acct.signer,
  };
}

/// Asset-hub RPC for staging / paseo. cdm.json no longer stores per-target
/// RPCs after the v0.8.18 flat-manifest migration (commit c1507a0), so we
/// source the URL from env with a Paseo Next default that matches
/// `scripts/smoke-test-points.ts`. Override via `ASSET_HUB_RPC_URL` when the
/// live playground network rotates.
const ASSET_HUB_RPC_DEFAULT = "wss://paseo-asset-hub-next-rpc.polkadot.io";

function assetHubRpc(): string {
  return process.env.ASSET_HUB_RPC_URL ?? ASSET_HUB_RPC_DEFAULT;
}

export type ChainTarget = "paseo" | "local";

/// Pick local vs paseo. `CONTRACT_RPC_URL` is the only local signal under
/// the flat cdm.json — without a `targets` block we can't sniff a loopback
/// URL out of the manifest, so the operator MUST set CONTRACT_RPC_URL to
/// point the suite at a local revive-dev-node. Absent it ⇒ paseo / staging.
export function getChainTarget(): ChainTarget {
  if (process.env.CONTRACT_RPC_URL) return "local";
  return "paseo";
}

/// Open a transient WebSocket to confirm the local chain is reachable.
/// Throws with a runbook pointer when it isn't, so `cdm test` against a
/// down PPN reports a useful error rather than hanging the suite.
async function assertReachable(rpcUrl: string, timeoutMs = 2_000): Promise<void> {
  // `globalThis.WebSocket` is available in Node 22+ (the version the repo
  // targets via vitest's "node" environment). Falling back to a require()
  // shim isn't needed for the supported runtime.
  await new Promise<void>((resolve, reject) => {
    const ws = new globalThis.WebSocket(rpcUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignored */ }
      reject(
        new Error(
          `Local chain not reachable at ${rpcUrl} within ${timeoutMs}ms.\n` +
            `Spin up PPN and deploy the contracts:\n` +
            `  cdm test            (auto-spawns PPN)\n` +
            `  # or, manually:\n` +
            `  revive-dev-node --dev\n` +
            `  cdm deploy --bootstrap --name local --suri //Alice`,
        ),
      );
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          `Local chain at ${rpcUrl} refused the WebSocket handshake. ` +
            `Confirm the node is running and the URL matches cdm.json's local target.`,
        ),
      );
    });
  });
}

function localRpcUrl(): string {
  return process.env.CONTRACT_RPC_URL ?? LOCAL_RPC_URL_DEFAULT;
}

export interface ContractHandles {
  runtime: ContractRuntime;
  registry: Contract<ContractDef>;
  registryAddress: HexString;
  /// Raw PAPI client. Exposed so write-path tests can drive
  /// `Revive.map_account()` for non-deployer signers (Bob / Charlie / Dave)
  /// before invoking contract methods through `runtime`.
  client: PolkadotClient;
  destroy: () => void;
}

let handlesPromise: Promise<ContractHandles> | null = null;

export function getHandles(): Promise<ContractHandles> {
  if (handlesPromise) return handlesPromise;

  handlesPromise = (async () => {
    const target = getChainTarget();

    const rpcUrl = target === "local" ? localRpcUrl() : assetHubRpc();

    // Fail fast on a missing local chain instead of hanging the suite. The
    // PAPI ws provider's own retry loop will keep dialing for tens of
    // seconds; a TCP-level probe with a 2s budget catches the "no PPN spun
    // up" case cleanly. Paseo connections skip the probe — public RPCs
    // sometimes have slow first-connect TLS handshakes that wouldn't survive
    // a tight timeout.
    if (target === "local") {
      await assertReachable(rpcUrl);
    }

    const client: PolkadotClient = createClient(getWsProvider(rpcUrl));

    // `defaultOrigin` matches the dev fallback the SDK would have used silently
    // — pinning it suppresses the per-query "using dev fallback (Alice) for
    // query dry-run" warning.
    const aliceSs58 = devAccount("Alice", "//Alice").ss58;

    // REGISTRY_ADDRESS override: target a specific instance directly (e.g. a
    // freshly instantiated contract whose on-chain registration is still
    // pending or stuck). Skips live-resolution entirely — the override exists
    // precisely because the on-chain registry lookup is unavailable, so running
    // `fromLiveClient` would waste a round-trip (or hang). ABI comes from the
    // cdm.json snapshot (same contract source ⇒ compatible).
    const overrideAddr = process.env.REGISTRY_ADDRESS as HexString | undefined;

    let runtime: ContractRuntime;
    let registry: Contract<ContractDef>;
    let address: HexString;

    if (overrideAddr) {
      runtime = createContractRuntimeFromClient(client, paseo_asset_hub);
      const abi = (cdmJson as unknown as CdmJson).contracts![REGISTRY_NAME].abi;
      registry = createContract(runtime, overrideAddr, abi, { defaultOrigin: aliceSs58 });
      address = overrideAddr;
    } else {
      // Live address resolution: the on-chain CDM meta-registry is queried at
      // handle-init for `REGISTRY_NAME`, so a fresh `cdm deploy` is picked up
      // without a follow-up `cdm i`. Mirrors `ContractManager.fromLiveClient`
      // in [src/utils/contracts.ts] and [scripts/smoke-test-points.ts]. ABIs
      // come from the installed cdm.json snapshot — run `cdm i -n paseo
      // @staging/playground-registry` after a contract change so the snapshot
      // matches the deployed binary.
      const manager = await ContractManager.fromLiveClient(
        cdmJson as unknown as CdmJson,
        client,
        paseo_asset_hub,
        {
          defaultOrigin: aliceSs58,
          registryOrigin: aliceSs58,
          libraries: [REGISTRY_NAME],
        },
      );
      runtime = manager.getRuntime();
      registry = manager.getContract(REGISTRY_NAME);
      address = manager.getAddress(REGISTRY_NAME);
    }

    // PAPI's runtime API calls default `at` to the latest FINALIZED block.
    // On a slow-finalizing local chain (PPN's default ~30s GRANDPA delay)
    // that means every `reg.X.query()` after a `waitFor: "best-block"`
    // tx reads pre-tx state — `getOwner` returns 0 immediately after a
    // successful publish, then a subsequent star() runs against a
    // non-existent `info[domain]` and traps. Override `dryRunCall` to
    // read at "best" so queries see the new state as soon as the tx is in
    // a best block. Production (paseo) keeps the default "finalized" —
    // public chains have real reorg risk and the latency is fine.
    if (target === "local") {
      const unsafe = client.getUnsafeApi();
      (runtime as { dryRunCall: unknown }).dryRunCall = (
        origin: unknown,
        dest: unknown,
        value: unknown,
        gas: unknown,
        deposit: unknown,
        data: unknown,
      ) =>
        (unsafe.apis as any).ReviveApi.call(
          origin,
          dest,
          value,
          gas,
          deposit,
          data,
          { at: "best" },
        );
    }

    return {
      runtime,
      registry,
      registryAddress: address,
      client,
      destroy: () => client.destroy(),
    };
  })();

  return handlesPromise;
}

export async function destroyHandles(): Promise<void> {
  if (!handlesPromise) return;
  const handles = await handlesPromise;
  handles.destroy();
  handlesPromise = null;
}

export function canWrite(): boolean {
  return getChainTarget() === "local" || isStaging();
}

/// Minimum free balance a voter account must hold to safely sign a handful
/// of registry mutations. Below this `ensureMapped` tops it up from the
/// publisher (the bare-root SURI account, mapped to the `Alice` slot).
/// The load test has voter accounts publishing apps too (storage deposit
/// ~1 PAS each) plus stars; a voter at LOAD_APPS=30 needs ~10-15 PAS for
/// its share of publishes + stars.
const STAGING_VOTER_MIN_BALANCE = 15_000_000_000_000n;
/// Small headroom added to the topped-up amount so the recipient's first
/// few tx fees don't dip it back below the floor mid-test.
const STAGING_VOTER_TOPUP_HEADROOM = 500_000_000_000n;

/// Top up `account` from the bare-root SURI account when running in
/// staging mode AND `account`'s current free balance is below the floor.
/// Issues a `Balances.transfer_keep_alive` and waits for inclusion. No-op
/// in local mode or when the account already has enough.
async function ensureFundedFromPublisher(account: DevAccount): Promise<void> {
  if (!isStaging()) return;
  const publisher = devAccount("Alice", "//Alice");
  if (account.ss58 === publisher.ss58) return;
  const { client } = await getHandles();
  const api = client.getTypedApi(paseo_asset_hub);
  const sysAcct = await api.query.System.Account.getValue(account.ss58);
  const free = sysAcct?.data.free ?? 0n;
  if (free >= STAGING_VOTER_MIN_BALANCE) return;
  // Transfer the deficit (+ headroom) rather than a fixed lump sum, so a
  // partially-funded voter from a prior run doesn't double-charge the
  // publisher, and the publisher's own balance lasts across all three
  // voter top-ups. The recipient ends at MIN_BALANCE + HEADROOM.
  const transferAmount =
    STAGING_VOTER_MIN_BALANCE - free + STAGING_VOTER_TOPUP_HEADROOM;
  process.stderr.write(
    `  [setup] topping up ${account.name} (${account.ss58.slice(0, 8)}...) — current free=${free}, transferring=${transferAmount}\n`,
  );
  const r = await api.tx.Balances.transfer_keep_alive({
    dest: { type: "Id" as const, value: account.ss58 },
    value: transferAmount,
  }).signAndSubmit(publisher.signer);
  if (!r.ok) {
    const publisherAcct = await api.query.System.Account.getValue(publisher.ss58);
    const publisherFree = publisherAcct?.data.free ?? 0n;
    throw new Error(
      `Funding ${account.name} from publisher failed: ${JSON.stringify(r.dispatchError)}. ` +
        `Publisher (${publisher.ss58.slice(0, 8)}...) free balance: ${publisherFree}, ` +
        `needed: ${transferAmount}. Top up the publisher SURI account on Paseo Next and retry.`,
    );
  }
}

/// Submit `Revive.map_account()` for `account` if it isn't already mapped.
/// `pallet-revive` requires every signer to be SS58↔H160 mapped before its
/// `Revive.call` extrinsics will accept the tx — unmapped signers' txs
/// silently return `ok: false`.
///
/// `cdm deploy --bootstrap --suri //Alice` maps Alice as a side-effect of
/// the deploy, but Bob / Charlie / Dave start unmapped. Write-path tests
/// that need distinct callers MUST call this for each signer in `beforeAll`
/// or every multi-signer assertion will fail with "expected 1, got 0".
///
/// Routes through the SDK's `ensureAccountMapped` rather than calling
/// PAPI's `signAndSubmit` directly — the SDK's submission pipeline owns
/// the nonce state used by later contract `.tx()` calls, so the map_account
/// tx and the test's first contract tx for the same signer stay
/// nonce-coherent. Bypassing the SDK desyncs the two views and the next
/// contract tx fails with `InvalidTxError: Stale`.
export async function ensureMapped(account: DevAccount): Promise<void> {
  // In staging mode, voter accounts are STAGING_SURI sub-derivations and
  // start unfunded — top them up before the SDK tries to submit the
  // `Revive.map_account` extrinsic, otherwise the tx is rejected with
  // `InvalidTransaction::Payment` before it can be included.
  await ensureFundedFromPublisher(account);

  const { client } = await getHandles();
  const api = client.getTypedApi(paseo_asset_hub);
  // Hand-roll the MappingChecker: query `Revive.OriginalAccount` directly,
  // ignoring the SS58 the SDK passes us — we already have the H160 from
  // `devAccount`. Saves a round-trip through `ss58ToH160`.
  const checker: MappingChecker = {
    addressIsMapped: async () => {
      const existing = await api.query.Revive.OriginalAccount.getValue(
        account.h160,
      );
      return existing !== undefined;
    },
  };
  await ensureAccountMapped(
    account.ss58,
    account.signer,
    checker,
    api as unknown as ReviveApi,
  );
}
