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

// The site model + the renderer. `renderHtml(content)` returns a complete,
// self-contained HTML document — inline CSS, no external assets, no JS — so
// the result is a single byte blob we can hash and store in one
// TransactionStorage.store call.

/** Image sizes — always rendered centered. small=160px, medium=512px, large=full width. */
export type ImageVariant = "small" | "medium" | "large";
/** Corner treatment. "circle" also crops to a 1:1 square. */
export type ImageShape = "circle" | "rounded" | "square";
export type LinkVariant = "default" | "pill";
export type TextAlign = "left" | "center";

// Every block is a regular, user-creatable component: anything a template
// emits can be built by hand from a blank page, and edited or removed after.
// The page title/description are heading/paragraph blocks like everything
// else — there is no fixed header.
export type Block =
    | { id: string; type: "heading"; text: string }
    | { id: string; type: "paragraph"; text: string }
    | {
          id: string;
          type: "link";
          label: string;
          url: string;
          variant?: LinkVariant;
      }
    | {
          id: string;
          type: "image";
          url: string;
          alt: string;
          variant?: ImageVariant;
          shape?: ImageShape;
      }
    | { id: string; type: "divider" };

export interface SiteContent {
    accentColor: string;
    background: string;
    fontFamily: string;
    /** Base body font size. Unset = 16px. */
    fontSize?: string;
    /** Body text color. Unset = auto-picked for WCAG contrast against the background. */
    textColor?: string;
    /** Page text alignment. Unset = left. */
    align?: TextAlign;
    blocks: Block[];
}

// Normalize an image block's size, mapping legacy variants ("avatar" → small,
// "default"/unset → large) so old drafts keep rendering.
export function imageSize(variant?: string): ImageVariant {
    if (variant === "small" || variant === "avatar") return "small";
    if (variant === "medium") return "medium";
    return "large";
}

// Shape with legacy default: small images used to be circles (pfp), so an
// unset shape on a small image stays a circle; everything else is rounded.
export function imageShape(block: { variant?: string; shape?: ImageShape }): ImageShape {
    if (block.shape) return block.shape;
    return imageSize(block.variant) === "small" ? "circle" : "rounded";
}

export const DEFAULT_CONTENT: SiteContent = {
    accentColor: "#e6007a",
    background: "#0b0d12",
    fontFamily: "system-ui",
    blocks: [
        { id: "default-heading", type: "heading", text: "Hello, world" },
        {
            id: "default-paragraph",
            type: "paragraph",
            text: "This is your page. Click anything to make it yours.",
        },
    ],
};

export const DEFAULT_FONT_SIZE = "16px";

export const FONT_OPTIONS = [
    { value: "system-ui", label: "System" },
    { value: "Helvetica, Arial, sans-serif", label: "Helvetica" },
    { value: "Georgia, serif", label: "Serif" },
    { value: "'Courier New', monospace", label: "Mono" },
    { value: "'Comic Sans MS', cursive", label: "Comic Sans" },
    { value: "Impact, sans-serif", label: "Impact" },
] as const;

export const escapeHtml = (s: string): string =>
    s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

// Pick a body text color that meets WCAG contrast against the background.
// 0.179 is the standard sRGB relative-luminance crossover where black vs.
// white text trade contrast dominance. If the user typed a non-hex value
// (e.g. a CSS keyword the picker doesn't produce), default to dark-mode.
export function isLightBackground(bg: string): boolean {
    const m = bg.replace("#", "").match(/^[0-9a-f]{6}$/i) ? bg.replace("#", "") : null;
    if (!m) return false;
    const parts = m.match(/.{2}/g);
    if (!parts) return false;
    const [r, g, b] = parts.map((h) => parseInt(h, 16) / 255);
    const lin = (c: number) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return lum >= 0.179;
}

export interface SiteColors {
    foreground: string;
    divider: string;
    colorScheme: "dark" | "light";
}

export function siteColors(background: string): SiteColors {
    const light = isLightBackground(background);
    return {
        foreground: light ? "#0b0d12" : "#f5f5f5",
        divider: light ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.15)",
        colorScheme: light ? "light" : "dark",
    };
}

// URL-allowlist guard so an image/link block can't smuggle a javascript: URL
// into the produced page. http(s), mailto/tel, and relative paths only —
// the templates themselves ship "Email me" mailto: links, so those must
// survive the render (they used to fall through to "#").
/**
 * Allowlist validation only — returns the RAW url (or "#" when rejected).
 * Use this from React (which escapes attributes itself); use safeUrl when
 * interpolating into an HTML string.
 */
