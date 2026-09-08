/**
 * The work a share job actually does, as pure functions.
 *
 * Everything expensive about sharing lives here: reading a file, decoding a
 * carrier, running the projection and redaction, validating against the bundle
 * schema, and encoding 32 MiB of JSON or 96 MiB of HTML. None of it may run on
 * the main process — a Zod parse over a 32 MiB document freezes the window —
 * so this module is written to be hosted by `workerEntry.ts` in a child
 * process, and imported directly by tests that want the logic without a fork.
 *
 * A job **owns its payload for its whole life**. The host keeps the decoded
 * bundle here and serves pages, encoded text and the final bundle from it, so
 * the big object never crosses back to main until the one moment it must (the
 * database write). Main holds a handle and a small preview, and keeps the
 * memory reserved for exactly as long as this side still owns the data.
 */
import type { ShareBundle, ShareComment, ShareEntry } from "@capygen/shared";
import { decodeShareFile } from "./decode.js";
import { createHash } from "node:crypto";
import { canonicalJson, SHARE_JSON_MAX_BYTES, ShareCodecError } from "./json.js";
import { SHARE_HTML_MAX_BYTES } from "./html.js";
import { encodeShareHtml, encodeShareJson } from "./index.js";
import {
  buildLiveBundle,
  buildEntriesBundle,
  type LiveBlockRow,
  type ShareExportRequest,
} from "./buildBundle.js";
import type { ShareJobPreview } from "./workerHostTypes.js";

export interface ShareJob {
  bundle: ShareBundle;
  jsonText: string;
  preview: ShareJobPreview;
}

function summarize(bundle: ShareBundle): ShareJob {
  const json = encodeShareJson(bundle, { maxBytes: SHARE_JSON_MAX_BYTES });
  const html = encodeShareHtml(bundle, { maxBytes: SHARE_HTML_MAX_BYTES });
  const jsonText = json.ok ? json.text : json.fallback.text;
  return {
    bundle,
    jsonText,
    preview: {
      source: bundle.source,
      counts: bundle.counts,
      bundleId: bundle.bundleId,
      createdAt: bundle.createdAt,
      appVersion: bundle.appVersion,
      entryCount: bundle.entries.length,
      commentCount: bundle.comments.length,
      json: { bytes: json.bytes, withinLimit: json.ok },
      html: { bytes: html.bytes, withinLimit: html.ok },
      // The codec's own canonical form, which mirrors the one
      // `SharesRepo.commit` hashes with (see `json.ts` for why it is
      // reimplemented rather than imported — this process must stay free of
      // the SQLite binding). `shareCanonicalHash.test.ts` pins the two
      // together so a divergence is a failing test, not a silent mismatch.
      contentSha256: createHash("sha256").update(canonicalJson(bundle), "utf8").digest("hex"),
    },
  };
}

/** Decode one file from disk into a validated, encoded job. */
export async function runDecodeJob(input: {
  filePath: string;
  maxFileBytes: number;
  signal: AbortSignal;
}): Promise<ShareJob> {
  const { bundle } = await decodeShareFile({
    filePath: input.filePath,
    maxBytes: input.maxFileBytes,
    signal: input.signal,
  });
  return summarize(bundle);
}

/** Project a session's bounded source rows into a validated, encoded job. */
export function runExportJob(request: ShareExportRequest): ShareJob {
  const bundle = request.kind === "live"
    ? buildLiveBundle(request)
    : buildEntriesBundle(request);
  return summarize(bundle);
}

export function pageEntries(job: ShareJob, offset: number, limit: number): ShareEntry[] {
  return job.bundle.entries.slice(offset, offset + limit);
}

export function pageComments(job: ShareJob, offset: number, limit: number): ShareComment[] {
  return job.bundle.comments.slice(offset, offset + limit);
}

/** The exact bytes a save writes. Re-encoded from the pinned bundle. */
export function encodeJob(job: ShareJob, format: "json" | "html"): string {
  const encoded = format === "json"
    ? encodeShareJson(job.bundle, { maxBytes: SHARE_JSON_MAX_BYTES })
    : encodeShareHtml(job.bundle, { maxBytes: SHARE_HTML_MAX_BYTES });
  if (!encoded.ok) {
    throw new ShareCodecError(
      "too-large",
      format === "html"
        ? "this session is too large for the readable HTML file; save the JSON bundle instead"
        : "this session is too large to share as one bundle",
    );
  }
  return encoded.text;
}

export type { LiveBlockRow, ShareExportRequest, ShareJobPreview };
