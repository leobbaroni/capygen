/**
 * [7-P1] "Can this (backend, model) actually run?", answered before anything is
 * written.
 *
 * Two checks, and both of them are deliberately narrow:
 *
 *  1. **It resolves.** `resolveModel` walks the agent's own choice → the
 *     canonical default for its *own* backend → that backend's own catalogue
 *     default → that backend's own built-in default. Nothing resolves to
 *     another backend's model, and an empty model is never sent (COMPAT.md is
 *     explicit about that for Claude, and a Codex `thread/start` with no model
 *     silently uses a `config.toml` default capygen cannot see). No answer
 *     means: refuse, and say which agent.
 *
 *  2. **It is not a *certain* backend mismatch.** The only evidence used is the
 *     catalogues the backends themselves report (`harness.list`): a model that
 *     appears in another backend's catalogue, does not appear in this one's,
 *     and is being sent to a backend that *has* a catalogue right now, is a
 *     mistake the user can see — `claude-opus-4-5` on `codex` is a spawn that
 *     fails. The **resolved** model is checked, not only an explicit one: a
 *     canonical default can be wrong for its own backend too.
 *
 *     Everything else is allowed. There is no substring rule ("starts with
 *     `claude-`"), and no closed allowlist: an id capygen has never heard of is
 *     a custom or newly released model, and refusing it would break a valid
 *     choice to protect against a typo. A backend whose catalogue is empty —
 *     not signed in, not probed yet — is not evidence of anything, so nothing
 *     is refused on its behalf.
 *
 * The catalogue is read from the harness lister's **last resolved** answer, so
 * validating a selection never spawns a probe.
 */
import { resolveModel, type ModelCatalogue } from "@capygen/engine";
import type { ApiProvider, Backend, GlobalSettings, HarnessInfo } from "@capygen/shared";
import { API_MODELS } from "./harnessList.js";

export interface ModelSelectionDeps {
  settings: () => GlobalSettings;
  /** The last resolved `harness.list`, or `[]`. Never probes. */
  harnesses: () => readonly HarnessInfo[];
}

export interface ModelSelectionCheck {
  ok: boolean;
  /** The model that would actually run; empty when `ok` is false. */
  model: string;
  /**
   * `api` only: the provider that model was resolved against. The caller
   * **materialises** it into the effective config — resolving a model from one
   * provider and letting the harness default to another is the whole defect
   * this field exists to close.
   */
  provider?: ApiProvider;
  /** Why not — user-facing, and the message an error turn carries. */
  reason?: string;
}

/**
 * The `api` provider this dispatch actually runs on: the agent's (or the
 * delegation target's) **effective** `config.api.provider`, else the canonical
 * global default, else the first provider with a credential.
 *
 * [7-P1] `harness.list`'s single `defaultModel` is derived from the *global*
 * provider, so it is the wrong answer for an agent — or a delegated child —
 * that selects a provider of its own. Resolution asks this instead.
 */
export function effectiveApiProvider(
  settings: GlobalSettings,
  harnesses: readonly HarnessInfo[],
  config?: Record<string, unknown> | null,
): ApiProvider {
  return (
    asProvider(config?.provider) ??
    asProvider(settings.backends.api.provider) ??
    harnesses.find((info) => info.backend === "api")?.providers?.[0] ??
    // `ApiHarness.resolveConfig` defaults an absent provider to Anthropic, so
    // this is not a guess: it is what the harness would really use.
    "anthropic"
  );
}

/**
 * A custom endpoint — anything with a `baseUrl` of its own.
 *
 * A gateway routinely serves ids from another vendor's catalogue, so the
 * curated public lists are no evidence about what it accepts. Any explicit
 * `baseUrl` is treated as custom: recognising "the canonical public URL" is a
 * guess of its own, and the conservative reading only ever *allows* more.
 */
function isCustomEndpoint(config?: Record<string, unknown> | null): boolean {
  return typeof config?.baseUrl === "string" && config.baseUrl.trim().length > 0;
}

/**
 * A `ModelCatalogue` over the last resolved `harness.list` — never a probe.
 *
 * `claude`/`codex` answer with their own row's default. `api` answers with the
 * **effective provider's** own first model, because one `api` row flattens
 * every keyed provider's list and cannot say which provider owns an id.
 */
export function catalogueFrom(
  harnesses: () => readonly HarnessInfo[],
  api?: { settings: GlobalSettings; config?: Record<string, unknown> | null },
): ModelCatalogue {
  return (backend) => {
    if (backend !== "api") {
      return harnesses().find((info) => info.backend === backend)?.defaultModel || null;
    }
    if (!api) return harnesses().find((info) => info.backend === "api")?.defaultModel || null;
    const provider = effectiveApiProvider(api.settings, harnesses(), api.config);
    return API_MODELS[provider][0]?.id ?? null;
  };
}