export function validateUrl(raw: string): string {
    const v = raw.trim();
    if (!v) return "#";
    if (/^https?:\/\//i.test(v)) return v;
    if (/^(mailto|tel):/i.test(v)) return v;
    if (v.startsWith("/") || v.startsWith("./") || v.startsWith("#")) return v;
    return "#";
}

function safeUrl(raw: string): string {
    return escapeHtml(validateUrl(raw));
}

// Images additionally accept data:image/* — safe in an <img> src and in the
// spirit of self-contained pages. Links stay http(s)-only (data: hrefs are a
// phishing vector).
function safeImageUrl(raw: string): string {
    const v = raw.trim();
    if (/^data:image\//i.test(v)) return escapeHtml(v);
    return safeUrl(v);
}

function renderBlock(block: Block): string {
    switch (block.type) {
        case "heading":
            return `<h1>${escapeHtml(block.text)}</h1>`;
        case "paragraph":
            return `<p>${escapeHtml(block.text)}</p>`;
        case "link": {
            const wrap = block.variant === "pill" ? ' class="pill"' : "";
            const href = safeUrl(block.url);
            // mailto links: no target=_blank (it's a mail client, not a tab),
            // and Cloudflare's documented email_off opt-out — CF-fronted IPFS
            // gateways otherwise rewrite the href to /cdn-cgi/l/email-protection
            // whose decoder script 404s on the displaying origin, leaving a
            // dead link.
            if (/^mailto:/i.test(href)) {
                return `<p${wrap}><!--email_off--><a href="${href}">${escapeHtml(block.label)}</a><!--/email_off--></p>`;
            }
            // No target="_blank": dead taps inside Polkadot hosts (neither
            // mobile WebView wires window-opening) — same rationale as the
            // attribution footer in wrapMain below.
            return `<p${wrap}><a href="${href}" rel="noopener">${escapeHtml(block.label)}</a></p>`;
        }
        case "image": {
            const size = imageSize(block.variant);
            const shape = imageShape(block);
            const classes = [
                ...(size !== "large" ? [`img-${size}`] : []),
                ...(shape !== "rounded" ? [`img-${shape}`] : []),
            ];
            // No real URL yet: a broken <img> renders as bare alt text. Emit
            // a tinted shape in the image's size/shape instead so previews
            // (and a deployed draft) read as intentional, not broken.
            if (isPlaceholderImageUrl(block.url)) {
                const label = escapeHtml(block.alt || "Image");
                const cls = ["img-placeholder", ...classes].join(" ");
                return `<div class="${cls}" role="img" aria-label="${label}">${label}</div>`;
            }
            const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
            return `<img${cls} src="${safeImageUrl(block.url)}" alt="${escapeHtml(block.alt)}">`;
        }
        case "divider":
            return `<hr>`;
    }
}

// The theme inputs the document shell needs — a subset of SiteContent so the
// markdown renderer can reuse the shell without a full block model.
export interface PageTheme {
    accentColor: string;
    background: string;
    fontFamily: string;
    fontSize?: string;
    textColor?: string;
    align?: TextAlign;
}

// Optional CSS chunks, keyed by feature. Only the chunks a page actually uses
// are emitted — keeps layout-specific rules from bleeding into the document
// handed to the raw-HTML editor, and trims bytes off the deploy artifact.
export type ShellFeature =
    | "markdown"
    | "img-small"
    | "img-medium"
    | "img-circle"
    | "img-square"
    | "img-placeholder"
    | "pill";

// "No image picked yet" sentinel — templates and the + menu prefill image
// blocks with "https://" so the URL field starts as a useful stub. The
// editor's blocks view and the artifact renderer share this predicate.
export function isPlaceholderImageUrl(url: string): boolean {
    return !url || url === "https://";
}

// Auto-derive registry metadata from the deployed HTML — the same rendered
// output `titleFromHtml` reads, so it works across blocks / markdown / html
// builder modes. Used by the "List in Apps" panel to prefill a description and
// pick an icon without asking the user. Pure (no DOM) so vitest can import them.

function decodeBasicEntities(s: string): string {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
}

/** Bulletin CID of the first real `<img>` on the page, or undefined when there
 *  is none. Image URLs are stored as `${BULLETIN_GATEWAY}${cid}` (config.ts),
 *  so the CID is the segment after `/ipfs/`. */
export function firstImageCidFromHtml(html: string): string | undefined {
    const url = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
    if (!url || isPlaceholderImageUrl(url)) return undefined;
    const cid = url.split("/ipfs/")[1]?.split(/[/?#]/)[0]?.trim();
    return cid || undefined;
}

/** First paragraph's text — tags stripped, entities decoded, whitespace
 *  collapsed, truncated to `maxLen` with an ellipsis. "" when no paragraph. */
export function descriptionFromHtml(html: string, maxLen = 160): string {
    const m = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (!m) return "";
    const text = decodeBasicEntities(m[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1).trimEnd() + "…";
}

interface FeatureCssContext {
    accent: string;
    accentContrast: string;
    divider: string;
}

const FEATURE_CSS: Record<ShellFeature, (ctx: FeatureCssContext) => string> = {
    // GitHub-flavored markdown: foreground headings with a bottom rule (the
    // accent stays a link color, as on GitHub), bordered tables with zebra
    // rows, muted blockquotes, rounded grey code. Borders/fills use `divider`
    // (light/dark-aware) and muted tones derive from `currentColor` via
    // color-mix, so the whole sheet adapts to whatever background is chosen.
    markdown: ({ divider }) => `h1, h2, h3, h4, h5, h6 { color: inherit; line-height: 1.25; font-weight: 600; margin: 24px 0 16px; letter-spacing: -0.01em; }
h1 { font-size: 1.9em; padding-bottom: 0.3em; border-bottom: 1px solid ${divider}; }
h2 { font-size: 1.4em; padding-bottom: 0.3em; border-bottom: 1px solid ${divider}; }
h3 { font-size: 1.2em; }
h4 { font-size: 1em; }
h5 { font-size: 0.9em; }
h6 { font-size: 0.85em; color: color-mix(in srgb, currentColor, transparent 35%); }
ul, ol { margin: 0 0 16px; padding-left: 2em; }
li { margin: 4px 0; }
li > ul, li > ol { margin: 4px 0; }
blockquote { margin: 0 0 16px; padding: 0 1em; border-left: 0.25em solid ${divider}; color: color-mix(in srgb, currentColor, transparent 35%); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: ${divider}; padding: 0.2em 0.4em; border-radius: 6px; }
pre { margin: 0 0 16px; padding: 16px; background: ${divider}; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; font-size: 0.85em; }
table { border-collapse: collapse; margin: 0 0 16px; display: block; width: max-content; max-width: 100%; overflow: auto; }
th, td { padding: 6px 13px; border: 1px solid ${divider}; }
th { font-weight: 600; }
tr:nth-child(2n) { background: color-mix(in srgb, currentColor, transparent 94%); }
hr { height: 0.25em; border: 0; background: ${divider}; margin: 24px 0; }
a { text-decoration: none; }
a:hover { text-decoration: underline; }`,
    "img-small": () => `img.img-small { width: min(160px, 100%); }`,
    "img-medium": () => `img.img-medium { width: min(512px, 100%); }`,
    "img-circle": () => `img.img-circle {
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 50%;
}`,
    "img-square": () => `img.img-square { border-radius: 0; }`,
    "img-placeholder": ({ divider }) => `.img-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 3 / 2;
    margin: 16px auto;
    border-radius: 12px;
    background: ${divider};
    font-size: 13px;
    opacity: 0.8;
}
.img-placeholder.img-small { width: min(160px, 100%); aspect-ratio: 1; }
.img-placeholder.img-medium { width: min(512px, 100%); }
.img-placeholder.img-circle { aspect-ratio: 1; border-radius: 50%; }
.img-placeholder.img-square { border-radius: 0; }`,
    pill: ({ accent, accentContrast }) => `p.pill { margin: 12px auto; max-width: 420px; }
p.pill a {
    display: block;
    text-align: center;
    padding: 14px 24px;
    background: ${accent};
    color: ${accentContrast};
    border-radius: 12px;
    text-decoration: none;
    font-weight: 600;
}`,
};

// The shell's stylesheet for a theme: base rules plus the requested feature
// chunks. This is what lands in the CSS pane when a site converts to HTML.
export function shellCss(theme: PageTheme, features: readonly ShellFeature[] = []): string {
    const accent = escapeHtml(theme.accentColor);
    const background = escapeHtml(theme.background);
    const font = escapeHtml(theme.fontFamily);
    const colors = siteColors(theme.background);
    const fontSize = theme.fontSize ? escapeHtml(theme.fontSize) : DEFAULT_FONT_SIZE;
    const foreground = theme.textColor ? escapeHtml(theme.textColor) : colors.foreground;
    const align = theme.align === "center" ? "\n    text-align: center;" : "";
    const accentContrast = siteColors(theme.accentColor).foreground;
    const featureCss = features
        .map((f) => FEATURE_CSS[f]({ accent, accentContrast, divider: colors.divider }))
        .join("\n");

    return `:root { color-scheme: ${colors.colorScheme}; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 64px 24px;
    background: ${background};
    color: ${foreground};
    font-family: ${font};
    font-size: ${fontSize};
    line-height: 1.5;${align}
}
main { max-width: 640px; margin: 0 auto; }
h1 {
    margin: 0 0 16px;
    font-size: clamp(36px, 8vw, 56px);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: ${accent};
    line-height: 1.1;
}
p { margin: 0 0 16px; }
a { color: ${accent}; text-decoration: underline; text-underline-offset: 3px; }
a:hover { opacity: 0.8; }
img { display: block; max-width: 100%; height: auto; border-radius: 12px; margin: 16px auto; }
hr { border: 0; border-top: 1px solid ${colors.divider}; margin: 32px 0; }
footer { margin-top: 64px; opacity: 0.4; font-size: 12px; }
@media (max-width: 600px) { body { padding: 64px 16px; } }
${featureCss}`;
}

// The three CodePen-style panes plus the <title>. `title` must already be
// HTML-safe (entity-encoded); css/bodyHtml/js are emitted verbatim.
export interface DocumentParts {
    title: string;
    css: string;
    bodyHtml: string;
    js?: string;
}

// Assemble panes into the final single-file artifact. This user-JS <script> tag
// is omitted entirely when there's no JS (only the HTML mode supplies any), so
// blocks/markdown output carries no user JS — just the tiny credit-link script
// wrapMain bakes into the footer.
export function assembleDocument({ title, css, bodyHtml, js }: DocumentParts): string {
    const script = js && js.trim() ? `\n<script>\n${js}\n</script>` : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${bodyHtml}${script}
</body>
</html>
`;
}

// Body wrapper shared by the blocks and markdown renderers: the centered
// column plus the attribution footer.
//
// Deliberately NO target="_blank" on the attribution link: the artifact is
// a standalone page viewed inside Polkadot hosts too, where _blank taps are
// dead (neither mobile WebView wires window-opening).
//
// The link's DEFAULT href is the public `.dot.li` gateway, the only form a
// plain web browser can resolve. Inside a Polkadot host, though, that gateway
// is just an external website — clicking it leaves the host and opens the OS
// browser (Firefox). The host resolves the NATIVE `.dot` form itself, so the
// tiny inline script below rewrites the credit to `https://playground.dot` when
// the page is being viewed inside a host. The host is detected from how the
// PAGE ITSELF was loaded — a native `.dot` hostname or the `polkadot://` scheme
// means a host resolved it; mobile webviews additionally carry
// `__HOST_WEBVIEW_MARK__`. A plain-web visitor arrives via `<name>.dot.li`
// (hostname ends in `.dot.li`, not `.dot`) and keeps the resolvable gateway
// link untouched. Mirrors hostLinkForm's `.dot.li` → `.dot` rule, applied from
// inside the standalone artifact where the React PopupLink can't run.
// `interactive` is false for the builder's live preview iframe: there the
// credit must NOT navigate (it would either reload the small preview pane or,
// in the host, open the OS browser — the very thing we avoid). It renders as an
// href-less <a> so the footer CSS still styles it identically, but the click is
// a no-op and the host-rewrite script is omitted. The deployed artifact always
// uses interactive=true (the default) so real visitors get a working,
// host-aware badge. This matches the blocks-mode React footer, which is inert
// in the builder and clickable only once baked into the artifact.
export function wrapMain(inner: string, interactive = true): string {
    const credit = interactive
        ? `<footer>made with <a id="pg-credit" href="https://playground.dot.li">playground.dot</a></footer>
    <script>
    (function () {
      try {
        var l = window.location;
        var inHost =
          l.protocol === "polkadot:" ||
          /(^|\\.)dot$/.test(l.hostname) ||
          window.__HOST_WEBVIEW_MARK__ === true;
        if (inHost) {
          var a = document.getElementById("pg-credit");
          if (a) a.setAttribute("href", "https://playground.dot");
        }
      } catch (e) {}
    })();
    </script>`
        : `<footer>made with <a>playground.dot</a></footer>`;
    return `<main>
    ${inner}
    ${credit}
</main>`;
}

export function renderHtmlParts(content: SiteContent): DocumentParts {
    const blocks = content.blocks.map(renderBlock).join("\n    ");

    const features: ShellFeature[] = [];
    const images = content.blocks.filter((b) => b.type === "image");
    const sizes = images.map((b) => imageSize(b.variant));
    const shapes = images.map((b) => imageShape(b));
    if (sizes.includes("small")) features.push("img-small");
    if (sizes.includes("medium")) features.push("img-medium");
    if (shapes.includes("circle")) features.push("img-circle");
    if (shapes.includes("square")) features.push("img-square");
    if (images.some((b) => isPlaceholderImageUrl(b.url)))
        features.push("img-placeholder");
    if (content.blocks.some((b) => b.type === "link" && b.variant === "pill"))
        features.push("pill");

    const firstHeading = content.blocks.find((b) => b.type === "heading");
    return {
        title: escapeHtml(firstHeading?.text || "hello"),
        css: shellCss(content, features),
        bodyHtml: wrapMain(blocks),
    };
}

export function renderHtml(content: SiteContent): string {
    return assembleDocument(renderHtmlParts(content));
}
