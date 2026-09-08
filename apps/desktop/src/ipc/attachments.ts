/**
 * The image attachment store: where a picture the user attached actually lives.
 *
 * `chat.send` carries base64 for exactly one hop. This module decodes it,
 * *sniffs* it (a renderer-declared `mediaType` is never trusted), writes the
 * bytes under `<userData>/attachments/` and hands back a descriptor. From then
 * on everything downstream refers to the file: the `image` block row keeps only
 * the id, the harnesses read the path, and the renderer displays it over the
 * `capygen-attachment://` scheme registered here.
 *
 * Three deliberate properties:
 *
 *   - **Nothing is written into the user's workspace.** The store is app data
 *     under `userData`; the project directory and the user's Claude/Codex
 *     configuration are never touched.
 *   - **No base64 is logged.** Only ids, byte counts and media types appear in
 *     the log line, exactly as with secrets elsewhere in the app.
 *   - **The served path is derived, not supplied.** The scheme handler accepts a
 *     bare `<id>.<ext>` and resolves it inside the store root, so a request can
 *     never walk out of it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_TOTAL_BYTES,
  IMAGE_EXTENSIONS,
  newId,
  sniffImageMediaType,
  type InputImageAttachment,
  type InputImageMediaType,
} from "@capygen/shared";

/** The privileged scheme stored attachments are served from. */
export const ATTACHMENT_SCHEME = "capygen-attachment";

/** `protocol.registerSchemesAsPrivileged` entry — must run before `app.ready`. */
export const ATTACHMENT_SCHEME_PRIVILEGES = {
  scheme: ATTACHMENT_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: false,
    corsEnabled: false,
    stream: false,
  },
} as const;

/** `capygen-attachment://file/att_….png` — one fixed host, the id in the path. */
export function attachmentUrl(attachmentId: string, mediaType: InputImageMediaType): string {
  return `${ATTACHMENT_SCHEME}://file/${attachmentId}.${IMAGE_EXTENSIONS[mediaType]}`;
}

/** What a stored image is downstream: an identity, a type and a real file. */
export interface StoredImage {
  attachmentId: string;
  name: string;
  mediaType: InputImageMediaType;
  size: number;
  path: string;
}

export interface AttachmentLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** Only what this module ever emits into a URL or a file name. */
const SAFE_FILE = /^[A-Za-z0-9_]+\.(?:png|jpg|webp)$/;

/**
 * Strip a name down to something safe to show and to log. The stored file is
 * named by id, so this is display metadata only — but it still ends up in a
 * block row, a prompt (Codex labels attachments) and the log.
 */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._ ()\[\]-]/g, "_").trim();
  return base.length > 0 ? base.slice(0, 120) : "image";
}

export class AttachmentStore {
  private readonly root: string;

  constructor(root: string, private readonly log: AttachmentLog) {
    this.root = root;
  }

  /**
   * Decode, verify and store one batch of attachments — all or nothing.
   *
   * Throws (which `chat.send` turns into a rejected invoke, leaving the user's
   * draft intact in the composer) when anything is wrong: too many, too large,
   * a size that disagrees with the payload, or bytes whose magic number is not
   * one of the three supported formats. A partially stored batch is cleaned up
   * so a refused send leaves nothing behind.
   */
  store(attachments: readonly InputImageAttachment[]): StoredImage[] {
    if (attachments.length === 0) return [];
    if (attachments.length > IMAGE_ATTACHMENT_MAX_COUNT) {
      throw new Error(`Attach at most ${IMAGE_ATTACHMENT_MAX_COUNT} images to one message.`);
    }
    const decoded: { attachment: InputImageAttachment; bytes: Buffer; sniffed: InputImageMediaType }[] = [];
    let total = 0;
    for (const attachment of attachments) {
      const bytes = Buffer.from(attachment.data, "base64");
      if (bytes.byteLength === 0) {
        throw new Error(`${safeName(attachment.name)}: the image was empty.`);
      }
      if (bytes.byteLength > IMAGE_ATTACHMENT_MAX_BYTES) {
        throw new Error(
          `${safeName(attachment.name)}: images are limited to ${
            IMAGE_ATTACHMENT_MAX_BYTES / (1024 * 1024)
          } MiB each.`,
        );
      }
      if (bytes.byteLength !== attachment.size) {
        throw new Error(`${safeName(attachment.name)}: the image did not transfer intact.`);
      }
      const sniffed = sniffImageMediaType(bytes);
      if (!sniffed) {
        throw new Error(
          `${safeName(attachment.name)}: this is not a PNG, JPEG or WebP image. ` +
            "Other binary formats, PDFs included, are not supported.",
        );
      }
      if (sniffed !== attachment.mediaType) {
        throw new Error(
          `${safeName(attachment.name)}: the file is ${sniffed}, not ${attachment.mediaType}. ` +
            "Rename or re-export it and try again.",
        );
      }
      total += bytes.byteLength;
      if (total > IMAGE_ATTACHMENT_TOTAL_BYTES) {
        throw new Error(
          `Images are limited to ${IMAGE_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MiB per message.`,
        );
      }
      decoded.push({ attachment, bytes, sniffed });
    }

    fs.mkdirSync(this.root, { recursive: true });
    const stored: StoredImage[] = [];
    try {
      for (const entry of decoded) {
        const attachmentId = newId("attachment");
        const file = path.join(this.root, `${attachmentId}.${IMAGE_EXTENSIONS[entry.sniffed]}`);
        fs.writeFileSync(file, entry.bytes, { mode: 0o600 });
        stored.push({
          attachmentId,
          name: safeName(entry.attachment.name),
          mediaType: entry.sniffed,
          size: entry.bytes.byteLength,
          path: file,
        });
      }
    } catch (err) {
      for (const entry of stored) {
        try {
          fs.rmSync(entry.path, { force: true });
        } catch {
          // Best effort: the batch already failed, and a leftover file in the
          // store is harmless — it is referenced by nothing.
        }
      }
      throw err;
    }
    // Ids, sizes and types only. The bytes never reach the log.
    this.log.info(
      `[attachments] stored ${stored.length} image(s): ` +
        stored.map((s) => `${s.attachmentId} ${s.mediaType} ${s.size}B`).join(", "),
    );
    return stored;
  }

  /** Absolute path of a stored attachment, or null when it is gone. */
  resolve(attachmentId: string, mediaType: InputImageMediaType): string | null {
    const name = `${attachmentId}.${IMAGE_EXTENSIONS[mediaType]}`;
    if (!SAFE_FILE.test(name)) return null;
    const file = path.join(this.root, name);
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Serve one `capygen-attachment://file/<id>.<ext>` request.
   *
   * The URL's path is matched against a strict pattern and joined to the store
   * root; anything else (a traversal, a nested path, an unknown extension) is a
   * miss rather than a read.
   */
  serve(url: string): { path: string; mediaType: string } | null {
    let name: string;
    try {
      name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    } catch {
      return null;
    }
    if (!SAFE_FILE.test(name)) return null;
    const file = path.join(this.root, name);
    if (path.dirname(path.resolve(file)) !== path.resolve(this.root)) return null;
    if (!fs.existsSync(file)) return null;
    const extension = path.extname(name).slice(1).toLowerCase();
    const mediaType =
      extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    return { path: file, mediaType };
  }

  /** Content hash, for the tests that assert the stored bytes are the input. */
  digest(attachmentId: string, mediaType: InputImageMediaType): string | null {
    const file = this.resolve(attachmentId, mediaType);
    if (!file) return null;
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
}
