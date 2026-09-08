/**
 * S0: MCP secret refs in the `safeStorage`-backed secrets store.
 *
 * The fake `safeStorage` below is the only thing faked — the file writing is
 * real, against a temp directory, because the properties under test are all
 * about what ends up on disk (no plaintext, no clobbering, no partial writes).
 * Nothing here reads or writes the user's real config (`~/.claude`, `~/.codex`)
 * or `<userData>`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSafeStorageSecretsStore,
  isMcpSecretRef,
  newMcpSecretRef,
  type SafeStorageLike,
} from "../src/ipc/secrets.js";

const temps: string[] = [];

it("isolates updater ciphertext from provider and MCP namespaces", () => {
  const filePath = tempFile();
  const { safeStorage } = fakeSafeStorage();
  const store = createSafeStorageSecretsStore({ filePath, safeStorage });
  store.set("anthropic", "provider-fixture");
  const ref = newMcpSecretRef(); store.setRef(ref, "mcp-fixture");
  store.setUpdaterToken("updater-fixture");
  expect(fs.readFileSync(filePath, "utf8")).not.toContain("updater-fixture");
  expect(store.getUpdaterToken()).toBe("updater-fixture");
  expect(store.hasUpdaterToken()).toBe(true);
  store.deleteUpdaterToken();
  expect(store.getUpdaterToken()).toBeNull();
  expect(store.get("anthropic")).toBe("provider-fixture");
  expect(store.getRef(ref)).toBe("mcp-fixture");
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-secrets-"));
  temps.push(dir);
  return path.join(dir, "secrets.json");
}

/**
 * Stands in for Electron's DPAPI-backed `safeStorage`. "Encryption" is a
 * reversible byte transform — enough to prove the plaintext is not what lands
 * on disk, and to let a test flip `available` or make decryption fail.
 */
function fakeSafeStorage(options: { available?: boolean; decryptThrows?: boolean } = {}) {
  const state = { available: options.available ?? true, decryptThrows: options.decryptThrows ?? false };
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => state.available,
    encryptString: (plainText) => {
      const bytes = Buffer.from(plainText, "utf8");
      return Buffer.concat([Buffer.from("v1:", "utf8"), bytes.map((b) => b ^ 0x5a)]);
    },
    decryptString: (encrypted) => {
      if (state.decryptThrows) throw new Error("decrypt failed");
      const body = encrypted.subarray(3);
      return Buffer.from(body.map((b) => b ^ 0x5a)).toString("utf8");
    },
  };
  return { safeStorage, state };
}

const REF_A = "mcp/0123456789abcdef0123456789abcdef";
const REF_B = "mcp/fedcba9876543210fedcba9876543210";

const INVALID_REFS = [
  "",
  "mcp/",
  "0123456789abcdef0123456789abcdef",
  "mcp/0123456789ABCDEF0123456789ABCDEF", // uppercase hex
  "mcp/0123456789abcdef0123456789abcde", // 31 chars
  "mcp/0123456789abcdef0123456789abcdef0", // 33 chars
  "mcp/0123456789abcdef0123456789abcdeg", // non-hex
  "mcp/../../etc/passwd",
  "mcp/0123456789abcdef0123456789abcdef/../x",
  "anthropic",
];

describe("MCP secret ref grammar", () => {
  it("accepts only `mcp/<32 lowercase hex>`", () => {
    expect(isMcpSecretRef(REF_A)).toBe(true);
    for (const ref of INVALID_REFS) expect(isMcpSecretRef(ref)).toBe(false);
    expect(isMcpSecretRef(undefined)).toBe(false);
    expect(isMcpSecretRef(42)).toBe(false);
  });

  it("mints refs that match the grammar and do not repeat", () => {
    const refs = new Set(Array.from({ length: 64 }, () => newMcpSecretRef()));
    expect(refs.size).toBe(64);
    for (const ref of refs) expect(isMcpSecretRef(ref)).toBe(true);
  });
});

