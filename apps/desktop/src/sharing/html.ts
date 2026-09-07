/**
 * The inert HTML carrier.
 *
 * The document is a static, offline, single file: no `<script>` of any type, no
 * event-handler attribute, no iframe or form, no external stylesheet, font or
 * image, no link that navigates. A viewer opening it gets a readable transcript
 * and nothing that runs.
 *
 * The bundle rides along **base64-encoded** inside a `<template>`. That is not
 * decoration: base64 cannot contain `<`, so no transcript text — however
 * hostile — can close the carrier early or inject markup into it. And on the
 * way back in, the importer reads *only* that one bounded carrier with a
 * regular expression. The document body is never parsed, never handed to a DOM
 * implementation and never executed; the readable half of the file is for human
 * eyes only and carries no authority at all.
 */
import type { ShareBundle, ShareComment, ShareEntry } from "@capygen/shared";
import {
  SHARE_JSON_MAX_BYTES,
  ShareCodecError,
  assertShareBundle,
  canonicalJson,
  decodeShareJson,
  resolveMaxBytes,
  utf8Bytes,
  type ShareEncodeOptions,
  type ShareEncodeResult,
  type ShareEncoded,
} from "./json.js";

/** UTF-8 bytes of the whole `.capyshare.html` file. Independent of the JSON cap:
 *  the carrier holds the bundle base64-encoded *and* again as escaped markup, so
 *  a bundle that is legal as JSON may still not fit here. */
export const SHARE_HTML_MAX_BYTES = 96 * 1024 * 1024;

const CARRIER_ID = "capygen-share";
const CARRIER_SCHEMA = 1;

/**
 * Escape for both text and attribute contexts, plus the two line separators a
 * naive escaper misses. Every interpolation in this file goes through it.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\u2028", "&#8232;")
    .replaceAll("\u2029", "&#8233;");
}

/**
 * The app's own default light and dark tokens, copied verbatim from
 * `apps/renderer/src/themePalettes.generated.css` (`:root:not(.dark)` and
 * `.dark`) plus `index.css`'s `--foreground-tertiary` and `--radius`. The file
 * has to stand alone offline — it cannot load the stylesheet — but the values
 * are the reference ones rather than a second palette invented here.
 */
const STYLE = [
  ":root{color-scheme:light dark;--background:#ffffff;--foreground:#27272a;--card:#ffffff;",
  "--muted-foreground:#71717a;--border:#e4e4e7;--foreground-tertiary:#a1a1aa;--radius:0.5rem}",
  "@media (prefers-color-scheme:dark){:root{--background:#0e1013;--foreground:#f5f6f7;",
  "--card:rgba(31,39,45,0.6);--muted-foreground:#92a4b3;--border:#2b3238}}",
  "body{margin:0;background:var(--background);color:var(--foreground);",
  "font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif}",
  "main{max-width:52rem;margin:0 auto;padding:2rem 1rem 4rem}",
  "h1{font-size:1.4rem;margin:0 0 .25rem}",
  ".meta{color:var(--muted-foreground);font-size:.85rem;margin-bottom:1.5rem}",
  ".entry{border:1px solid var(--border);background:var(--card);border-radius:var(--radius);",
  "padding:.75rem 1rem;margin:.75rem 0}",
  ".label{color:var(--muted-foreground);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}",
  ".text{white-space:pre-wrap;overflow-wrap:anywhere;margin:.35rem 0 0}",
  ".activity .text,.notice .text{color:var(--foreground-tertiary)}",
  ".claims{border:1px dashed var(--border);border-radius:var(--radius);padding:.75rem 1rem;",
  "color:var(--muted-foreground);font-size:.85rem}",
  ".comment{border-left:3px solid var(--border);padding:.25rem 0 .25rem .75rem;margin:.5rem 0}",
  "table{border-collapse:collapse;font-size:.85rem}td{padding:.1rem .75rem .1rem 0}",
].join("");

function renderEntry(entry: ShareEntry): string {
  const name = entry.kind === "activity" || entry.kind === "activity-result" ? entry.name : "";
  const heading = name === "" ? entry.label : `${entry.label} · ${name}`;
  const body = "text" in entry ? entry.text : "";
  const truncated = entry.truncated ? '<p class="label">clipped at the share limit</p>' : "";
  return (
    `<article class="entry ${escapeHtml(entry.kind)}">` +
    `<p class="label">${escapeHtml(heading)}</p>` +
    (body === "" ? "" : `<p class="text">${escapeHtml(body)}</p>`) +
    truncated +
    "</article>"
  );
}

function renderComment(comment: ShareComment): string {
  const anchor = comment.entryIndex === null ? "on the session" : `on entry ${comment.entryIndex}`;
  const state = comment.resolved ? " · resolved" : "";
  return (
    '<div class="comment">' +
    `<p class="label">${escapeHtml(comment.author)} · ${escapeHtml(anchor)}${escapeHtml(state)}</p>` +
    `<p class="text">${escapeHtml(comment.body)}</p>` +
    "</div>"
  );
}

/** The omission tallies, rendered as what they are: the sender's claims. */
function renderClaims(bundle: ShareBundle): string {
  const all: Array<[string, number]> = [
    ["reasoning blocks withheld", bundle.counts.droppedThinking],
    ["approvals and questions withheld", bundle.counts.droppedInteractive],
    ["app widgets withheld", bundle.counts.droppedWidgets],
    ["usage records withheld", bundle.counts.droppedUsage],
    ["spans redacted", bundle.counts.redactions],
  ];
  const rows = all.filter(([, count]) => count > 0);
  if (rows.length === 0) return "";
  const cells = rows
    .map(([what, count]) => `<tr><td>${escapeHtml(what)}</td><td>${count}</td></tr>`)
    .join("");
  return (
    '<section class="claims"><p>The sender states this bundle omits the following. ' +
    "These figures come from the file itself and are not verified by capygen.</p>" +
    `<table>${cells}</table></section>`
  );
}

