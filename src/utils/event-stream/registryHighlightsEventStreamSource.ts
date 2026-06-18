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

import { getBulletinClient } from "../bulletin";
import { registryReady } from "../contracts";
import { withReadDeadline } from "../deadline.ts";
import { displayNameForAccount } from "../username";
import { resolveRootUsernames } from "../identity";
import type {
  EventStreamEntity,
  EventStreamInput,
  EventStreamSource,
} from "./eventStream";

export const REGISTRY_HIGHLIGHTS_EVENT_STREAM_SOURCE_ID = "registry-highlights";

const RECENT_APP_WINDOW = 10;
const REFRESH_EVERY_MS = 60_000;
const ZERO_H160 = `0x${"0".repeat(40)}`;

interface TopBuilderRow {
  account: `0x${string}`;
  score: bigint;
}

interface AppRow {
  index: number;
  domain: string;
  metadata_uri: string;
  owner: `0x${string}`;
  publisher: `0x${string}`;
}

interface AppsPage {
  entries: AppRow[];
}

interface AppMetadata {
  name?: string;
}

function accountOrNull(account: string | undefined): `0x${string}` | null {
  if (!account) return null;
  return account.toLowerCase() === ZERO_H160 ? null : account as `0x${string}`;
}

function accountEntity(account: `0x${string}` | null, label?: string): EventStreamEntity[] {
  return account ? [{ type: "account", id: account, label: label ?? displayNameForAccount(null, account) }] : [];
}

function domainEntity(domain: string | undefined, label = domain): EventStreamEntity[] {
  return domain ? [{ type: "domain", id: domain, label }] : [];
}

function routeEntity(path: string, label: string): EventStreamEntity[] {
  return [{ type: "route", id: path, label }];
}

function displayName(account: `0x${string}`, usernames: ReadonlyMap<string, string | null>): string {
  return displayNameForAccount(usernames.get(account.toLowerCase()), account);
}

async function readAppName(row: AppRow): Promise<string> {
  try {
    const client = await getBulletinClient();
    const metadata = await withReadDeadline(
      client.fetchJson<AppMetadata>(row.metadata_uri),
      "Bulletin metadata fetch",
    );
    return metadata.name?.trim() || row.domain;
  } catch {
    return row.domain;
  }
}

async function readRegistryHighlights(): Promise<EventStreamInput[]> {
  const registry = await registryReady;
  const [topRes, appsRes, appCountRes] = await withReadDeadline(
    Promise.all([
      registry.getTopBuilders.query(0, 1),
      registry.getApps.query(0, RECENT_APP_WINDOW),
      registry.getAppCount.query(),
    ]),
    "Registry highlights",
  );

  const topBuilder = topRes.success ? (topRes.value as TopBuilderRow[])[0] : undefined;
  const appRows = appsRes.success ? ((appsRes.value as AppsPage).entries ?? []) : [];
  const accounts = [
    accountOrNull(topBuilder?.account),
    ...appRows.map((row) => accountOrNull(row.owner) ?? accountOrNull(row.publisher)),
  ].filter((account): account is `0x${string}` => !!account);
  const usernames = await resolveRootUsernames(accounts);
  const items: EventStreamInput[] = [];

  if (topBuilder) {
    const account = accountOrNull(topBuilder.account);
    if (account) {
      const score = BigInt(topBuilder.score);
      const name = displayName(account, usernames);
      items.push({
        id: `registry-highlight:leader:${account}:${score.toString()}`,
        source: REGISTRY_HIGHLIGHTS_EVENT_STREAM_SOURCE_ID,
        sourceLabel: "Registry highlights",
        kind: "registry-highlight.current-leader",
        category: "leaderboard",
        tone: "positive",
        title: `${name} leads the leaderboard with ${score.toString()} XP`,
        entities: [...accountEntity(account, name), ...routeEntity("/leaderboard", "leaderboard")],
        payload: { account, score: score.toString() },
      });
    }
  }

  const recentPublishItems = await Promise.all(appRows.map(async (row): Promise<EventStreamInput | null> => {
    const account = accountOrNull(row.owner) ?? accountOrNull(row.publisher);
    if (!account) return null;

    const name = displayName(account, usernames);
    const appName = await readAppName(row);
    return {
      id: `registry-highlight:recent-publish:${row.domain}:${account}`,
      source: REGISTRY_HIGHLIGHTS_EVENT_STREAM_SOURCE_ID,
      sourceLabel: "Registry highlights",
      kind: "registry-highlight.recent-publish",
      category: "app",
      tone: "positive",
      title: `${name} published ${appName}`,
      detail: appName === row.domain ? undefined : row.domain,
      entities: [...accountEntity(account, name), ...domainEntity(row.domain, appName)],
      payload: {
        domain: row.domain,
        appName,
        owner: row.owner,
        publisher: row.publisher,
        index: row.index,
      },
    };
  }));
  items.push(...recentPublishItems.filter((item): item is EventStreamInput => !!item));

  if (appCountRes.success) {
    const count = Number(appCountRes.value);
    items.push({
      id: `registry-highlight:app-count:${count}`,
      source: REGISTRY_HIGHLIGHTS_EVENT_STREAM_SOURCE_ID,
      sourceLabel: "Registry highlights",
      kind: "registry-highlight.app-count",
      category: "app",
      tone: "neutral",
      title: `${count.toLocaleString()} app${count === 1 ? "" : "s"} published`,
      entities: [],
      payload: { count },
    });
  }

  return items;
}

export function createRegistryHighlightsEventStreamSource(): EventStreamSource {
  return {
    id: REGISTRY_HIGHLIGHTS_EVENT_STREAM_SOURCE_ID,
    label: "Registry highlights",
    connect({ emit, error }) {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const emittedIds = new Set<string>();

      const refresh = async () => {
        try {
          const items = await readRegistryHighlights();
          if (cancelled) return;
          for (const item of items) {
            const id = item.id ?? `${item.kind}:${item.title}`;
            if (emittedIds.has(id)) continue;
            emittedIds.add(id);
            emit(item);
          }
        } catch (err) {
          if (!cancelled) error(err, "failed to refresh registry highlights");
        }
      };

      const schedule = () => {
        timer = setTimeout(() => {
          void refresh().finally(() => {
            if (!cancelled) schedule();
          });
        }, REFRESH_EVERY_MS);
      };

      void refresh().finally(() => {
        if (!cancelled) schedule();
      });

      return () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };
    },
  };
}
