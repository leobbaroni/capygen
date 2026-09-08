/**
 * Reading a share file from disk, bounded.
 *
 * Three things happen before any parsing. The file is **stat'ed and refused on
 * size**, so a 90 MiB document of whitespace never gets read. Its format is
 * decided from a **bounded prefix of its bytes**, not from its name — a user
 * who renames an export to `.htm`, `.txt` or nothing at all still gets their
 * conversation back, and a `.json` file full of markup is still read as the
 * markup it is. And once the format is known, the **format's own ceiling** is
 * applied before the rest is read: a JSON document is refused at the 32 MiB
 * JSON cap rather than being read up to the 96 MiB carrier cap first.
 *
 * Sniffing decides which reader runs; it never decides what is trusted. HTML
 * still goes through the carrier reader, which parses one bounded base64
 * payload and never the document.
 *
 * The decode itself is a pure function of a string, which makes it the one part
 * of this feature that is safe to move off-thread unchanged — see
 * `ShareDecoder` in `../ipc/sharing.ts`, the seam a worker plugs into.
 */
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ShareBundle } from "@capygen/shared";
import { SHARE_HTML_MAX_BYTES, decodeShareHtml, decodeShareJson } from "./index.js";
import { SHARE_JSON_MAX_BYTES, ShareCodecError } from "./json.js";

/** Bytes read to decide the format. Enough for a BOM, whitespace and an opener. */
const SNIFF_BYTES = 4096;

export interface DecodeShareFileInput {
  filePath: string;
  maxBytes: number;
  signal: AbortSignal;
}

export interface DecodedShareFile {
  bundle: ShareBundle;
  fileBytes: number;
}

/**
 * Which reader this file needs, from its opening bytes.
 *
 * A share bundle is either a JSON object or an HTML document, so the first
 * non-blank character decides it: `{` is JSON, `<` is HTML. Nothing else is a
 * share file at all, and saying so here means the failure is "this is not a
 * share file" rather than a confusing parser error further in.
 */
function sniffFormat(prefix: string): "json" | "html" {
  // A BOM and any leading whitespace are skipped; both are legal in a file the
  // user may have opened and re-saved in an editor.
  const start = prefix.replace(/^\uFEFF/, "").trimStart();
  if (start.startsWith("{")) return "json";
  if (start.startsWith("<")) return "html";
  throw new ShareCodecError(
    "carrier-malformed",
    "that file is neither a capygen share bundle nor a share page",
  );
}

/** Read the first bytes of a file without opening a stream over all of it. */
async function readPrefix(filePath: string, bytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    // Not fatal-decoded: a multi-byte character may straddle the cut, and this
    // prefix only ever decides `{` versus `<`.
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Read the whole file, refusing rather than truncating. */
async function readAll(filePath: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = createReadStream(filePath, { signal });
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    // The file can grow between the stat and the read, so the cap is enforced
    // again as bytes arrive rather than trusted from the size check alone.
    if (total > maxBytes) {
      stream.destroy();
      throw new ShareCodecError("too-large", `that file is over the ${maxBytes} byte limit`);
    }
    chunks.push(buffer);
  }
  // A fatal decoder: invalid UTF-8 is refused, never repaired into U+FFFD.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ShareCodecError("carrier-malformed", "that file is not valid UTF-8 text");
  }
}

/** The default in-process decoder. Bounded, and pure once the bytes are read. */
export async function decodeShareFile(input: DecodeShareFileInput): Promise<DecodedShareFile> {
  const outerCap = Math.min(input.maxBytes, SHARE_HTML_MAX_BYTES);
  const info = await stat(input.filePath);
  if (!info.isFile()) throw new ShareCodecError("carrier-malformed", "that is not a file");
  if (info.size > outerCap) {
    throw new ShareCodecError(
      "too-large",
      `that file is ${info.size} bytes, over the ${outerCap} byte limit`,
    );
  }

  const format = sniffFormat(await readPrefix(input.filePath, SNIFF_BYTES));
  // Now the format is known, so its own ceiling applies — before the rest of
  // the file is read, not after.
  const cap = format === "html" ? outerCap : Math.min(outerCap, SHARE_JSON_MAX_BYTES);
  if (info.size > cap) {
    throw new ShareCodecError(
      "too-large",
      `that share bundle is ${info.size} bytes, over the ${cap} byte limit`,
    );
  }

  const text = await readAll(input.filePath, cap, input.signal);
  const bundle = format === "html" ? decodeShareHtml(text) : decodeShareJson(text);
  return { bundle, fileBytes: Buffer.byteLength(text, "utf8") };
}
