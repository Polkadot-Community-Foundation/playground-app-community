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

// Starter layouts. Each `build()` returns a fresh SiteContent with new block
// IDs so applying the same template twice yields distinct, editable instances.
//
// Invariant: templates are pure data. Everything they emit is a regular block
// the user could add from the + menu and style with the per-block toggles —
// nothing is locked, special-cased, or otherwise unbuildable by hand.

import { type SiteContent } from "./template.ts";

function id(): string {
    return Math.random().toString(36).slice(2, 10);
}

export interface Template {
    id: string;
    name: string;
    description: string;
    build: () => SiteContent;
}

export const TEMPLATES: readonly Template[] = [
    {
        id: "blank",
        name: "Blank",
        description: "Clean slate",
        build: () => ({
            accentColor: "#e6007a",
            background: "#0b0d12",
            fontFamily: "system-ui",
            blocks: [
                { id: id(), type: "heading", text: "Hello, world" },
                {
                    id: id(),
                    type: "paragraph",
                    text: "This is your page. Click anything to make it yours.",
                },
            ],
        }),
    },
    {
        id: "profile",
        name: "Profile",
        description: "A decentralised linktree: avatar, handle, links",
        // Bold bio-link poster: ink on hi-vis yellow, set big in Impact. Centered.
        build: () => ({
            accentColor: "#18181b",
            background: "#facc15",
            fontFamily: "Impact, sans-serif",
            align: "center",
            blocks: [
                {
                    id: id(),
                    type: "image",
                    variant: "small",
                    shape: "circle",
                    url: "https://",
                    alt: "Profile photo",
                },
                { id: id(), type: "heading", text: "@handle" },
                {
                    id: id(),
                    type: "paragraph",
                    text: "Builder, tinkerer, and full-time resident of the open web.",
                },
                // Prefilled to the profile-URL base — the user just appends
                // their username. "X" matches the platform's current name
                // (and what Linktree calls it).
                { id: id(), type: "link", variant: "pill", label: "X", url: "https://x.com/" },
                {
                    id: id(),
                    type: "link",
                    variant: "pill",
                    label: "GitHub",
                    url: "https://github.com/",
                },
                { id: id(), type: "link", variant: "pill", label: "Email me", url: "mailto:" },
            ],
        }),
    },
    {
        id: "post",
        name: "Blog post",
        // Seeded with the opening of Eric Hughes' 1993 "A Cypherpunk's
        // Manifesto" (widely republished) — a real, on-brand starting point
        // for our audience to overwrite, rather than lorem-ipsum prompts.
        description: "Title, date, paragraphs, and an image",
        // Plain-document mood for the seeded manifesto: black text on white,
        // monospaced — like a printed RFC / source listing.
        build: () => ({
            accentColor: "#22c55e",
            background: "#ffffff",
            textColor: "#000000",
            fontFamily: "'Courier New', monospace",
            blocks: [
                { id: id(), type: "heading", text: "A Cypherpunk's Manifesto" },
                { id: id(), type: "paragraph", text: "Eric Hughes · 9 March 1993" },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "Privacy is necessary for an open society in the electronic age. " +
                        "Privacy is not secrecy. A private matter is something one doesn't " +
                        "want the whole world to know, but a secret matter is something one " +
                        "doesn't want anybody to know. Privacy is the power to selectively " +
                        "reveal oneself to the world.",
                },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "We cannot expect governments, corporations, or other large, " +
                        "faceless organizations to grant us privacy out of their beneficence. " +
                        "We must defend our own privacy if we expect to have any.",
                },
                { id: id(), type: "divider" },
                {
                    id: id(),
                    type: "image",
                    url: "https://",
                    alt: "Manifesto",
                },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "Cypherpunks write code. We know that someone has to write software " +
                        "to defend privacy, and since we can't get privacy unless we all do, " +
                        "we're going to write it.",
                },
            ],
        }),
    },
    {
        id: "event",
        name: "Event",
        description: "Flyer-style: title, when / where, big RSVP",
        // Synthwave flyer mood: electric cyan on midnight indigo, set in clean
        // Helvetica. Centered.
        build: () => ({
            accentColor: "#22d3ee",
            background: "#1a1033",
            fontFamily: "Helvetica, Arial, sans-serif",
            align: "center",
            blocks: [
                { id: id(), type: "heading", text: "Builders Night" },
                {
                    id: id(),
                    type: "paragraph",
                    text: "Saturday · 7:00 PM · Berlin",
                },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "An evening for people who build on the open web. Short demos, " +
                        "cold drinks, and a room full of people shipping. Bring a laptop " +
                        "if you want to show something.",
                },
                {
                    id: id(),
                    type: "link",
                    variant: "pill",
                    label: "RSVP",
                    url: "mailto:",
                },
                {
                    id: id(),
                    type: "image",
                    variant: "medium",
                    url: "https://",
                    alt: "Event flyer image",
                },
            ],
        }),
    },
];
