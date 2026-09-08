/**
 * The share worker's wire contract, alone.
 *
 * Main imports the client, which imports this — and nothing else from the
 * worker. Keeping the message shapes here is what stops the codec, the
 * projection and their dependencies from being pulled into the main bundle
 * behind a type import.
 */
import type { ShareBundle, ShareComment, ShareEntry } from "@capygen/shared";
import type { ShareExportRequest } from "./buildBundle.js";

export const SHARE_WORKER_PROTOCOL_VERSION = 1;

/** Jobs one child holds at once. Main's byte budget is the real limit; this is
 *  a backstop so a leaked release cannot grow the child without bound. */
export const SHARE_WORKER_MAX_JOBS = 8;

/** What main is told about a staged payload. Small, and safe to clone. */
export interface ShareJobPreview {
  source: ShareBundle["source"];
  counts: ShareBundle["counts"];
  bundleId: string;
  createdAt: string;
  appVersion: string;
  entryCount: number;
  commentCount: number;
  json: { bytes: number; withinLimit: boolean };
  html: { bytes: number; withinLimit: boolean };
  /**
   * SHA-256 over the canonical serialization of the validated bundle, in
   * lowercase hex — the same identity `SharesRepo.commit` stores, computed by
   * the side that already holds the bundle.
   *
   * Without it, telling a duplicate from a conflicting id meant asking the
   * worker for the whole JSON text and hashing it in main: a second full copy
   * of a document up to 32 MiB, moved across a process boundary and hashed on
   * the UI thread, to produce 64 characters.
   */
  contentSha256: string;
}

/** Every operation the child implements. */
export type ShareWorkerOp =
  | "createFromFile" | "createFromExport" | "entries" | "comments" | "text" | "bundle" | "release";

export type ShareWorkerRequest =
  | { v: number; id: string; op: "createFromFile"; jobId: string; filePath: string; maxFileBytes: number }
  | { v: number; id: string; op: "createFromExport"; jobId: string; request: ShareExportRequest }
  | { v: number; id: string; op: "entries"; jobId: string; offset: number; limit: number }
  | { v: number; id: string; op: "comments"; jobId: string; offset: number; limit: number }
  | { v: number; id: string; op: "text"; jobId: string; format: "json" | "html" }
  | { v: number; id: string; op: "bundle"; jobId: string }
  | { v: number; id: string; op: "release"; jobId: string };

/**
 * Every reply echoes the `op` it answers.
 *
 * Without it a correlation id alone would let a confused child answer an
 * `entries` request with a `bundle` payload, and main would have no way to
 * notice. The id says *which* question; the op says *what was asked*.
 */
export type ShareWorkerResponse =
  | { v: number; id: string; op: "createFromFile" | "createFromExport"; ok: true; preview: ShareJobPreview }
  | { v: number; id: string; op: "entries"; ok: true; entries: ShareEntry[] }
  | { v: number; id: string; op: "comments"; ok: true; comments: ShareComment[] }
  | { v: number; id: string; op: "text"; ok: true; text: string; bytes: number }
  | { v: number; id: string; op: "bundle"; ok: true; bundle: ShareBundle }
  | { v: number; id: string; op: "release"; ok: true; released: boolean }
  | { v: number; id: string; op: ShareWorkerOp | "unknown"; ok: false; code: string; message: string };
