/**
 * Run-level isolation, applied before any worker starts.
 *
 * `launchEnv` already isolates every launch this suite owns, but two things
 * need a process-wide default as well:
 *
 *  - **specs that build their own environment.** Setting the isolation
 *    variables on the runner process means anything reading `process.env`
 *    inherits safe homes rather than the developer's.
 *  - **anything the app or a child reads before a spec runs.** A stray
 *    `claude` or `codex` probe started from an inherited environment sees the
 *    isolated homes.
 *
 * Playwright forks its workers from this process, so the assignments here are
 * inherited by every spec.
 *
 * **Teardown is a closure, not an environment variable.** Returning the
 * cleanup function from `globalSetup` is Playwright's documented contract, and
 * it is the safe one: the closure captures the exact `mkdtemp` path this
 * function created, so nothing else can point it at another directory. The
 * previous version wrote the path into `CAPYGEN_E2E_RUN_HOMES_ROOT` and had a
 * separate `globalTeardown` `rm -rf` whatever it found there — which meant a
 * pre-existing value in the developer's shell was trusted and deleted, and in
 * dedicated-identity mode setup never set the variable at all, so a stale one
 * would survive and be removed. A dedicated home is never deleted here: the
 * closure only ever knows about a directory this run made.
 */
import { backendHomes, PERSONAL_KEY_ENV, usingDedicatedIdentity } from "./testPolicy.js";

export default function globalSetup(): () => void {
  const homes = backendHomes("run");
  process.env.CAPYGEN_CLAUDE_CONFIG_DIR = homes.claudeHome;
  process.env.CAPYGEN_CODEX_HOME = homes.codexHome;
  // Also the variables the CLIs themselves read, so a child spawned from an
  // inherited environment cannot fall back to the personal home either.
  process.env.CLAUDE_CONFIG_DIR = homes.claudeHome;
  process.env.CODEX_HOME = homes.codexHome;

  const dedicated = usingDedicatedIdentity();
  if (!dedicated) {
    // An ordinary offline run must not be able to spend a personal key.
    for (const key of PERSONAL_KEY_ENV) delete process.env[key];
  }

  console.log(
    `[e2e] backend homes: ${
      dedicated
        ? "dedicated test identity (persistent, separately signed in)"
        : "disposable isolated homes (offline; live tests skip)"
    }`,
  );
  console.log(`[e2e]   CLAUDE_CONFIG_DIR=${homes.claudeHome}`);
  console.log(`[e2e]   CODEX_HOME=${homes.codexHome}`);

  // `homes.cleanup` is already a no-op for a dedicated identity; the
  // `dedicated` guard makes that explicit rather than trusting it.
  return () => {
    if (dedicated) return;
    homes.cleanup();
  };
}
