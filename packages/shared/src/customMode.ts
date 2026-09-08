/**
 * Custom Mode's crew document (SPEC R33–R34, ADR-0006, `docs/plans/phase9c-execution.md`).
 *
 * One strict, versioned, declarative JSON document is the single authority for
 * a custom session's crew. The visual editor and the text editor are two
 * projections of *this* object, so anything either view can express has to live
 * here — a field only one of them understands is a field the other silently
 * drops on save.
 *
 * Four properties the shape is built around:
 *
 *  - **Declarative only.** No JavaScript, no expressions, no executable policy.
 *    A rule matches on a bounded vocabulary and names a roster entry; that is
 *    the entire language, and it is deliberately not extensible by a draft.
 *  - **Nothing native.** A target names a backend, a model and an effort — and,
 *    for `api`, its provider. It carries no permission mode, sandbox, tool
 *    list, MCP server, environment or config passthrough: a crew document must
 *    not become a second way to widen what an agent may do, and ADR-0007's
 *    boundaries stay the only place that is decided.
 *  - **Availability is not structure.** Whether `claude-opus-5` exists today is
 *    a question about the live catalogue, not about this document, so it is a
 *    separate pass against a caller-supplied roster. Nothing here hardcodes a
 *    model alias or reaches for a provider, and a document that parses is not
 *    thereby runnable.
 *  - **Fail visibly.** Unknown fields, duplicate ids, dangling references and
 *    malformed assignments are reported, never repaired. A draft with errors
 *    stays an editable draft (ADR-0006); it does not become a quietly-corrected
 *    policy.
 *
 * Session hop caps and budgets are deliberately **absent**: they belong to the
 * session (ADR-0002 R11), and a crew document that could raise its own hop
 * limit would be a way to escape them. A debate is bounded by the session's
 * remaining hops at dispatch time, not by anything written here.
 *
 * Shared by policy editors and pure routing planners. Desktop activation validates
 * availability and permissions separately before dispatch.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

/** The only document version this build understands. */
export const CUSTOM_MODE_VERSION = 1;

export const CREW_MAX_ROSTER = 16;
export const CREW_MAX_ROUTING_RULES = 64;
export const CREW_MAX_ID_CHARS = 64;
export const CREW_MAX_LABEL_CHARS = 80;
export const CREW_MAX_TITLE_CHARS = 120;
export const CREW_MAX_DESCRIPTION_CHARS = 2_000;
export const CREW_MAX_INSTRUCTIONS_CHARS = 4_000;
export const CREW_MAX_MODEL_CHARS = 200;
export const CREW_MAX_EFFORT_CHARS = 40;
export const CREW_MAX_CAPABILITIES = 4_096;

/**
 * A debate always returns to the lead, and that is not a field.
 *
 * ADR-0006 requires an explicit return-to-lead queue entry — mention parsing
 * alone drops the self-hop — and there is exactly one lead. Making it editable
 * would let a document end a debate somewhere other than the agent responsible
 * for the decision, so the invariant is expressed by the absence of a target
 * rather than by a default a draft could overwrite.
 */
export const DEBATE_RETURNS_TO_LEAD = true;

// ---------------------------------------------------------------------------
// vocabularies
// ---------------------------------------------------------------------------

/** What a roster entry does. Exactly one `lead`; see `validateCrewSemantics`. */
export const CrewRoleSchema = z.enum(["lead", "member", "worker"]);
export type CrewRole = z.infer<typeof CrewRoleSchema>;

/**
 * The task vocabulary a rule may match on.
 *
 * Closed on purpose. The lead supplies the classification when it delegates
 * (ADR-0006), and a fixed vocabulary is what makes a rule's meaning the same
 * for the router, the editor and the person reading it. `general` is the
 * explicit "not one of the others", never a silent fallback.
 */
export const CrewTaskKindSchema = z.enum([
  "design",
  "research",
  "development",
  "text",
  "decision",
  "general",
]);
export type CrewTaskKind = z.infer<typeof CrewTaskKindSchema>;

export const CrewDifficultySchema = z.enum(["easy", "medium", "hard"]);
export type CrewDifficulty = z.infer<typeof CrewDifficultySchema>;

