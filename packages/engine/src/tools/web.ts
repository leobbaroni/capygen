/**
 * `web_fetch` — the one tool in the runtime that leaves the machine.
 *
 * Three rules, all of them safety rather than convenience (SPEC R27):
 *
 *  - **https only.** `http:`, `file:`, `data:` and every other scheme is
 *    refused before a request is made, so a tool call cannot be talked into
 *    reading the local filesystem or a plaintext intranet endpoint.
 *  - **Size cap.** The body is read as a stream and abandoned once it passes
 *    the cap, so a 4 GB download cannot be used to exhaust memory.
 *  - **Redirects are followed by `fetch` itself but re-checked**: the final URL
 *    is reported in the result so a redirect to somewhere else is visible.
 *
 * HTML is reduced to text here rather than handed to the model raw: markup is
 * most of the bytes and none of the meaning, and R23–R26 care about what a turn
 * costs.
 */
import {
  clampText,
  describeError,
  optionalNumber,
  requireString,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

export const DEFAULT_FETCH_BYTES = 512 * 1024;
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "follow" },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  body?: unknown;
  text(): Promise<string>;
}>;

export interface WebFetchDeps {
  fetch?: FetchLike;
  userAgent?: string;
}

/**
 * Strip a HTML document down to its readable text: drop `script`/`style`/
 * `noscript`/`svg` bodies, turn block-level tags into newlines, decode the
 * handful of entities that actually appear, and collapse the whitespace.
 */
export function htmlToText(html: string): string {
  const withoutHead = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutHead
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const text = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function createWebFetchTool(deps: WebFetchDeps = {}): ToolDefinition {
  const doFetch = (deps.fetch ?? (globalThis.fetch as unknown as FetchLike)) as
    | FetchLike
    | undefined;
  const userAgent = deps.userAgent ?? "capygen/0.1 (+local desktop agent)";
  return {
    name: "web_fetch",
    description:
      "Fetch an https URL and return its text. HTML is reduced to readable text; " +
      "JSON and plain text are returned as-is. Only https is allowed.",
    permissionClass: "network",
    family: "web",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "An https:// URL." },
        max_bytes: {
          type: "integer",
          description: `Stop reading after this many bytes. Default ${DEFAULT_FETCH_BYTES}, max ${MAX_FETCH_BYTES}.`,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run(input, ctx): Promise<ToolResult> {
      const raw = requireString(input, "url");
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return { content: `Not a valid URL: ${raw}`, isError: true };
      }
      if (url.protocol !== "https:") {
        return {
          content: `Refused: web_fetch only allows https, got ${url.protocol}//`,
          isError: true,
        };
      }
      if (!doFetch) {
        return { content: "No fetch implementation is available in this runtime.", isError: true };
      }
      const cap = Math.min(
        MAX_FETCH_BYTES,
        Math.max(1_024, optionalNumber(input, "max_bytes") ?? DEFAULT_FETCH_BYTES),
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = (): void => controller.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await doFetch(url.toString(), {
          signal: controller.signal,
          headers: { "user-agent": userAgent, accept: "text/html,application/json,text/plain;q=0.9" },
          redirect: "follow",
        });
        const contentType = response.headers.get("content-type") ?? "";
        const body = await readCapped(response, cap);
        if (!response.ok) {
          return {
            content: `${url} → HTTP ${response.status} ${response.statusText}\n${body.slice(0, 2_000)}`,
            isError: true,
          };
        }
        const text = /\bhtml\b/i.test(contentType) ? htmlToText(body) : body;
        const header =
          `${response.url || url.toString()} (HTTP ${response.status}, ${contentType || "unknown type"}` +
          `${body.length >= cap ? `, truncated at ${cap} bytes` : ""})\n\n`;
        return clampText(header + text, ctx.maxOutputChars);
      } catch (err) {
        return { content: `Fetch failed: ${describeError(err)}`, isError: true };
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Read at most `cap` bytes. Prefers the streaming body so an oversized response
 * is abandoned rather than buffered; falls back to `text()` for a response
 * object (or a test double) that has no reader.
 */
async function readCapped(
  response: { body?: unknown; text(): Promise<string> },
  cap: number,
): Promise<string> {
  const body = response.body as
    | { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> } }
    | null
    | undefined;
  const reader = typeof body?.getReader === "function" ? body.getReader() : null;
  if (!reader) {
    const whole = await response.text();
    return whole.length > cap ? whole.slice(0, cap) : whole;
  }
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    if (!value) continue;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= cap) break;
  }
  out += decoder.decode();
  return out.length > cap ? out.slice(0, cap) : out;
}

export const webFetchTool: ToolDefinition = createWebFetchTool();
