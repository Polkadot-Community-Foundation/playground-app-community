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

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  WRITE_TX_OPTS,
  canWrite,
  destroyHandles,
  devAccount,
  ensureMapped,
  getHandles,
  type DevAccount,
} from "./setup";

let alice: DevAccount;
let bob: DevAccount;
let charlie: DevAccount;

function txAs(account: DevAccount) {
  return { ...WRITE_TX_OPTS, signer: account.signer, origin: account.ss58 };
}

async function txOk(label: string, promise: Promise<unknown>): Promise<void> {
  const result = (await promise) as {
    ok?: boolean;
    txHash?: string;
    dispatchError?: unknown;
  };
  if (result?.ok === true) return;
  const dispatch = result?.dispatchError
    ? ` dispatchError=${JSON.stringify(
        result.dispatchError,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      )}`
    : "";
  throw new Error(
    `${label} returned ok=${String(result?.ok)} (hash=${result?.txHash ?? "n/a"})${dispatch}`,
  );
}

beforeAll(async () => {
  alice = devAccount("Alice", "//Alice");
  bob = devAccount("Bob", "//Bob");
  charlie = devAccount("Charlie", "//Charlie");

  if (canWrite()) {
    await ensureMapped(bob);
  }
}, 60_000);

afterAll(async () => {
  await destroyHandles();
});

describe("registry admin management - write paths (local dev-node only)", () => {
  it.skipIf(!canWrite())("admins can grant admin to other accounts", async () => {
    const { registry } = await getHandles();
    const reg = registry as any;

    await txOk("sudo removes Bob admin", reg.removeAdmin.tx(bob.h160, txAs(alice)));
    await txOk("sudo removes Charlie admin", reg.removeAdmin.tx(charlie.h160, txAs(alice)));
    expect((await reg.isAdmin.query(bob.h160)).value).toBe(false);
    expect((await reg.isAdmin.query(charlie.h160)).value).toBe(false);

    await expect(reg.addAdmin.tx(charlie.h160, txAs(bob))).rejects.toThrow();
    expect((await reg.isAdmin.query(charlie.h160)).value).toBe(false);

    await txOk("sudo grants Bob admin", reg.addAdmin.tx(bob.h160, txAs(alice)));
    expect((await reg.isAdmin.query(bob.h160)).value).toBe(true);

    await txOk("Bob grants Charlie admin", reg.addAdmin.tx(charlie.h160, txAs(bob)));
    expect((await reg.isAdmin.query(charlie.h160)).value).toBe(true);
  });
});
