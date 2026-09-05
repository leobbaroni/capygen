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
