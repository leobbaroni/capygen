/**
 * Zod runtime configuration — imported for its side effect before any schema in
 * this package is constructed.
 *
 * Why: zod 4 JIT-compiles validators with `new Function`. capygen's renderer
 * runs under a strict Content-Security-Policy (`script-src 'self'`, see
 * apps/renderer/index.html) and Electron applies that policy to the preload's
 * isolated world too, so the first `parse()` on either side of the bridge threw
 *
 *   Error: Code generation from strings disallowed for this context
 *
 * `jitless` swaps the compiled validators for interpreted ones. The cost is
 * parse throughput on payloads that are already small; the alternative —
 * allowing `'unsafe-eval'` in the CSP so a bundled dependency can build
 * functions from strings — is not a trade capygen should make.
 *
 * Set once, here, so main, preload, renderer and tests all agree.
 */
import { z } from "zod";

z.config({ jitless: true });

/** Re-exported so a caller can assert the configuration is in force. */
export const ZOD_JITLESS = true;
