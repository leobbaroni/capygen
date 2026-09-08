/**
 * `SETTINGS_SECTIONS` is the flat source of truth `SettingsPage`'s nav and
 * its own test both read — this asserts the full id list SPEC R19 (plus
 * Task B2's two named additions, Tools and Prerequisites) requires, so a
 * section silently dropped from a nav group fails here first.
 */
import { describe, expect, it } from "vitest";
import { findSettingsSection, SETTINGS_NAV_GROUPS, SETTINGS_SECTIONS } from "./settingsNav";

const EXPECTED_IDS = [
  "general",
  "appearance",
  "git",
  "shortcuts",
  "import",
  "account",
  "harnesses",
  "mcp",
  "skills",
  "plugins",
  "tools",
  "api-keys",
  "dev-servers",
  "prereqs",
  "diagnostics",
  "cli",
  "updates",
  "members",
  "policies",
  "sharing",
  "archived",
];

describe("SETTINGS_SECTIONS", () => {
  it("lists exactly the expected ids, each exactly once, in nav order", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(EXPECTED_IDS);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("every group's items round-trip into the flat list unchanged", () => {
    const flattened = SETTINGS_NAV_GROUPS.flatMap((g) => g.items);
    expect(flattened).toEqual(SETTINGS_SECTIONS);
  });

  it("every section has a non-empty label and an icon component", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.icon).toBeTypeOf("object");
    }
  });
});

describe("findSettingsSection", () => {
  it("resolves a known id", () => {
    expect(findSettingsSection("harnesses").label).toBe("Harnesses");
  });

  it("falls back to the first section (General) for an unknown or undefined id", () => {
    expect(findSettingsSection("bogus").id).toBe("general");
    expect(findSettingsSection(undefined).id).toBe("general");
  });
});
