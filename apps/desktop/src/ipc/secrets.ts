/**
 * `SecretsStore` backed by Electron `safeStorage` (R21 — "store it with
 * Electron safeStorage (Windows DPAPI) and never write it to plain files or
 * logs"). Kept separate from `handlers.ts` (which stays Electron-free on
 * purpose, per that file's own header) so the rest of the IPC layer is still
 * unit-testable against a temp SQLite store with no Electron in the process.
 *
 * On disk this writes exactly one small JSON file: provider → base64
 * ciphertext at the top level (the shape Phase 6 shipped, unchanged), plus a
 * namespaced `mcp` object holding MCP secret refs → base64 ciphertext (S0).
 * `safeStorage.decryptString` is the only way back to plaintext, and on
 * Windows that only succeeds for the same user account that encrypted it — so
 * the file is useless to anyone who merely copies it.
 *
 * The MCP half is main-process-only and has no IPC channel of its own: the
 * renderer never sees a ref's value, and a ref name is opaque (`mcp/<32 lower
 * hex>`, caller-generated) precisely so it carries no server name, no path and
 * no user input — renaming an MCP server never has to touch the ciphertext.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { API_PROVIDERS, type ApiProvider } from "@capygen/shared";
import type { SecretsStore } from "./handlers.js";

/** The slice of Electron's `safeStorage` this file needs — narrowed so a test
 *  can supply a fake without importing Electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The property under which MCP ciphertext lives, next to the provider keys. */
const MCP_NAMESPACE = "mcp";

/** The id half of a ref: 32 lowercase hex characters. */
const MCP_ID_PATTERN = /^[0-9a-f]{32}$/;

/** `mcp/` + 32 lowercase hex characters. Nothing else is a ref. */
const MCP_REF_PATTERN = /^mcp\/[0-9a-f]{32}$/;

/**
 * An opaque handle to one MCP secret. The id half is random and unrelated to
 * the server it belongs to, so the caller can rename or re-key a server
 * without rewriting anything here.
 */
export type McpSecretRef = string;

/** True only for the exact `mcp/<32 lowercase hex>` grammar. */
export function isMcpSecretRef(value: unknown): value is McpSecretRef {
  return typeof value === "string" && MCP_REF_PATTERN.test(value);
}

/** Mint a fresh ref. Callers own refs; this store never derives one from a
 *  server name, a file path or anything else the user typed. */