/** When a decision is put to the debaters. Structured, never free text. */
export const CrewDebateTriggerSchema = z.enum(["core", "major"]);
export type CrewDebateTrigger = z.infer<typeof CrewDebateTriggerSchema>;

// Local literals keep this contract independent when domain.ts imports it.
const CustomBackendSchema = z.enum(["claude", "codex", "api"]);
const CustomApiProviderSchema = z.enum(["anthropic", "openai", "openrouter"]);

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/**
 * A roster id: stable, safe to put in a key, a URL fragment or a log line, and
 * chosen by the author rather than minted, so a JSON edit can refer to one
 * without inventing an opaque handle.
 */
export const CrewIdSchema = z
  .string()
  .min(1)
  .max(CREW_MAX_ID_CHARS)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, hyphen or underscore");

const label = z.string().trim().min(1).max(CREW_MAX_LABEL_CHARS);
const instructions = z.string().max(CREW_MAX_INSTRUCTIONS_CHARS);

/**
 * Where one roster entry runs.
 *
 * `model` and `effort` are bounded strings rather than enums: each backend has
 * its own vocabulary and both are checked against the live catalogue in
 * `validateCrewAvailability`. Hardcoding a list here would go stale and would
 * make this file a second, competing source of truth about what exists.
 */
export const CrewTargetSchema = z
  .object({
    backend: CustomBackendSchema,
    model: z.string().trim().min(1).max(CREW_MAX_MODEL_CHARS),
    effort: z.string().trim().min(1).max(CREW_MAX_EFFORT_CHARS),
    /** Required for `api`, refused for the native backends. */
    provider: CustomApiProviderSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.backend === "api" && value.provider === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "An api target must name its provider",
      });
    }
    if (value.backend !== "api" && value.provider !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        // A native backend's provider is its own configuration, and a crew
        // document must not reach into it.
        message: `A ${value.backend} target does not take a provider`,
      });
    }
  });
export type CrewTarget = z.infer<typeof CrewTargetSchema>;

export const CrewMemberSchema = z
  .object({
    id: CrewIdSchema,
    /** Shown in the composer and the transcript. */
    label,
    /**
     * The author's own name for what this entry does — "architect", "reviewer".
     * Display only: `role` is what the runtime routes on, so a custom label can
     * never widen or redirect anything.
     */
    roleLabel: label.optional(),
    role: CrewRoleSchema,
    target: CrewTargetSchema,
    /** Appended to this entry's session-stable prompt; inert text (R24). */
    instructions: instructions.default(""),
  })
  .strict();
export type CrewMember = z.infer<typeof CrewMemberSchema>;

/**
 * One ordered routing rule.
 *
 * An **absent** `taskKinds` or `difficulties` is the wildcard — it matches
 * everything — which is why a *present* array may not be empty: `[]` would
 * otherwise read as "match nothing", and two spellings of a rule that can never
 * fire is exactly the kind of ambiguity a first-match list must not have.
 */
export const CrewRoutingRuleSchema = z
  .object({
    id: CrewIdSchema,
    taskKinds: z.array(CrewTaskKindSchema).min(1).max(6).optional(),
    difficulties: z.array(CrewDifficultySchema).min(1).max(3).optional(),
    /** The roster id of a `worker` this rule routes to. */
    target: CrewIdSchema,
  })
  .strict();
export type CrewRoutingRule = z.infer<typeof CrewRoutingRuleSchema>;

export const CrewDebateSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Which decisions are put to the debaters. */
    triggers: z.array(CrewDebateTriggerSchema).max(2).default([]),
    /** Roster ids of `member` entries. Empty only while disabled. */
    participants: z.array(CrewIdSchema).max(CREW_MAX_ROSTER).default([]),
  })
  .strict();
export type CrewDebate = z.infer<typeof CrewDebateSchema>;

export const CustomModeDocumentSchema = z
  .object({
    version: z.literal(CUSTOM_MODE_VERSION),
    title: z.string().trim().min(1).max(CREW_MAX_TITLE_CHARS),
    description: z.string().max(CREW_MAX_DESCRIPTION_CHARS).default(""),
    roster: z.array(CrewMemberSchema).min(1).max(CREW_MAX_ROSTER),
    /** First match wins, in this order. */
    routing: z.array(CrewRoutingRuleSchema).max(CREW_MAX_ROUTING_RULES).default([]),
    /** The roster id of the `worker` used when no rule matches. */
    defaultWorker: CrewIdSchema,
    debate: CrewDebateSchema.default({ enabled: false, triggers: [], participants: [] }),
  })
  .strict();
