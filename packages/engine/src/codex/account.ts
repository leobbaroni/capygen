/**
 * "Is Codex usable right now?" — the availability probe behind `harness.list`.
 *
 * Why this and not `codex login status`: on this machine that command printed
 * `Logged in using ChatGPT` while **every** model call 401'd, because it only
 * checks that `~/.codex/auth.json` exists (docs/spikes/codex-shapes.md §3).
 * `account/read {refreshToken: true}` forces the refresh instead, so it is the
 * one call that distinguishes "signed in" from "there is a dead token on disk",
 * and the spike log names it as the probe the setup panel should use.
 *
 * The cost is one short-lived `codex app-server` child, so the result is
 * cached: the app asks on start-up and whenever Settings ▸ Harnesses is
 * refreshed, not per keystroke.
 */
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./CodexAppServerClient.js";
import { CODEX_METHODS, type CodexModel, type CodexModelListResponse } from "./protocol.js";

/** What `account/read` reports; `account: null` means "not signed in". */
export interface CodexAccountInfo {
  type?: string;
  email?: string;
  planType?: string;
}

export interface CodexProbeResult {
  /** True only when the account refreshed — a dead token reports false. */
  signedIn: boolean;
  /** Present when signed in and the server named the account. */
  account?: CodexAccountInfo;
  /** The catalogue `model/list` returned; empty when the probe failed. */
  models: CodexModel[];
  /** Which binary answered, and where it came from (bundled / PATH / …). */
  binary?: { exe: string; source: string };
  /** Why the probe could not say "signed in". Never contains a token. */
  reason?: string;
}

export interface ProbeCodexOptions extends CodexAppServerClientOptions {
  /** Overall deadline for the whole probe, child spawn included. */
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Never throws: an unavailable backend is a `HarnessInfo` row with a reason,
 * not an IPC error that blanks the whole picker.
 */
export async function probeCodex(options: ProbeCodexOptions = {}): Promise<CodexProbeResult> {
  const { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, ...clientOptions } = options;
  let client: CodexAppServerClient | null = null;
  try {
    client = new CodexAppServerClient({ ...clientOptions, requestTimeoutMs: timeoutMs });
  } catch (err) {
    // `resolveCodexBinary` throws when there is no codex.exe anywhere.
    return { signedIn: false, models: [], reason: describe(err) };
  }
  const binary = { exe: client.binary.exe, source: client.binary.source };

  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the codex app-server did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    await Promise.race([client.start(), deadline]);
    const account = await Promise.race([
      client.request<{ account: CodexAccountInfo | null }>(
        CODEX_METHODS.accountRead,
        { refreshToken: true },
        timeoutMs,
      ),
      deadline,
    ]);
    if (!account?.account) {
      return {
        signedIn: false,
        models: [],
        binary,
        reason: "Codex is not signed in — run `codex login` in a terminal",
      };
    }
    // Only worth asking once we know the account is live; a signed-out server
    // answers this one from a stale local catalogue and would look healthy.
    const models = await Promise.race([
      client
        .request<CodexModelListResponse>(CODEX_METHODS.modelList, {}, timeoutMs)
        .catch(() => ({ data: [] as CodexModel[] })),
      deadline,
    ]);
    return { signedIn: true, account: account.account, models: models?.data ?? [], binary };
  } catch (err) {
    const message = describe(err);
    const stderr = client.recentStderr();
    return {
      signedIn: false,
      models: [],
      binary,
      reason: stderr ? `${message} (${stderr.split("\n").slice(-1)[0] ?? ""})` : message,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
