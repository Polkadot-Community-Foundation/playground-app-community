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

/** Soft cap on the derived blurb length before truncating with an ellipsis.
 *  Sized to roughly fill the card's 3-line clamp; CSS does the visual cut. */
const MAX_BLURB_LEN = 300;

/** A line that is only a markdown image / link / shield badge — not prose. */
function isBadgeOrImageLine(line: string): boolean {
  // ![alt](url) image, [![..](..)](..) linked badge, or a bare <img>/<a> tag.
  return (
    /^!\[.*?\]\(.*?\)\s*$/.test(line) ||
    /^\[!\[.*?\]\(.*?\)\]\(.*?\)\s*$/.test(line) ||
    /^<(img|a|p)\b/i.test(line) ||
    // A line made up only of links / images / shields, possibly several.
    (/\]\(/.test(line) && line.replace(/!?\[.*?\]\(.*?\)/g, "").trim() === "")
  );
}

/** Strip the inline markdown that would otherwise leak into a plain blurb. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[.*?\]\(.*?\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/[*_`~]+/g, "") // emphasis / code marks
    .replace(/\s+/g, " ")
    .trim();
}

/** A line that marks the end of the opening prose (a new structural block). */
function isStructuralBreak(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) || // heading
    /^(-{3,}|\*{3,}|_{3,})$/.test(line) || // horizontal rule
    /^```/.test(line) || // code fence
    /^>\s?/.test(line) || // blockquote
    /^(\s*[-*+]\s+|\s*\d+\.\s+)/.test(line) // list item
  );
}

/**
 * Derive a multi-line blurb from a README, used as the App Card description
 * when the app has no explicit `metadata.description`. Skips the bits that
 * aren't description prose: a leading H1/title, a "readme" heading, blank
 * lines, and badge/image-only lines. Collects the opening prose (across soft
 * wraps and paragraph breaks) up to ~3 lines' worth, word-boundary truncated
 * with an ellipsis. Returns `undefined` when there's nothing usable. The card
 * additionally clamps this to 3 lines in CSS.
 */
export function readmeBlurb(readme?: string): string | undefined {
  if (!readme) return undefined;

  const lines = readme.replace(/\r\n/g, "\n").split("\n");
  const collected: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();

    if (collected.length === 0) {
      // Pre-prose: skip blanks, headings, rules, comments, and badges until
      // the first real sentence.
      if (line === "") continue;
      if (isStructuralBreak(line) || line.startsWith("<!--")) continue;
      if (isBadgeOrImageLine(line)) continue;
    } else {
      // In-prose: a structural block or a badge/image ends the blurb. A blank
      // line is a soft paragraph break — keep going to fill the lines.
      if (line === "") continue;
      if (isStructuralBreak(line) || line.startsWith("<!--")) break;
      if (isBadgeOrImageLine(line)) break;
    }

    const text = stripInlineMarkdown(line);
    if (text === "") continue;
    collected.push(text);
    if (collected.join(" ").length >= MAX_BLURB_LEN) break;
  }

  if (collected.length === 0) return undefined;

  const blurb = collected.join(" ");
  if (blurb.length <= MAX_BLURB_LEN) return blurb;
  // Truncate on a word boundary where possible.
  const clipped = blurb.slice(0, MAX_BLURB_LEN);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
