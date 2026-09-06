/** `agents.describe` (SPEC R13) — composition helpers plus Codex's describe
 *  function (see `./codex.ts`'s header for why it lives here and not next to
 *  `CodexHarness.ts`). Claude's and the API loop's own `describe.ts` sit next
 *  to their harnesses and are re-exported from the package root directly. */
export * from "./types.js";
export * from "./codex.js";