export type CustomModeDocument = z.infer<typeof CustomModeDocumentSchema>;

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

export type CustomModeIssueCode =
  | "schema"
  | "duplicate-id"
  | "missing-lead"
  | "multiple-leads"
  | "unknown-reference"
  | "not-a-worker"
  | "not-a-member"
  | "duplicate-reference"
  | "debate-participants-required"
  | "debate-triggers-required"
  | "unavailable-target";

export interface CustomModeIssue {
  /** Dotted path into the document, e.g. `routing.2.target`. */
  path: string;
  code: CustomModeIssueCode;
  message: string;
}

export type CustomModeParse =
  | { ok: true; document: CustomModeDocument; issues: [] }
  | { ok: false; issues: CustomModeIssue[] };

// ---------------------------------------------------------------------------
// parsing and validation
// ---------------------------------------------------------------------------

/**
 * Structure **and** semantics, in that order.
 *
 * Both passes run before a document is called valid, and both report every
 * problem they find rather than the first: an editor showing one error at a
 * time turns fixing a draft into a guessing game.
 */
export function parseCustomModeDocument(input: unknown): CustomModeParse {
  const parsed = CustomModeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: "schema" as const,
        message: issue.message,
      })),
    };
  }
  const issues = validateCrewSemantics(parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, document: parsed.data, issues: [] };
}

/** Parse editor text with a bounded UTF-8 payload. */
export function parseCustomModeJsonText(input: string): CustomModeParse {
  if (new TextEncoder().encode(input).byteLength > 64 * 1024) {
    return { ok: false, issues: [{ path: "", code: "schema", message: "Custom mode JSON exceeds 64 KiB" }] };
  }
  try {
    return parseCustomModeDocument(JSON.parse(input));
  } catch {
    return { ok: false, issues: [{ path: "", code: "schema", message: "Invalid JSON" }] };
  }
}

/**
 * Everything the shape alone cannot express: uniqueness, references, and the
 * debate invariants.
 */
export function validateCrewSemantics(document: CustomModeDocument): CustomModeIssue[] {
  const issues: CustomModeIssue[] = [];
  const byId = new Map<string, CrewMember>();

  document.roster.forEach((member, index) => {
    if (byId.has(member.id)) {
      issues.push({
        path: `roster.${index}.id`,
        code: "duplicate-id",
        message: `Roster id "${member.id}" is used more than once`,
      });
      return;
    }
    byId.set(member.id, member);
  });

  const leads = document.roster.filter((member) => member.role === "lead");
  if (leads.length === 0) {
    issues.push({ path: "roster", code: "missing-lead", message: "A crew needs exactly one lead" });
  } else if (leads.length > 1) {
    issues.push({
      path: "roster",
      code: "multiple-leads",
      message: `A crew has exactly one lead; this one names ${leads.length}`,
    });
  }

  const ruleIds = new Set<string>();
  document.routing.forEach((rule, index) => {
    if (ruleIds.has(rule.id)) {
      issues.push({
        path: `routing.${index}.id`,
        code: "duplicate-id",
        message: `Rule id "${rule.id}" is used more than once`,
      });
    }
    ruleIds.add(rule.id);
    // Duplicate *values* inside a match list are the same ambiguity as a
    // duplicate rule: the second one can never change an outcome.
    for (const [field, values] of [
      ["taskKinds", rule.taskKinds],
      ["difficulties", rule.difficulties],
    ] as const) {
      if (!values) continue;
      if (new Set(values).size !== values.length) {
        issues.push({
          path: `routing.${index}.${field}`,
          code: "duplicate-reference",
          message: `${field} repeats a value`,
        });
      }
    }
    issues.push(...requireWorker(byId, rule.target, `routing.${index}.target`));
  });

  issues.push(...requireWorker(byId, document.defaultWorker, "defaultWorker"));

  const seenParticipants = new Set<string>();
  document.debate.participants.forEach((participant, index) => {
    const path = `debate.participants.${index}`;
    if (seenParticipants.has(participant)) {
      issues.push({
        path,
        code: "duplicate-reference",
        message: `"${participant}" is listed as a debater more than once`,
      });
    }
    seenParticipants.add(participant);
    const member = byId.get(participant);
    if (!member) {
      issues.push({
        path,
        code: "unknown-reference",
        message: `"${participant}" is not in the roster`,
      });
      return;
    }
    if (member.role !== "member") {
      // The lead receives the debate and decides; a worker runs delegated work.
      // Neither is a debater, and letting one be would make the return-to-lead
      // invariant meaningless.
      issues.push({
        path,
        code: "not-a-member",
        message: `"${participant}" has role "${member.role}"; debaters must be members`,
      });
    }
  });

  if (document.debate.enabled) {
    if (document.debate.participants.length === 0) {
      issues.push({
        path: "debate.participants",
        code: "debate-participants-required",
        message: "An enabled debate needs at least one member to debate",
      });
    }
    if (document.debate.triggers.length === 0) {
      issues.push({
        path: "debate.triggers",
        code: "debate-triggers-required",
        message: "An enabled debate needs at least one trigger",
      });
    }
  }

  return issues;
}