export function newMcpSecretRef(): McpSecretRef {
  return `${MCP_NAMESPACE}/${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * The MCP half of the store. Main-process only — deliberately **not** an IPC
 * surface, the same way `SecretsStore.get` is not.
 */
export interface McpSecretsStore {
  /** Encrypt and store `value` under `ref`, replacing any previous value.
   *  Throws when the ref is malformed, or when OS-level encryption is
   *  unavailable (never a plaintext fallback). */
  setRef(ref: McpSecretRef, value: string): void;
  /** The plaintext, or null when nothing is stored, encryption is unavailable,
   *  or the ciphertext cannot be decrypted on this machine. */
  getRef(ref: McpSecretRef): string | null;
  /** Whether ciphertext exists for `ref`. Never touches `safeStorage`, so it
   *  answers the same on a machine that cannot decrypt. */
  hasRef(ref: McpSecretRef): boolean;
  /** Remove `ref`, leaving every other entry — provider or MCP — untouched. */
  deleteRef(ref: McpSecretRef): void;
}

/** What `createSafeStorageSecretsStore` returns: the Phase 6 provider store,
 *  plus the S0 MCP ref store. */
export type SafeStorageSecretsStore = SecretsStore & McpSecretsStore;

type SecretsFile = Partial<Record<ApiProvider, string>> & {
  [MCP_NAMESPACE]?: Record<string, string>;
} & Record<string, unknown>;

type ReadResult =
  | { kind: "ok"; data: SecretsFile }
  /** No file yet (first run): "nothing stored", not an error. */
  | { kind: "empty" }
  /** The file exists but is not JSON in the shape this store writes, or it
   *  could not be read at all (EACCES/EIO/EMFILE — the bytes are there, we
   *  just cannot see them). Either way its bytes are never overwritten: a
   *  mutation refuses instead of destroying whatever is actually in there. */
  | { kind: "unusable" };

/** The `mcp` namespace as this store writes it: 32-hex ids → base64 strings. */
function isValidMcpMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([id, entry]) => MCP_ID_PATTERN.test(id) && typeof entry === "string",
  );
}

function readStore(file: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Only "there is no file" means "nothing stored". A permission error, a
    // bad sector or an exhausted fd table all mean "there may well be keys in
    // there" — treating those as empty would let the next `set` overwrite
    // every key the user has.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "empty" };
    return { kind: "unusable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unusable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unusable" };
  }
  const data = parsed as SecretsFile;
  // Known keys must have the types this store writes; an unknown top-level key
  // is left alone (forward compatibility), not treated as damage.
  for (const provider of API_PROVIDERS) {
    if (provider in data && typeof data[provider] !== "string") return { kind: "unusable" };
  }
  const nested = data[MCP_NAMESPACE];
  if (nested !== undefined && !isValidMcpMap(nested)) return { kind: "unusable" };
  return { kind: "ok", data };
}

/** Read for a *mutation*: a file we cannot read or do not recognise stops the
 *  write rather than being silently replaced, so nothing is ever lost. */
function readForWrite(file: string): SecretsFile {
  const result = readStore(file);
  if (result.kind === "unusable") {
    throw new Error(
      "capygen: the stored-secrets file could not be read, so it was left untouched. Nothing was written.",
    );
  }
  return result.kind === "ok" ? result.data : {};
}

/** Read for a *query*: an unreadable or missing file reads as "nothing stored",
 *  the same as before S0 — a query must not throw on every turn. */
function readForQuery(file: string): SecretsFile {
  const result = readStore(file);
  return result.kind === "ok" ? result.data : {};
}

/**
 * Write via a temp file in the same directory, then rename over the target, so
 * a crash or a full disk mid-write leaves the previous file intact instead of
 * a truncated one. The temp is created exclusively (`wx`) at mode 0600, so a
 * pre-existing file of the same name is never truncated — and only a temp this
 * call actually created is ever removed.
 */
function writeFile(file: string, data: SecretsFile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(data);
  const base = path.basename(file);
  let collision: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temp = path.join(dir, `.${base}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    let fd: number;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
    } catch (error) {
      // Someone else's file is sitting on that name: pick another one rather
      // than clobbering it, and leave it exactly where it is.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        collision = error;
        continue;
      }
      throw error;
    }
    // Past this point the temp is ours, so cleaning it up is ours to do.
    try {
      try {
        fs.writeFileSync(fd, payload, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Best effort: the original file is what matters, and it is untouched.
      }
      throw error;
    }
    return;
  }

  throw (
    collision ??
    new Error("capygen: could not create a temporary file to store secrets in. Nothing was written.")
  );
}

function assertRef(ref: unknown): asserts ref is McpSecretRef {
  if (!isMcpSecretRef(ref)) {
    // Deliberately does not echo the input back: this message can reach a log,
    // and the caller already knows what it passed.
    throw new Error("capygen: not a valid MCP secret ref.");
  }
}

/** The map key for a ref — the id half, since the namespace is the property. */
function refKey(ref: McpSecretRef): string {
  return ref.slice(MCP_NAMESPACE.length + 1);
}

export interface SafeStorageSecretsStoreDeps {
  safeStorage: SafeStorageLike;
  /** Where the ciphertext map is written, e.g. `<userData>/secrets.json`. */
  filePath: string;
  log?: { warn: (message: string) => void };
}

