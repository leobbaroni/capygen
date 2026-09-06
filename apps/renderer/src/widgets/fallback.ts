/**
 * What to show where a widget should have been.
 *
 * Every claude.ai connector lands here — the spike proved capygen cannot read a
 * proxied connector's `ui://` resource (docs/spikes/mcp-apps.md §c), and
 * Higgsfield's own tools turned out to declare no MCP App UI at all — so this
 * path is not an error case, it is the *normal* rendering for a large class of
 * servers. It reads an MCP `CallToolResult` into the three things a person
 * actually wants to see: images, links, and the structured payload.
 */

export interface FallbackImage {
  /** Ready to use as an `<img src>` (a data: URI for inline image blocks). */
  src: string;
  alt: string;
}

export interface FallbackLink {
  href: string;
  label: string;
}

export interface WidgetFallback {
  text: string[];
  images: FallbackImage[];
  links: FallbackLink[];
  /** `structuredContent`, or the leftover content blocks, as pretty JSON. */
  json: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only web links are offered; a widget result must not surface a file path. */
export function isWebLink(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  return raw.startsWith("https://") || raw.startsWith("http://");
}

export function buildFallback(result: {
  content?: unknown[];
  structuredContent?: unknown;
} | null): WidgetFallback {
  const out: WidgetFallback = { text: [], images: [], links: [], json: null };
  if (!result) return out;

  for (const raw of result.content ?? []) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (type === "text" && typeof raw.text === "string") {
      out.text.push(raw.text);
      for (const url of extractUrls(raw.text)) out.links.push({ href: url, label: url });
      continue;
    }
    if (type === "image" && typeof raw.data === "string") {
      const mime = typeof raw.mimeType === "string" ? raw.mimeType : "image/png";
      out.images.push({ src: `data:${mime};base64,${raw.data}`, alt: "Tool result image" });
      continue;
    }
    if (type === "resource_link" && isWebLink(raw.uri)) {
      out.links.push({
        href: raw.uri,
        label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.uri,
      });
      continue;
    }
    if (type === "resource" && isRecord(raw.resource)) {
      const resource = raw.resource;
      if (typeof resource.text === "string") out.text.push(resource.text);
      else if (isWebLink(resource.uri)) {
        out.links.push({ href: resource.uri, label: String(resource.uri) });
      }
    }
  }

  if (result.structuredContent !== undefined) {
    out.json = safeJson(result.structuredContent);
    for (const url of extractUrls(out.json ?? "")) out.links.push({ href: url, label: url });
  }

  // Same link twice (once from the text, once from the structured payload) is
  // noise, not information.
  const seen = new Set<string>();
  out.links = out.links.filter((link) => {
    if (seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
  return out;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

export function extractUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;]+$/, ""));
}

export function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}
