import { describe, expect, it } from "vitest";
import {
  enumLabel,
  enumValues,
  initialValue,
  isComplete,
  schemaFields,
  toContent,
  type ElicitationDraft,
} from "./elicitationForm";

const SCHEMA = {
  properties: {
    branch: { type: "string", title: "Branch", description: "Git branch" },
    channel: { type: "string", enum: ["stable", "beta"], enumNames: ["Stable", "Beta"], default: "stable" },
    dryRun: { type: "boolean" },
    retries: { type: "integer", default: 3 },
  },
  required: ["branch"],
};

describe("schemaFields", () => {
  it("reads properties into an ordered field list, marking required ones", () => {
    const fields = schemaFields(SCHEMA);
    expect(fields.map((f) => f.name)).toEqual(["branch", "channel", "dryRun", "retries"]);
    expect(fields.find((f) => f.name === "branch")?.required).toBe(true);
    expect(fields.find((f) => f.name === "channel")?.required).toBe(false);
  });

  it("returns [] for a schema with no properties, or nothing schema-shaped at all", () => {
    expect(schemaFields(null)).toEqual([]);
    expect(schemaFields(undefined)).toEqual([]);
    expect(schemaFields("not an object")).toEqual([]);
    expect(schemaFields({ properties: {} })).toEqual([]);
    // Codex's own (non-MCP) shape — not implemented, reads as a bare prompt.
    expect(schemaFields({ fields: [{ name: "x" }] })).toEqual([]);
  });
});

describe("initialValue", () => {
  it("starts at the schema's default", () => {
    const [, channel] = schemaFields(SCHEMA);
    expect(initialValue(channel!)).toBe("stable");
  });

  it("starts a boolean with no default at undefined, not false", () => {
    const [, , dryRun] = schemaFields(SCHEMA);
    expect(initialValue(dryRun!)).toBeUndefined();
  });

  it("starts a plain field at an empty string", () => {
    const [branch] = schemaFields(SCHEMA);
    expect(initialValue(branch!)).toBe("");
  });
});

describe("enumValues / enumLabel", () => {
  it("reads the enum members and pairs them with enumNames", () => {
    const [, channel] = schemaFields(SCHEMA);
    const values = enumValues(channel!.prop);
    expect(values).toEqual(["stable", "beta"]);
    expect(enumLabel(channel!.prop, 0, "stable")).toBe("Stable");
    expect(enumLabel(channel!.prop, 1, "beta")).toBe("Beta");
  });

  it("falls back to the raw value with no enumNames", () => {
    const prop = { enum: ["a", "b"] };
    expect(enumLabel(prop, 0, "a")).toBe("a");
  });
});

describe("isComplete / toContent", () => {
  const fields = schemaFields(SCHEMA);

  it("is incomplete while a required field is blank", () => {
    const draft: ElicitationDraft = { branch: "", channel: "stable", dryRun: undefined, retries: 3 };
    expect(isComplete(fields, draft)).toBe(false);
  });

  it("is complete once the required field has a value; optional ones may stay blank", () => {
    const draft: ElicitationDraft = { branch: "main", channel: "", dryRun: undefined, retries: 3 };
    expect(isComplete(fields, draft)).toBe(true);
  });

  it("a boolean is always answered, false included", () => {
    const draft: ElicitationDraft = { branch: "main", dryRun: false };
    expect(isComplete(fields, draft)).toBe(true);
  });

  it("rejects an unparseable number in a numeric field", () => {
    const draft: ElicitationDraft = { branch: "main", retries: "not a number" as unknown as number };
    expect(isComplete(fields, draft)).toBe(false);
  });

  it("drops blank optional fields and coerces numbers, dropping unset ones entirely", () => {
    const draft: ElicitationDraft = { branch: "main", channel: "", dryRun: true, retries: "5" };
    expect(toContent(fields, draft)).toEqual({ branch: "main", dryRun: true, retries: 5 });
  });
});