describe("createSafeStorageSecretsStore — MCP refs", () => {
  it("round-trips a value without writing the plaintext to disk", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    const secret = "super-secret-mcp-token-8f3a";
    store.setRef(REF_A, secret);

    expect(store.getRef(REF_A)).toBe(secret);
    expect(store.hasRef(REF_A)).toBe(true);

    const bytes = fs.readFileSync(file);
    expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
    expect(bytes.toString("utf8")).not.toContain(secret);
  });

  it("reads as absent when nothing is stored", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    expect(store.hasRef(REF_A)).toBe(false);
    expect(store.getRef(REF_A)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps provider keys and MCP refs side by side in one file", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.set("anthropic", "sk-ant-provider");
    store.setRef(REF_A, "mcp-value-a");
    store.set("openai", "sk-openai-provider");
    store.setRef(REF_B, "mcp-value-b");

    // Providers round-trip exactly as they did before S0…
    expect(store.get("anthropic")).toBe("sk-ant-provider");
    expect(store.get("openai")).toBe("sk-openai-provider");
    expect(store.has("anthropic")).toBe(true);
    expect(store.has("openrouter")).toBe(false);
    // …and the refs are untouched by the provider writes.
    expect(store.getRef(REF_A)).toBe("mcp-value-a");
    expect(store.getRef(REF_B)).toBe("mcp-value-b");

    // Provider keys stay at the top level (backwards compatible), MCP
    // ciphertext lives under its own namespace.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["anthropic", "mcp", "openai"]);
    expect(typeof parsed.anthropic).toBe("string");
    expect(Object.keys(parsed.mcp as Record<string, string>).sort()).toEqual(
      [REF_A.slice(4), REF_B.slice(4)].sort(),
    );
  });

  it("reads a pre-S0 file with only provider keys, then adds a ref to it", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    // Exactly the shape Phase 6 wrote.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ anthropic: safeStorage.encryptString("legacy-key").toString("base64") }),
      "utf8",
    );

    expect(store.get("anthropic")).toBe("legacy-key");
    store.setRef(REF_A, "added-later");
    expect(store.get("anthropic")).toBe("legacy-key");
    expect(store.getRef(REF_A)).toBe("added-later");
  });

  it("refuses every operation on a malformed ref, and writes nothing", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.setRef(REF_A, "keep-me");
    const before = fs.readFileSync(file);

    for (const bad of INVALID_REFS) {
      expect(() => store.setRef(bad, "nope")).toThrow(/valid MCP secret ref/);
      expect(() => store.getRef(bad)).toThrow(/valid MCP secret ref/);
      expect(() => store.hasRef(bad)).toThrow(/valid MCP secret ref/);
      expect(() => store.deleteRef(bad)).toThrow(/valid MCP secret ref/);
    }

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(store.getRef(REF_A)).toBe("keep-me");
    // A rejected ref never reaches the error text (it can land in a log).
    expect(() => store.setRef("mcp/../../etc/passwd", "x")).toThrow(
      /^capygen: not a valid MCP secret ref\.$/,
    );
  });

  it("replaces one ref and deletes another without disturbing the rest", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.set("anthropic", "provider-key");
    store.setRef(REF_A, "first");
    store.setRef(REF_B, "other");

    store.setRef(REF_A, "second");
    expect(store.getRef(REF_A)).toBe("second");
    expect(store.getRef(REF_B)).toBe("other");
    expect(store.get("anthropic")).toBe("provider-key");
    expect(fs.readFileSync(file, "utf8")).not.toContain("first");

    store.deleteRef(REF_A);
    expect(store.hasRef(REF_A)).toBe(false);
    expect(store.getRef(REF_A)).toBeNull();
    expect(store.getRef(REF_B)).toBe("other");
    expect(store.get("anthropic")).toBe("provider-key");

    // Deleting something that is not there is a no-op, not a rewrite.
    const before = fs.readFileSync(file);
    store.deleteRef(REF_A);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("deleting a provider key leaves the MCP refs alone, and vice versa", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.set("anthropic", "provider-key");
    store.setRef(REF_A, "ref-value");

    store.delete("anthropic");
    expect(store.has("anthropic")).toBe(false);
    expect(store.getRef(REF_A)).toBe("ref-value");

    store.set("anthropic", "provider-key");
    store.deleteRef(REF_A);
    expect(store.get("anthropic")).toBe("provider-key");
    expect(store.hasRef(REF_A)).toBe(false);
  });

  it("refuses to store a ref when OS encryption is unavailable, and never touches the file", () => {
    const file = tempFile();
    const { safeStorage, state } = fakeSafeStorage();
    const warnings: string[] = [];
    const store = createSafeStorageSecretsStore({
      safeStorage,
      filePath: file,
      log: { warn: (message) => warnings.push(message) },
    });

    store.setRef(REF_A, "the-only-value");
    const before = fs.readFileSync(file);

    state.available = false;
    expect(() => store.setRef(REF_A, "replacement")).toThrow(/no OS-level encryption/);
    expect(() => store.setRef(REF_B, "brand-new")).toThrow(/no OS-level encryption/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);

    // Presence is answerable without encryption; the value is not.
    expect(store.hasRef(REF_A)).toBe(true);
    expect(store.getRef(REF_A)).toBeNull();

    // Refusal is about storing a new or replacement value. Removing an
    // explicitly named ref needs no encryption and must still work.
    state.available = true;
    store.setRef(REF_B, "second");
    state.available = false;
    store.deleteRef(REF_B);
    expect(store.hasRef(REF_B)).toBe(false);
    store.delete("openai");

    state.available = true;
    expect(store.getRef(REF_A)).toBe("the-only-value");
    expect(warnings.join("\n")).not.toContain("the-only-value");
    expect(warnings.join("\n")).not.toContain("replacement");
  });

  it("returns null, not a throw, when the ciphertext cannot be decrypted", () => {
    const file = tempFile();
    const { safeStorage, state } = fakeSafeStorage();
    const warnings: string[] = [];
    const store = createSafeStorageSecretsStore({
      safeStorage,
      filePath: file,
      log: { warn: (message) => warnings.push(message) },
    });

    store.setRef(REF_A, "another-user-wrote-this");
    state.decryptThrows = true;

    expect(store.getRef(REF_A)).toBeNull();
    // Presence is ciphertext-only, so it still says yes.
    expect(store.hasRef(REF_A)).toBe(true);
    expect(warnings.join("\n")).not.toContain("another-user-wrote-this");
    expect(warnings.join("\n")).not.toContain(REF_A);
  });

  it("refuses to mutate a corrupt file and preserves its bytes exactly", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const garbage = Buffer.from('{"anthropic": "unterminated', "utf8");
    fs.writeFileSync(file, garbage);

    expect(() => store.setRef(REF_A, "value")).toThrow(/left untouched/);
    expect(() => store.deleteRef(REF_A)).toThrow(/left untouched/);
    expect(() => store.set("anthropic", "value")).toThrow(/left untouched/);
    expect(fs.readFileSync(file).equals(garbage)).toBe(true);

    // Queries still answer "nothing stored" rather than throwing every turn.
    expect(store.hasRef(REF_A)).toBe(false);
    expect(store.getRef(REF_A)).toBeNull();
    expect(store.has("anthropic")).toBe(false);
    expect(store.get("anthropic")).toBeNull();

    // A well-formed JSON file whose `mcp` namespace is the wrong shape counts
    // as corrupt too — better to refuse than to overwrite someone's data.
    const wrongShape = Buffer.from(JSON.stringify({ mcp: { a: 1 } }), "utf8");
    fs.writeFileSync(file, wrongShape);
    expect(() => store.setRef(REF_A, "value")).toThrow(/left untouched/);
    expect(fs.readFileSync(file).equals(wrongShape)).toBe(true);
  });

  it("keeps the previous file and leaves no temp behind when the write fails", () => {
    const file = tempFile();
    const dir = path.dirname(file);
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.set("anthropic", "provider-key");
    store.setRef(REF_A, "original");
    const before = fs.readFileSync(file);
    const filesBefore = fs.readdirSync(dir).sort();

    // Make the rename step fail: a directory at the destination cannot be
    // replaced by a file, so the temp write succeeds and the swap does not.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    const blockedStore = createSafeStorageSecretsStore({ safeStorage, filePath: blocked });
    expect(() => blockedStore.setRef(REF_B, "never-lands")).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual([...filesBefore, "blocked.json"].sort());
    expect(fs.readdirSync(blocked)).toEqual([]);

    // The real store's file is exactly as it was, and still readable.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(store.getRef(REF_A)).toBe("original");
    expect(store.get("anthropic")).toBe("provider-key");
    expect(store.hasRef(REF_B)).toBe(false);
  });
});

