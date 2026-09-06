/**
 * "Is Claude usable on this machine?" — asked once, the same way, by every
 * spec whose test spends real money on a Claude turn.
 *
 * `harnesses.spec.ts` and `roundtable.spec.ts` already did this per backend
 * (`harness.list` first, `test.skip` with the backend's own reason). The two
 * oldest live specs — `skeleton.spec.ts` and `widget.spec.ts` — did not, on
 * the assumption that a machine running them is signed in. That assumption
 * costs a 150 s timeout and a red suite on the machine where it is false, and
 * the failure it produces (`toHaveAttribute("data-status","done")` received
 * `"error"`) says nothing about the cause.
 *
 * The reason string comes from the app, not from here: `harness.list` →
 * `claudeSignInSignal` (`apps/desktop/src/ipc/harnessList.ts`), which knows
 * the difference between "no `claude` on PATH", "no login", "the credentials
 * file holds no token" (what a Claude Code host that refreshes auth out of
 * process leaves behind) and "the session has expired". A skip that quotes it
 * tells you exactly what to fix.
 *
 * This is not a `.spec.ts`, so Playwright does not collect it as a test file.
 */
import { test, type Page } from "@playwright/test";

export interface HarnessRow {
  backend: string;
  available: boolean;
  reason?: string;
}

/** Ask the app's own `harness.list` through the preload bridge. */
export async function harnessRows(page: Page): Promise<HarnessRow[]> {
  return page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
      }
    ).capygen;
    if (!bridge) throw new Error("preload bridge missing");
    return (await bridge.invoke("harness.list", {})) as HarnessRow[];
  });
}

/**
 * Skip the running test — with the backend's own sentence — unless Claude can
 * actually take a turn. Call it after the offline assertions a test makes, so
 * those still run on a machine with no login.
 */
export async function skipUnlessClaudeAvailable(page: Page): Promise<void> {
  const rows = await harnessRows(page);
  const claude = rows.find((row) => row.backend === "claude");
  test.skip(
    !claude?.available,
    `Claude cannot take a turn on this machine: ${
      claude?.reason ?? "harness.list reported no claude row"
    }`,
  );
}