/**
 * `set`/`setRef` refuse outright when OS-level encryption is unavailable rather
 * than falling back to plaintext — a silent plaintext fallback is exactly the
 * R21 failure this store exists to prevent. `has`/`delete`/`hasRef`/`deleteRef`
 * never touch `safeStorage` at all, so they still work (read the shape of
 * what's stored, remove an entry) even on a machine where encryption is
 * unavailable.
 */
export function createSafeStorageSecretsStore(
  deps: SafeStorageSecretsStoreDeps,
): SafeStorageSecretsStore {
  const { safeStorage, filePath, log } = deps;

  /**
   * Encrypt, never letting the platform's own error escape: an
   * `encryptString` failure can carry the plaintext it was handed in its
   * message, and that message would otherwise reach a log or an IPC error.
   */
  function encrypt(value: string, what: string): string {
    try {
      return safeStorage.encryptString(value).toString("base64");
    } catch {
      log?.warn(`[secrets] encrypting the ${what} failed on this machine`);
      throw new Error(
        "capygen: this machine could not encrypt the secret, so nothing was written. Check that OS-level encryption is working, then try again.",
      );
    }
  }

  function requireEncryption(what: string): void {
    if (safeStorage.isEncryptionAvailable()) return;
    log?.warn(
      `[secrets] refusing to store the ${what}: OS-level encryption is unavailable on this machine`,
    );
    throw new Error(
      "capygen: this machine has no OS-level encryption available, so the key cannot be stored safely. Nothing was written.",
    );
  }

  return {
    set(provider: ApiProvider, value: string): void {
      requireEncryption(`${provider} key`);
      const data = readForWrite(filePath);
      data[provider] = encrypt(value, `${provider} key`);
      writeFile(filePath, data);
    },

    has(provider: ApiProvider): boolean {
      return Boolean(readForQuery(filePath)[provider]);
    },

    /**
     * Decrypt, for the `api` harness alone (`ApiHarnessDeps.keys`). It never
     * crosses IPC — `secrets.has` is the renderer's only read — and a failed
     * decrypt returns null rather than throwing: on Windows DPAPI that means
     * the file was written by another user account, which is "no key here",
     * not a crash on every turn.
     */
    get(provider: ApiProvider): string | null {
      const stored = readForQuery(filePath)[provider];
      if (!stored) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        log?.warn(`[secrets] the stored ${provider} key could not be decrypted on this machine`);
        return null;
      }
    },

    delete(provider: ApiProvider): void {
      const data = readForWrite(filePath);
      if (!(provider in data)) return;
      delete data[provider];
      writeFile(filePath, data);
    },

    setRef(ref: McpSecretRef, value: string): void {
      assertRef(ref);
      requireEncryption("MCP secret");
      const data = readForWrite(filePath);
      const nested = { ...(data[MCP_NAMESPACE] ?? {}) };
      nested[refKey(ref)] = encrypt(value, "MCP secret");
      data[MCP_NAMESPACE] = nested;
      writeFile(filePath, data);
    },

    getRef(ref: McpSecretRef): string | null {
      assertRef(ref);
      const stored = readForQuery(filePath)[MCP_NAMESPACE]?.[refKey(ref)];
      if (!stored) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        // Never names the ref's value, and the ref itself stays out of the
        // message so nothing caller-supplied lands in the log.
        log?.warn("[secrets] a stored MCP secret could not be decrypted on this machine");
        return null;
      }
    },

    hasRef(ref: McpSecretRef): boolean {
      assertRef(ref);
      return Boolean(readForQuery(filePath)[MCP_NAMESPACE]?.[refKey(ref)]);
    },

    deleteRef(ref: McpSecretRef): void {
      assertRef(ref);
      const data = readForWrite(filePath);
      const nested = data[MCP_NAMESPACE];
      if (!nested || !(refKey(ref) in nested)) return;
      const next = { ...nested };
      delete next[refKey(ref)];
      data[MCP_NAMESPACE] = next;
      writeFile(filePath, data);
    },
  };
}