function requireWorker(
  byId: Map<string, CrewMember>,
  id: string,
  path: string,
): CustomModeIssue[] {
  const member = byId.get(id);
  if (!member) {
    return [{ path, code: "unknown-reference", message: `"${id}" is not in the roster` }];
  }
  if (member.role !== "worker") {
    return [
      {
        path,
        code: "not-a-worker",
        message: `"${id}" has role "${member.role}"; routing targets must be workers`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

/**
 * What the app currently offers, supplied by the caller.
 *
 * Deliberately an input rather than something this module looks up: resolving a
 * model means asking the live harness catalogue, and a validator that reached
 * for one would couple the contract to a runtime, spend a probe, and be
 * untestable offline. ADR-0006 also forbids substituting an unavailable model
 * silently — so this reports, and the caller refuses.
 */
export interface CrewCapability {
  backend: CrewTarget["backend"];
  model: string;
  /** Efforts this backend/model actually accepts. Missing or empty is unavailable. */
  efforts?: readonly string[];
  /** For `api` targets, the providers this model is offered under. */
  providers?: readonly string[];
}

/**
 * Check every target against the supplied roster. Separate from
 * `parseCustomModeDocument` on purpose: a document is *structurally* valid
 * independently of today's catalogue, and the editor needs to keep an
 * unavailable draft open rather than discard it.
 */
export function validateCrewAvailability(
  document: CustomModeDocument,
  capabilities: readonly CrewCapability[],
): CustomModeIssue[] {
  const issues: CustomModeIssue[] = [];
  if (capabilities.length > CREW_MAX_CAPABILITIES) {
    return [{ path: "roster", code: "unavailable-target", message: "The capability catalogue is too large" }];
  }
  document.roster.forEach((member, index) => {
    const path = `roster.${index}.target`;
    const matches = capabilities.filter(
      (candidate) => candidate.backend === member.target.backend
        && candidate.model === member.target.model,
    );
    if (matches.length === 0) {
      issues.push({
        path,
        code: "unavailable-target",
        message: `${member.target.backend}/${member.target.model} is not available`,
      });
      return;
    }
    const compatible = matches.filter((candidate) =>
      (candidate.efforts?.length ?? 0) > 0
      && candidate.efforts!.includes(member.target.effort)
      && (member.target.provider === undefined
        || (candidate.providers?.length ?? 0) > 0 && candidate.providers!.includes(member.target.provider)));
    if (compatible.length === 0) {
      issues.push({
        path,
        code: "unavailable-target",
        message: `${member.target.backend}/${member.target.model} does not offer the requested effort/provider`,
      });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// canonical form
// ---------------------------------------------------------------------------

/**
 * The document as text, with object keys sorted.
 *
 * Both editors project the same parsed object, so equality has to be about the
 * document rather than about whitespace or key order (ADR-0006: "Canonical
 * equality uses parsed values with defaults applied"). Array order is preserved
 * — routing is ordered, and reordering it changes which rule wins.
 */
export function canonicalCustomModeJson(document: CustomModeDocument): string {
  return JSON.stringify(sortKeys(document), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}