describe("createSafeStorageSecretsStore — the file is never overwritten blind", () => {
  it("refuses every mutation when the existing file cannot be read (EIO), even though writing would work", () => {
    const file = tempFile();
    const dir = path.dirname(file);
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.set("anthropic", "provider-key");
    store.setRef(REF_A, "ref-value");
    const before = fs.readFileSync(file);
    const filesBefore = fs.readdirSync(dir).sort();

    // Only reading this one path fails; the directory is still perfectly
    // writable, so nothing but the refusal stops a mutation here.
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (target === file) {
        const error = new Error("EIO: i/o error, read") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFileSync);

    expect(() => store.set("openai", "new-key")).toThrow(/left untouched/);
    expect(() => store.setRef(REF_B, "new-ref")).toThrow(/left untouched/);
    expect(() => store.delete("anthropic")).toThrow(/left untouched/);
    expect(() => store.deleteRef(REF_A)).toThrow(/left untouched/);

    // Queries stay non-throwing, but they must not claim anything is stored.
    expect(store.has("anthropic")).toBe(false);
    expect(store.hasRef(REF_A)).toBe(false);

    vi.restoreAllMocks();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(filesBefore);
    expect(store.get("anthropic")).toBe("provider-key");
    expect(store.getRef(REF_A)).toBe("ref-value");
  });

  it("refuses to mutate when a known entry has the wrong type or an MCP id is malformed", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const rejected = [
      { anthropic: 123 },
      { anthropic: null },
      { openai: { nested: "object" } },
      { mcp: { "not-a-hex-id": "Y2lwaGVy" } },
      { mcp: { "0123456789ABCDEF0123456789ABCDEF": "Y2lwaGVy" } },
      { mcp: { "0123456789abcdef0123456789abcdef": 7 } },
      { mcp: ["0123456789abcdef0123456789abcdef"] },
    ];

    for (const shape of rejected) {
      const bytes = Buffer.from(JSON.stringify(shape), "utf8");
      fs.writeFileSync(file, bytes);
      expect(() => store.setRef(REF_A, "value")).toThrow(/left untouched/);
      expect(() => store.deleteRef(REF_A)).toThrow(/left untouched/);
      expect(() => store.set("anthropic", "value")).toThrow(/left untouched/);
      expect(() => store.delete("anthropic")).toThrow(/left untouched/);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    }
  });

  it("preserves unknown top-level keys written by a future version", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });
    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(
      file,
      JSON.stringify({
        anthropic: safeStorage.encryptString("legacy-key").toString("base64"),
        somethingFromLater: { keep: ["me", 1, true] },
      }),
      "utf8",
    );

    store.setRef(REF_A, "ref-value");
    store.delete("anthropic");

    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(parsed.somethingFromLater).toEqual({ keep: ["me", 1, true] });
    expect(store.getRef(REF_A)).toBe("ref-value");
  });
});

