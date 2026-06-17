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

// Multi-draft storage. The invariant these tests protect: a user's existing
// drafts are NEVER lost implicitly — not by starting a new draft (distinct
// slots), not by one corrupt sibling record (per-record validation).

import { beforeEach, describe, expect, it } from "vitest";
import { deleteDraft, loadDrafts, saveDraft, type Draft } from "./draft.ts";

const DRAFTS_KEY = "site-builder.drafts.v1";

function makeDraft(heading: string): Draft {
    return {
        mode: "blocks",
        content: {
            accentColor: "#e6007a",
            background: "#0b0d12",
            fontFamily: "system-ui",
            blocks: [{ id: "b1", type: "heading", text: heading }],
        },
        markdownText: "",
        htmlText: "",
        cssText: "",
        jsText: "",
    };
}

beforeEach(() => {
    localStorage.clear();
});

describe("multi-draft storage", () => {
    it("keeps drafts in distinct slots — saving one never clobbers another", () => {
        saveDraft("a", makeDraft("first"));
        saveDraft("b", makeDraft("second"));
        saveDraft("a", makeDraft("first, edited"));

        const drafts = loadDrafts();

        expect(drafts).toHaveLength(2);
        const byId = Object.fromEntries(drafts.map((r) => [r.id, r]));
        expect(byId.a.draft.content.blocks[0]).toMatchObject({ text: "first, edited" });
        expect(byId.b.draft.content.blocks[0]).toMatchObject({ text: "second" });
    });

    it("orders drafts newest-first so the landing resumes the latest session", () => {
        saveDraft("old", makeDraft("older"));
        // updatedAt has ms resolution; force distinct stamps without sleeping.
        const records = JSON.parse(localStorage.getItem(DRAFTS_KEY)!);
        records[0].updatedAt -= 60_000;
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(records));
        saveDraft("new", makeDraft("newer"));

        expect(loadDrafts().map((r) => r.id)).toEqual(["new", "old"]);
    });

    it("deletes only the requested draft", () => {
        saveDraft("a", makeDraft("keep"));
        saveDraft("b", makeDraft("drop"));

        deleteDraft("b");

        const drafts = loadDrafts();
        expect(drafts.map((r) => r.id)).toEqual(["a"]);
    });

    it("drops a corrupt record without losing its valid siblings", () => {
        saveDraft("good", makeDraft("intact"));
        const records = JSON.parse(localStorage.getItem(DRAFTS_KEY)!);
        records.push({ id: "bad", updatedAt: 1, draft: { mode: "nonsense" } });
        records.push("not even an object");
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(records));

        const drafts = loadDrafts();

        expect(drafts.map((r) => r.id)).toEqual(["good"]);
    });
});
