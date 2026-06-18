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

// Compact MyApps surface for the Polkadot Desktop *Widget* modality
// (Triangle four-modality model: SPA / Widget / Pocket / Chat — see
// "Product Manifest Proposal.md"). Today Polkadot Desktop synthesises
// the widget entrypoint as the bare domain, so we mount this via a
// /widget path branch in main.tsx as an interim hookup; in the manifest
// world the widget will be a separately-deployed executable referenced
// from `Topology::Widget(Vec<DotNSIdentifier>)` (likely a subdomain
// like `myapps-widget.playground.dot`).
//
// Runs without the SPA shell (LeftRail, publish modal, full grid).
// Refreshes live on registry events so a publish in the SPA propagates
// into the widget tile.

import { useEffect, useState } from "react";

import {
  registryReady,
  getBulletinClient,
  useSignerState,
  useIconUrl,
  cardColorForDomain,
} from "./utils";
import PointsBreakdown from "./PointsBreakdown";
import { withReadDeadline } from "./utils/deadline.ts";
import { displayNameForAccount } from "./utils/username";
import { useRootUsername } from "./utils/identity";
import { fetchAppDataBatch } from "./registryAppData.ts";
import { PLAYGROUND_URL } from "./config";
import type { AppEntry } from "./registryTypes";
import { type AppMetadata } from "./App";
import { subscribeToRegistryEvents } from "./utils/event-stream/registryEventSubscription.ts";

const MAX_ITEMS = 6;

type WidgetEntry = AppEntry & { metadata?: AppMetadata };

async function fetchOwnerEntries(
  address: `0x${string}`,
): Promise<{ total: number; entries: WidgetEntry[] }> {
  const registry = await registryReady;
  const countRes = await withReadDeadline(
    registry.getOwnerAppCount.query(address),
    "Registry owner app count",
  );
  const total = countRes.success ? Number(countRes.value) : 0;
  if (total === 0) return { total: 0, entries: [] };

  // Concurrent slot reads for the owner's newest domains; app metadata URIs are
  // resolved below in one getAppData batch. Each slot catches → a single wedged
  // read drops just that tile instead of leaving the widget pending forever.
  const indexes = Array.from(
    { length: Math.min(MAX_ITEMS, total) },
    (_, k) => total - 1 - k,
  );
  const slots = await Promise.all(
    indexes.map(async (i): Promise<{ index: number; domain: string } | null> => {
      try {
        const dRes = await withReadDeadline(
          registry.getOwnerDomainAt.query(address, i),
          "Registry owner domain",
        );
        if (!dRes.success || !dRes.value?.isSome) return null;
        return { index: i, domain: dRes.value.value };
      } catch {
        return null;
      }
    }),
  );
  const domainRows = slots.filter((s): s is { index: number; domain: string } => s !== null);
  const appData = await fetchAppDataBatch(domainRows.map(row => row.domain));
  const entries = domainRows.flatMap((row): WidgetEntry[] => {
    const data = appData?.get(row.domain);
    if (!data?.metadataUri) return [];
    return [{
      index: row.index,
      domain: row.domain,
      metadataUri: data.metadataUri,
      owner: data.owner ?? address,
      visibility: data.visibility,
      publisher: data.publisher,
    }];
  });

  // Best-effort metadata hydration; placeholders if the host isn't a Polkadot
  // container (same degrade path as the SPA grid).
  await Promise.allSettled(
    entries.map(async (e) => {
      if (!e.metadataUri) return;
      try {
        const client = await getBulletinClient();
        e.metadata = await withReadDeadline(
          client.fetchJson<AppMetadata>(e.metadataUri),
          "Bulletin metadata fetch",
        );
      } catch {
        /* leave undefined — WidgetRow falls back to a per-app colour block */
      }
    }),
  );

  return { total, entries };
}

export default function MyAppsWidget() {
  const signer = useSignerState();
  const account = signer.selectedAccount;
  const address = account?.h160Address as `0x${string}` | undefined;
  const { username } = useRootUsername(address);

  const [entries, setEntries] = useState<WidgetEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!address) {
      setEntries([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { total, entries } = await fetchOwnerEntries(address);
        if (cancelled) return;
        setTotal(total);
        setEntries(entries);
      } catch (err) {
        // A wedged read now rejects (deadline) instead of hanging — log and
        // leave the last-known list; the live-event effect re-pulls on the next
        // registry event and an account switch re-runs this.
        if (!cancelled) console.warn("[playground] MyAppsWidget load failed —", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  // Live updates. Bump refreshKey on every registry event — PointsBreakdown
  // re-reads XP and the list re-pulls. Not filtered by owner here: refetch
  // is bounded by MAX_ITEMS slot reads, and a per-event owner lookup would
  // cost more than it saves.
  useEffect(() => {
    return subscribeToRegistryEvents(() => setRefreshKey((k) => k + 1));
  }, []);

  if (!address) {
    return (
      <div className="widget-root" data-testid="my-apps-widget-disconnected">
        <div className="widget-empty">
          <p>Connect your account in playground.dot to see your apps.</p>
          <a className="widget-cta" href={PLAYGROUND_URL} target="_blank" rel="noreferrer">
            Open playground.dot →
          </a>
        </div>
      </div>
    );
  }

  const headerLabel = displayNameForAccount(username, address);
  const showLoading = loading && entries.length === 0;
  const showEmpty = !loading && entries.length === 0;

  return (
    <div className="widget-root" data-testid="my-apps-widget">
      <header className="widget-header">
        <span className="widget-eyebrow">My Apps</span>
        <span className="widget-account" data-testid="widget-account">{headerLabel}</span>
      </header>
      <PointsBreakdown account={address} refreshKey={refreshKey} compact />
      {showLoading && <div className="widget-loading">Loading…</div>}
      {showEmpty && (
        <div className="widget-empty">
          <p>No apps yet. Publish one with the dot CLI to see it here.</p>
        </div>
      )}
      {entries.length > 0 && (
        <ul className="widget-list" data-testid="widget-app-list">
          {entries.map((e) => (
            <WidgetRow key={e.domain} entry={e} />
          ))}
        </ul>
      )}
      {total > entries.length && (
        <a
          className="widget-cta"
          href={`${PLAYGROUND_URL}/profile`}
          target="_blank"
          rel="noreferrer"
        >
          View all {total} →
        </a>
      )}
    </div>
  );
}

function WidgetRow({ entry }: { entry: WidgetEntry }) {
  const iconUrl = useIconUrl(entry.metadata?.icon_cid);
  const href = `${PLAYGROUND_URL}/apps?app=${encodeURIComponent(entry.domain)}`;
  return (
    <li className="widget-row" data-testid={`widget-row-${entry.domain}`}>
      <a className="widget-row-link" href={href} target="_blank" rel="noreferrer">
        {iconUrl ? (
          <img
            className="widget-row-icon"
            src={iconUrl}
            alt=""
            width={32}
            height={32}
          />
        ) : (
          <span
            className="widget-row-icon"
            style={{ background: cardColorForDomain(entry.domain) }}
            aria-hidden="true"
          />
        )}
        <div className="widget-row-text">
          <span className="widget-row-name">
            {entry.metadata?.name ?? entry.domain}
          </span>
          <span className="widget-row-domain">{entry.domain}</span>
        </div>
      </a>
    </li>
  );
}