export function encodeShareHtml(bundle: ShareBundle): ShareEncoded;
export function encodeShareHtml(bundle: ShareBundle, options: ShareEncodeOptions): ShareEncodeResult;
export function encodeShareHtml(
  bundle: ShareBundle,
  options?: ShareEncodeOptions,
): ShareEncodeResult {
  const limit = resolveMaxBytes(options?.maxBytes, SHARE_HTML_MAX_BYTES, "maxBytes");
  // Validate before a single character is rendered. Everything below reads
  // `safe`, so a forged `ShareBundle` cannot reach an interpolation.
  const safe = assertShareBundle(bundle);
  const json = canonicalJson(safe);
  const carrier = Buffer.from(json, "utf8").toString("base64");
  const title = safe.source.title ?? "Shared capygen session";
  const agents = safe.source.agents
    .map((agent) => [agent.label, agent.model].filter((part) => part !== null && part !== "").join(" · "))
    .join(", ");
  const when = [safe.source.startedAt, safe.source.endedAt].filter((v) => v !== null).join(" → ");

  const text =
    "<!doctype html>" +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; " +
    'frame-ancestors \'none\'">' +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${STYLE}</style></head><body><main>` +
    `<h1>${escapeHtml(title)}</h1>` +
    `<p class="meta">${escapeHtml(safe.source.mode)} session` +
    (agents === "" ? "" : ` · ${escapeHtml(agents)}`) +
    (when === "" ? "" : ` · ${escapeHtml(when)}`) +
    ` · ${escapeHtml(String(safe.counts.entries))} entries</p>` +
    renderClaims(safe) +
    safe.entries.map(renderEntry).join("") +
    (safe.comments.length === 0
      ? ""
      : `<section><h2 class="label">Comments</h2>${safe.comments.map(renderComment).join("")}</section>`) +
    "</main>" +
    `<template id="${CARRIER_ID}" data-schema="${CARRIER_SCHEMA}">${carrier}</template>` +
    "</body></html>";

  const bytes = utf8Bytes(text);
  if (bytes <= limit) return { ok: true, format: "html", text, bytes };

  if (options === undefined) {
    throw new ShareCodecError("too-large", `the carrier is ${bytes} bytes, over the ${limit} byte HTML limit`);
  }
  // `json` is the same validated bundle already serialized for the carrier, so
  // the offer is the exact reviewed text — not a second serialization of an
  // object that could have changed in between.
  const jsonBytes = utf8Bytes(json);
  return {
    ok: false, format: "html", reason: "too-large", bytes, limit,
    fallback: { format: "json", text: json, bytes: jsonBytes, withinLimit: jsonBytes <= SHARE_JSON_MAX_BYTES },
  };
}

/** Exactly one carrier, bounded, base64 only — `<` cannot appear inside it. */
const CARRIER = /<template id="capygen-share" data-schema="(\d{1,4})">([A-Za-z0-9+/=]{0,134217728})<\/template>/g;

/**
 * Read a bundle back out of a carrier file.
 *
 * The document is treated as an opaque string throughout: no DOM, no HTML
 * parser, no script execution, no navigation. Only the base64 payload of the
 * single matching carrier is decoded, and it still has to satisfy the strict
 * bundle schema afterwards.
 */
export function decodeShareHtml(html: string, options: { maxBytes?: number } = {}): ShareBundle {
  const limit = resolveMaxBytes(options.maxBytes, SHARE_HTML_MAX_BYTES, "maxBytes");
  const bytes = utf8Bytes(html);
  if (bytes > limit) {
    throw new ShareCodecError("too-large", `the file is ${bytes} bytes, over the ${limit} byte HTML limit`);
  }

  CARRIER.lastIndex = 0;
  const matches = [...html.matchAll(CARRIER)];
  if (matches.length === 0) {
    throw new ShareCodecError("carrier-missing", "no capygen share carrier was found in this file");
  }
  if (matches.length > 1) {
    throw new ShareCodecError(
      "carrier-duplicate",
      `this file carries more than one share bundle (${matches.length}); it is refused rather than guessed at`,
    );
  }

  const [, schema, encoded = ""] = matches[0]!;
  // Refuse on declared size before decoding: base64 is 3 bytes out per 4 in,
  // so an oversize payload is known without allocating the buffer.
  if ((encoded.length / 4) * 3 > SHARE_JSON_MAX_BYTES) {
    throw new ShareCodecError("too-large", `the carrier payload is over the ${SHARE_JSON_MAX_BYTES} byte JSON limit`);
  }

  let json: string;
  try {
    const decoded = Buffer.from(encoded, "base64");
    // Base64 decoding is lenient, so a payload that does not re-encode to the
    // same text was not the base64 it claimed to be.
    if (decoded.toString("base64") !== encoded) {
      throw new Error("payload is not canonical base64");
    }
    // `Buffer.toString("utf8")` is lenient too: invalid bytes become U+FFFD,
    // which silently changes the sender's content instead of refusing it. A
    // fatal decoder throws on exactly those bytes.
    json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new ShareCodecError("carrier-malformed", "the share carrier is not readable: it is not canonical base64 of UTF-8 text");
  }

  const bundle = decodeShareJson(json);
  if (Number(schema) !== bundle.version) {
    throw new ShareCodecError(
      "identity-mismatch",
      `the carrier declares schema ${schema} but holds a version ${bundle.version} bundle`,
    );
  }
  return bundle;
}
