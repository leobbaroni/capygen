/**
 * vitest setup for the "renderer" project (vitest.config.ts): registers
 * @testing-library/jest-dom's matchers (`toBeInTheDocument`, `toBeDisabled`, …)
 * on vitest's `expect`, and cleans up the jsdom tree between tests so one
 * component test can't leak DOM nodes into the next.
 */
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom's `Range` has no `getClientRects`/`getBoundingClientRect` at all
// (not even a zero-rect stub) — CodeMirror 6's measure loop calls both every
// time it lays out (`EditorPane`, Phase 5), logging a caught-but-noisy
// `TypeError` to the console on every test. A real browser always has both;
// this only fills the jsdom gap so those tests read clean, it changes no
// component's behaviour (CM6 already tolerates a zero-size measurement).
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
  };
}
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  };
}
