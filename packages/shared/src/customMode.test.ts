import { describe, expect, it } from "vitest";
import {
  canonicalCustomModeJson,
  parseCustomModeDocument,
  parseCustomModeJsonText,
  validateCrewAvailability,
  type CustomModeDocument,
} from "./customMode.js";

const fixture = {
  version: 1,
  title: "Astra crew",
  description: "A deterministic contract fixture",
  roster: [
    { id: "astra", label: "Astra", role: "lead", target: { backend: "codex", model: "astra", effort: "medium" }, instructions: "Lead every decision." },
    { id: "fable", label: "Fable", role: "member", target: { backend: "claude", model: "fable-5.1", effort: "medium" }, instructions: "Review core and major decisions." },
    { id: "design", label: "Design worker", role: "worker", target: { backend: "codex", model: "astra", effort: "low" }, instructions: "Shape the visual direction." },
    { id: "research", label: "Research worker", role: "worker", target: { backend: "codex", model: "luna", effort: "medium" }, instructions: "Find evidence." },
    { id: "dev", label: "Development worker", role: "worker", target: { backend: "claude", model: "opus-5", effort: "medium" }, instructions: "Implement hard and medium work." },
    { id: "text", label: "Text worker", role: "worker", target: { backend: "claude", model: "sonnet-5", effort: "medium" }, instructions: "Handle easy text work." },
  ],
  routing: [
    { id: "design-rule", taskKinds: ["design"], target: "design" },
    { id: "research-rule", taskKinds: ["research"], target: "research" },
    { id: "dev-rule", taskKinds: ["development"], difficulties: ["hard", "medium"], target: "dev" },
    { id: "text-rule", taskKinds: ["text"], difficulties: ["easy"], target: "text" },
  ],
  defaultWorker: "research",
  debate: { enabled: true, triggers: ["core", "major"], participants: ["fable"] },
} as const;

const capabilities = [
  { backend: "codex", model: "astra", efforts: ["low", "medium"] },
  { backend: "codex", model: "luna", efforts: ["medium"] },
  { backend: "claude", model: "fable-5.1", efforts: ["medium"] },
  { backend: "claude", model: "opus-5", efforts: ["medium"] },
  { backend: "claude", model: "sonnet-5", efforts: ["medium"] },
] as const;

describe("Custom Mode contract", () => {
  it("parses the exact crew fixture and canonicalizes with defaults", () => {
    const parsed = parseCustomModeDocument(fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.description).toBe(fixture.description);
    expect(parsed.document.roster.every((member) => member.instructions !== undefined)).toBe(true);
    expect(parseCustomModeDocument(JSON.parse(canonicalCustomModeJson(parsed.document)))).toEqual(parsed);
  });

  it("preserves omitted defaults and canonical ordering while retaining rule order", () => {
    const input = { ...fixture, description: undefined, routing: [fixture.routing[2], fixture.routing[0]] };
    const parsed = parseCustomModeDocument(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.description).toBe("");
    expect(parsed.document.debate.enabled).toBe(true);
    expect(parsed.document.routing.map((rule) => rule.id)).toEqual(["dev-rule", "design-rule"]);
    const canonical = canonicalCustomModeJson(parsed.document);
    expect(canonical.indexOf('"dev-rule"')).toBeLessThan(canonical.indexOf('"design-rule"'));
    expect(canonical).toContain("Lead every decision.");
  });

  it("bounds JSON text by UTF-8 bytes", () => {
    expect(parseCustomModeJsonText(JSON.stringify(fixture)).ok).toBe(true);
    expect(parseCustomModeJsonText("{" + "x".repeat(65_536) + "}").ok).toBe(false);
    expect(parseCustomModeJsonText("é".repeat(32_769)).ok).toBe(false);
  });

  it.each([
    ["duplicate lead", (d: any) => ({ ...d, roster: [...d.roster, { ...d.roster[0], id: "astra-2" }] }), "multiple-leads"],
    ["missing lead", (d: any) => ({ ...d, roster: d.roster.filter((m: any) => m.role !== "lead") }), "missing-lead"],
    ["duplicate id", (d: any) => ({ ...d, roster: [...d.roster, { ...d.roster[1] }] }), "duplicate-id"],
    ["dangling route", (d: any) => ({ ...d, routing: [{ ...d.routing[0], target: "ghost" }] }), "unknown-reference"],
    ["invalid route role", (d: any) => ({ ...d, routing: [{ ...d.routing[0], target: "fable" }] }), "not-a-worker"],
  ])("rejects %s", (_name, mutate, code) => {
    const result = parseCustomModeDocument(mutate(fixture));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toContain(code);
  });

  it.each(["executable", "nativeConfig"])("refuses unknown %s fields", (field) => {
    const result = parseCustomModeDocument({ ...fixture, [field]: {} });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.some((issue) => issue.code === "schema")).toBe(true);
  });

  it("reports unavailable targets without substituting them", () => {
    const parsed = parseCustomModeDocument(fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const issues = validateCrewAvailability(parsed.document, capabilities);
    expect(issues).toEqual([]);
    expect(validateCrewAvailability(parsed.document, capabilities.filter((c) => c.model !== "opus-5")))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "roster.4.target" })]));
  });

  it("rejects missing or empty effort capability and does not combine capability rows", () => {
    const parsed = parseCustomModeDocument(fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const missing = validateCrewAvailability(parsed.document, capabilities.filter((c) => c.model !== "opus-5"));
    expect(missing.some((issue) => issue.path === "roster.4.target")).toBe(true);
    const empty = validateCrewAvailability(parsed.document, capabilities.map((c) =>
      c.model === "sonnet-5" ? { ...c, efforts: [] } : c));
    expect(empty.some((issue) => issue.path === "roster.5.target")).toBe(true);
    const split = [
      { backend: "api", model: "split", efforts: ["low"], providers: ["anthropic"] },
      { backend: "api", model: "split", efforts: ["medium"], providers: ["openai"] },
    ] as const;
    const api = { ...parsed.document, roster: [{ ...parsed.document.roster[0], id: "api-lead", target: { backend: "api", model: "split", effort: "medium", provider: "anthropic" } }] } as unknown as CustomModeDocument;
    expect(validateCrewAvailability(api, split).some((issue) => issue.code === "unavailable-target")).toBe(true);
  });

  it("rejects oversized capability and bounded arrays", () => {
    const parsed = parseCustomModeDocument(fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateCrewAvailability(parsed.document, Array.from({ length: 4_097 }, () => capabilities[0]!))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unavailable-target" })]),
    );
    expect(parseCustomModeDocument({ ...fixture, routing: [{ id: "r", taskKinds: Array(7).fill("design"), target: "design" }] }).ok).toBe(false);
    expect(parseCustomModeDocument({ ...fixture, debate: { ...fixture.debate, triggers: ["core", "major", "core"] } }).ok).toBe(false);
  });
});
