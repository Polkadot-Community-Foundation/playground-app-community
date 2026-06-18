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

import { describe, it, expect, afterAll } from "vitest";
import {
  WRITE_TX_OPTS,
  canWrite,
  destroyHandles,
  devAccount,
  getHandles,
  type DevAccount,
} from "./setup";

const ZERO32 = `0x${"0".repeat(64)}`;
const RUN_HEX = Date.now().toString(16).padStart(16, "0").slice(-16);
const rootHex = (byte: string) => `0x${byte.repeat(24)}${RUN_HEX}` as `0x${string}`;

function txAs(account: DevAccount) {
  return { ...WRITE_TX_OPTS, signer: account.signer, origin: account.ss58 };
}

function normHex32(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();
  if (raw instanceof Uint8Array) return `0x${Buffer.from(raw).toString("hex")}`;
  const asHex = (raw as { asHex?: () => string } | null)?.asHex;
  if (typeof asHex === "function") return asHex.call(raw).toLowerCase();
  throw new Error(`unsupported bytes32 value: ${String(raw)}`);
}

async function txOk(label: string, promise: Promise<unknown>): Promise<void> {
  const result = (await promise) as {
    ok?: boolean;
    txHash?: string;
    dispatchError?: unknown;
  };
  if (result?.ok === true) return;
  throw new Error(
    `${label} returned ok=${String(result?.ok)} (hash=${result?.txHash ?? "n/a"})`,
  );
}

afterAll(async () => {
  await destroyHandles();
});

describe("registry identity bindings - write paths (local dev-node only)", () => {
  it.skipIf(!canWrite())("enforces one product account per root identity", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;
    const alice = devAccount("Alice", "//Alice");
    const bob = devAccount("Bob", "//Bob");
    const charlie = devAccount("Charlie", "//Charlie");
    const dave = devAccount("Dave", "//Dave");
    const rootA = rootHex("11");
    const rootB = rootHex("22");

    for (const account of [bob, charlie, dave]) {
      await txOk(
        `clear ${account.name}`,
        reg.adminClearIdentity.tx(account.h160, txAs(alice)),
      );
    }

    await txOk("bind Bob to rootA", reg.adminSetIdentity.tx(bob.h160, rootA, txAs(alice)));
    expect(normHex32((await reg.getRootAccount.query(bob.h160)).value)).toBe(rootA);

    await expect(
      reg.adminSetIdentity.tx(charlie.h160, rootA, txAs(alice)),
    ).rejects.toThrow();
    expect(normHex32((await reg.getRootAccount.query(charlie.h160)).value)).toBe(ZERO32);

    await txOk(
      "idempotently re-bind Bob to rootA",
      reg.adminSetIdentity.tx(bob.h160, rootA, txAs(alice)),
    );
    await txOk("move Bob to rootB", reg.adminSetIdentity.tx(bob.h160, rootB, txAs(alice)));
    expect(normHex32((await reg.getRootAccount.query(bob.h160)).value)).toBe(rootB);

    await txOk(
      "bind Charlie to Bob's freed rootA",
      reg.adminSetIdentity.tx(charlie.h160, rootA, txAs(alice)),
    );
    expect(normHex32((await reg.getRootAccount.query(charlie.h160)).value)).toBe(rootA);

    await expect(
      reg.adminSetIdentity.tx(dave.h160, rootA, txAs(alice)),
    ).rejects.toThrow();

    await txOk(
      "clear Charlie rootA",
      reg.adminClearIdentity.tx(charlie.h160, txAs(alice)),
    );
    expect(normHex32((await reg.getRootAccount.query(charlie.h160)).value)).toBe(ZERO32);

    await txOk(
      "bind Dave to cleared rootA",
      reg.adminSetIdentity.tx(dave.h160, rootA, txAs(alice)),
    );
    expect(normHex32((await reg.getRootAccount.query(dave.h160)).value)).toBe(rootA);
  });
});