function asProvider(value: unknown): ApiProvider | null {
  return value === "anthropic" || value === "openai" || value === "openrouter" ? value : null;
}

/**
 * Check one selection. `model` may be empty — that is exactly the "no explicit
 * choice, fall through" case, and it is only an error when nothing downstream
 * can supply one.
 */
export function checkModelSelection(
  deps: ModelSelectionDeps,
  selection: {
    backend: Backend;
    model?: string | null;
    name?: string;
    /**
     * The agent's (or delegation target's) **effective** section for this
     * backend. Only `api` reads it, for `provider`: the model an `api` dispatch
     * may use depends on which provider it runs against, and that is a per-agent
     * choice a single global value cannot answer.
     */
    config?: Record<string, unknown> | null;
  },
): ModelSelectionCheck {
  const who = selection.name ? `"${selection.name}"` : `the ${selection.backend} agent`;
  const explicit = (selection.model ?? "").trim();
  const settings = deps.settings();
  const harnesses = deps.harnesses();
  const catalogue = catalogueFrom(deps.harnesses, {
    settings,
    config: selection.config ?? null,
  });

  const resolved = resolveModel(
    settings,
    { backend: selection.backend, model: explicit },
    catalogue,
  );
  if (!resolved.ok) return { ok: false, model: "", reason: `${who}: ${resolved.reason}` };

  // [7-P1] Checked against the **resolved** model, not only an explicit one.
  // A canonical default can be wrong for its own backend too — a profile whose
  // `backends.codex.model` still holds a Claude id (migrated from the old
  // app-wide alias, or edited by hand) would otherwise sail past this and fail
  // at spawn time with the backend's own error.
  const how = explicit ? "is set to run" : "would run";
  const custom = selection.backend === "api" && isCustomEndpoint(selection.config);
  const provider =
    selection.backend === "api"
      ? effectiveApiProvider(settings, harnesses, selection.config)
      : undefined;

  // A custom endpoint is not the public provider: the curated catalogues say
  // nothing about which ids it accepts, so neither mismatch check applies.
  if (!custom) {
    const mismatch = certainBackendMismatch(resolved.model, selection.backend, harnesses);
    if (mismatch) {
      return {
        ok: false,
        model: "",
        reason:
          `${who} ${how} "${resolved.model}" on the ${selection.backend} backend, but that model ` +
          `is one ${mismatch} offers and ${selection.backend} does not list it. Pick a model from ` +
          "this backend, or switch the agent's backend.",
      };
    }
    // …and, for `api`, against the provider it will actually run against —
    // including the fallback, which is deterministic and therefore just as
    // real a runtime choice as an explicit one.
    if (provider) {
      const wrong = certainProviderMismatch(resolved.model, provider);
      if (wrong) {
        return {
          ok: false,
          model: "",
          reason:
            `${who} ${how} "${resolved.model}", which is a ${wrong} model, but this agent's ` +
            `provider is ${provider}. Pick a ${provider} model, or change the agent's provider.`,
        };
      }
    }
  }
  return { ok: true, model: resolved.model, ...(provider ? { provider } : {}) };
}

/**
 * The backend that certainly owns this model id, when this one certainly does
 * not. `null` whenever the evidence is incomplete — which is most of the time,
 * and deliberately so (see this file's header).
 */
function certainBackendMismatch(
  model: string,
  backend: Backend,
  harnesses: readonly HarnessInfo[],
): Backend | null {
  const own = harnesses.find((info) => info.backend === backend);
  // No catalogue for this backend right now: no evidence, no refusal.
  if (!own || own.models.length === 0) return null;
  if (own.models.some((entry) => entry.id === model)) return null;
  const other = harnesses.find(
    (info) => info.backend !== backend && info.models.some((entry) => entry.id === model),
  );
  return other?.backend ?? null;
}

/**
 * The provider that certainly owns this model id, when the effective one
 * certainly does not.
 *
 * The same narrow rule as `certainBackendMismatch`, one level down: only the
 * curated per-provider lists are evidence. An id in none of them is a custom
 * model or a newly released one — including anything behind a custom
 * `baseUrl`, which is exactly where unknown ids are expected — and is allowed.
 */
function certainProviderMismatch(model: string, provider: ApiProvider): ApiProvider | null {
  if (API_MODELS[provider].some((entry) => entry.id === model)) return null;
  for (const [candidate, models] of Object.entries(API_MODELS) as [
    ApiProvider,
    { id: string }[],
  ][]) {
    if (candidate !== provider && models.some((entry) => entry.id === model)) return candidate;
  }
  return null;
}
