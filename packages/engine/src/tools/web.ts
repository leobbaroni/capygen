/**
 * `web_fetch` — the one tool in the runtime that leaves the machine.
 *
 * Three rules, all of them safety rather than convenience (SPEC R27):
 *
 *  - **https only, on every hop.** `http:`, `file:`, `data:` and every other
 *    scheme is refused before a request is made, so a tool call cannot be
 *    talked into reading the local filesystem or a plaintext intranet endpoint.
 *  - **Size cap.** The body is read as a stream and abandoned once it passes
 *    the cap, so a 4 GB download cannot be used to exhaust memory.
 *  - **Redirects are followed by hand** (`redirect: "manual"`), and each hop is
 *    re-validated before it is followed. `redirect: "follow"` was a hole: the
 *    WHATWG algorithm only requires a redirect target to be *an* HTTP(S)
 *    scheme, not the same one, so an https URL that answered `302
 *    http://169.254.169.254/…` was followed and the metadata endpoint's body
 *    was handed to the model. The scheme is checked again per hop, and so is
 *    the host.
 *  - **Loopback / private / link-local literals are refused**, first hop or
 *    tenth. This is an address check, not a DNS one: a *hostname* that resolves
 *    to a private address still connects (DNS rebinding is out of reach without
 *    owning the socket), which is why the scheme rule above carries the weight.
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
/** Hops followed by hand before giving up (browsers use 20). */
export const MAX_REDIRECTS = 5;

export type FetchLike = (
  input: string,
  init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    redirect?: "follow" | "manual";
  },
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

/**
 * Hostnames and IP literals a fetch may never reach: the loopback, link-local
 * (cloud metadata lives at `169.254.169.254`), and the three RFC1918 ranges,
 * plus IPv6 loopback and unique-local (`fc00::/7`).
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Why this URL may not be fetched, or null when it may. */
export function refuseUrl(url: URL): string | null {
  if (url.protocol !== "https:") {
    return `web_fetch only allows https, got ${url.protocol}//`;
  }
  if (isBlockedHost(url.hostname)) {
    return `web_fetch refuses the loopback/private address ${url.hostname}`;
  }
  return null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
      const refusal = refuseUrl(url);
      if (refusal) return { content: `Refused: ${refusal}`, isError: true };
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
        // Redirects are followed here, not by `fetch`, so every hop's scheme
        // and host is checked before it is requested (see the file header).
        let current = url;
        for (let hop = 0; ; hop += 1) {
          const response = await doFetch(current.toString(), {
            signal: controller.signal,
            headers: {
              "user-agent": userAgent,
              accept: "text/html,application/json,text/plain;q=0.9",
            },
            redirect: "manual",
          });
          const location = response.headers.get("location");
          if (REDIRECT_STATUSES.has(response.status) && location) {
            if (hop >= MAX_REDIRECTS) {
              return {
                content: `Refused: more than ${MAX_REDIRECTS} redirects starting at ${url}`,
                isError: true,
              };
            }
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              return { content: `Refused: bad redirect target ${location}`, isError: true };
            }
            const hopRefusal = refuseUrl(next);
            if (hopRefusal) {
              return {
                content: `Refused: ${current} redirected to ${next} — ${hopRefusal}`,
                isError: true,
              };
            }
            current = next;
            continue;
          }

          const contentType = response.headers.get("content-type") ?? "";
          const body = await readCapped(response, cap);
          if (!response.ok) {
            return {
              content: `${current} → HTTP ${response.status} ${response.statusText}\n${body.slice(0, 2_000)}`,
              isError: true,
            };
          }
          const text = /\bhtml\b/i.test(contentType) ? htmlToText(body) : body;
          const header =
            `${response.url || current.toString()} (HTTP ${response.status}, ${contentType || "unknown type"}` +
            `${body.length >= cap ? `, truncated at ${cap} bytes` : ""})\n\n`;
          return clampText(header + text, ctx.maxOutputChars);
        }
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
