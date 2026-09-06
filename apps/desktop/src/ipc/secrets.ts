/**
 * `SecretsStore` backed by Electron `safeStorage` (R21 — "store it with
 * Electron safeStorage (Windows DPAPI) and never write it to plain files or
 * logs"). Kept separate from `handlers.ts` (which stays Electron-free on
 * purpose, per that file's own header) so the rest of the IPC layer is still
 * unit-testable against a temp SQLite store with no Electron in the process.
 *
 * On disk this writes exactly one small JSON file mapping provider → base64
 * ciphertext. `safeStorage.decryptString` is the only way back to plaintext,
 * and on Windows that only succeeds for the same user account that encrypted
 * it — so the file is useless to anyone who merely copies it.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiProvider } from "@capygen/shared";
import type { SecretsStore } from "./handlers.js";

/** The slice of Electron's `safeStorage` this file needs — narrowed so a test
 *  can supply a fake without importing Electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

type SecretsFile = Partial<Record<ApiProvider, string>>;

function readFile(file: string): SecretsFile {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SecretsFile) : {};
  } catch {
    // Missing file (first run) or corrupt JSON: either way, "no keys stored"
    // is the safe reading — never throw just because nothing has been set yet.
    return {};
  }
}

function writeFile(file: string, data: SecretsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
}

export interface SafeStorageSecretsStoreDeps {
  safeStorage: SafeStorageLike;
  /** Where the ciphertext map is written, e.g. `<userData>/secrets.json`. */
  filePath: string;
  log?: { warn: (message: string) => void };
}

/**
 * `set` refuses outright when OS-level encryption is unavailable rather than
 * falling back to plaintext — a silent plaintext fallback is exactly the R21
 * failure this store exists to prevent. `has`/`delete` never touch
 * `safeStorage` at all, so they still work (read the shape of what's stored,
 * remove an entry) even on a machine where encryption is unavailable.
 */
export function createSafeStorageSecretsStore(deps: SafeStorageSecretsStoreDeps): SecretsStore {
  const { safeStorage, filePath, log } = deps;

  return {
    set(provider: ApiProvider, value: string): void {
      if (!safeStorage.isEncryptionAvailable()) {
        log?.warn(
          `[secrets] refusing to store the ${provider} key: OS-level encryption is unavailable on this machine`,
        );
        throw new Error(
          "capygen: this machine has no OS-level encryption available, so the key cannot be stored safely. Nothing was written.",
        );
      }
      const data = readFile(filePath);
      data[provider] = safeStorage.encryptString(value).toString("base64");
      writeFile(filePath, data);
    },

    has(provider: ApiProvider): boolean {
      return Boolean(readFile(filePath)[provider]);
    },

    /**
     * Decrypt, for the `api` harness alone (`ApiHarnessDeps.keys`). It never
     * crosses IPC — `secrets.has` is the renderer's only read — and a failed
     * decrypt returns null rather than throwing: on Windows DPAPI that means
     * the file was written by another user account, which is "no key here",
     * not a crash on every turn.
     */
    get(provider: ApiProvider): string | null {
      const stored = readFile(filePath)[provider];
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
      const data = readFile(filePath);
      if (!(provider in data)) return;
      delete data[provider];
      writeFile(filePath, data);
    },
  };
}