describe("createSafeStorageSecretsStore — an encryption failure never leaks the plaintext", () => {
  it("wraps an encryptString error that quotes the secret, and leaves the file alone", () => {
    const file = tempFile();
    const secret = "leaky-secret-value-91af";
    const warnings: string[] = [];
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      // Exactly the hazard: a platform (or injected) error carrying the
      // plaintext it was handed.
      encryptString: (plainText) => {
        throw new Error(`DPAPI failed while encrypting "${plainText}"`);
      },
      decryptString: () => {
        throw new Error("unused");
      },
    };
    const store = createSafeStorageSecretsStore({
      safeStorage,
      filePath: file,
      log: { warn: (message) => warnings.push(message) },
    });

    for (const mutate of [
      () => store.setRef(REF_A, secret),
      () => store.set("anthropic", secret),
    ]) {
      let caught: unknown;
      try {
        mutate();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toContain(secret);
      expect(message).toMatch(/could not encrypt the secret, so nothing was written/);
      // The stack can carry the original message through `cause`; there is none.
      expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(secret);
    }

    expect(warnings.join("\n")).not.toContain(secret);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("createSafeStorageSecretsStore — temp files", () => {
  it("never truncates a colliding temp file, and leaves it where it is", () => {
    const file = tempFile();
    const dir = path.dirname(file);
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.setRef(REF_A, "original");
    const before = fs.readFileSync(file);

    // Force every attempt onto one predictable temp name, then occupy it.
    vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) =>
      Buffer.alloc(size, 0xab)) as unknown as typeof crypto.randomBytes);
    const temp = path.join(dir, `.${path.basename(file)}.${"ab".repeat(6)}.tmp`);
    const squatter = Buffer.from("someone else's file", "utf8");
    fs.writeFileSync(temp, squatter);

    expect(() => store.setRef(REF_B, "never-lands")).toThrow();
    vi.restoreAllMocks();

    // The squatter is intact (never opened for truncation, never deleted)…
    expect(fs.readFileSync(temp).equals(squatter)).toBe(true);
    // …and so is the real file.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(store.getRef(REF_A)).toBe("original");
    expect(store.hasRef(REF_B)).toBe(false);
  });

  it("leaves the stored file readable only by the owner where the OS enforces it", () => {
    const file = tempFile();
    const { safeStorage } = fakeSafeStorage();
    const store = createSafeStorageSecretsStore({ safeStorage, filePath: file });

    store.setRef(REF_A, "value");

    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // On every platform: what landed is JSON of base64 ciphertext, nothing else.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcp: Record<string, string> };
    expect(Object.values(parsed.mcp).every((v) => typeof v === "string")).toBe(true);
  });
});
