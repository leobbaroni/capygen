# Phase 7 runtime configuration contract

Status: accepted by Astra after two Fable 5.1 medium review rounds, 2026-09-07.
Implementation follows acceptance of 7-P0 and the encrypted-reference prerequisite S0.
Owner: one Opus implementation task for 7-P1 and 7-P3. No replacement configuration framework.

## Existing defects

- `SettingsService.project()` writes a second set of overlapping preferences and leaves an
  old permission mode behind when a backend section is reset.
- `SessionRunner.harnessFor()` passes raw agent config and the flat permission fallback;
  `effectiveBackendConfig()` is not used at the shipping boundary.
- `ApiHarness.ensurePool()` and the widget host use the legacy MCP file loader, which defaults
  to `os.homedir()` and disagrees with the settings stores about owned servers and approvals.
- `ApiConfigStore` drops `cwd` and HTTP headers on its read/write round trip.
- Widget hosts are keyed only by project path, although two agents in that project can resolve
  different connections under the same server name.

## Proposed authority and lifecycle

1. `GlobalSettings` owns overlapping preferences. Migrate legacy flat values only when the
   canonical row does not exist. Existing canonical rows win. Migration writes the canonical row
   and removes overlapping flat rows in one transaction. A malformed or newer-version canonical
   row serves safe defaults read-only, refuses patch/reset, and preserves the original bytes.
2. Keep `settings.get`/`settings.set` as compatibility views and translate overlapping fields
   into canonical settings. Arbitrary internal `getRaw`/`setRaw` state remains supported.
   Flat-only `hopCap`, `showThinking`, and `uiFontSize` remain intact. A failed write
   must not leave a partially updated pair of authorities.
3. Both settings IPC surfaces apply platform effects and broadcast through `SettingsService`.
   Renderer subscribers re-read the compatibility view when canonical settings change.
4. Fresh and resumed harness construction captures a fieldwise effective config: backend
   global defaults, then explicit agent overrides. Unset fields fall through to harness defaults.
   Reset removes the old opinion, including permission mode. Capture once per harness lifecycle;
   never insert the settings object into prompts or mutate an active turn's configuration.
5. Updating an agent's model/config disposes its idle harness while retaining the backend resume
   id. During an active turn, defer restart until that turn ends; show the pending state. Global
   edits apply to new/restarted harnesses and do not restart an active session automatically.
6. Delegation resolves defaults for the target backend, then explicit target overrides. Never
   derive a target's bypass permission from the parent's bypass mode or copy a permission grant.
   Existing interactive approval boundaries still apply. Full scoped grant intersection belongs
   to Phase 9. Test the actual child `start()` argument, not only its factory input.
7. Add explicit `model` defaults for Claude and Codex alongside API. `general.defaultModel` is
   the compatibility alias for the selected default backend's model, not a cross-backend fallback.
   If no explicit model exists for another backend, resolve its own catalogue default or refuse
   before dispatch with a visible selection error. Never send an empty model or a Claude id to
   Codex merely because it is the general default.

### Alias and failure decisions for P1-A

Persist only the canonical backend model override; derive `general.defaultModel` on reads.
Translate alias writes into the selected backend override. Normalize an older valid canonical
row's stored alias once, only if that backend has no explicit override; record conversion so a
later reset cannot rehydrate the old value. `reset(backends)` clears overrides, while
`reset(general)` must not create a backend override. Flat-only preferences stay independently
stored; malformed/future canonical rows never recover permission/model values from stale flat
rows. Internal raw bookkeeping remains available.

Existing backend catalogue defaults remain the fallback: Claude's own curated first entry,
Codex's default/first listed entry and the API provider's own first entry. This is not a new
model-availability claim or a pricing update. Preserve explicit custom model choices and refuse
known incompatible or unresolvable choices before backend start. New-session validation fails
before its mutation; a pre-existing session gets a visible error turn without starting a
backend. A delegated child gets a failed tool result when no valid model can be resolved;
unrelated legacy R12 routing fallbacks remain unchanged.

Resolve a delegated child's actual `start()` agent, not merely its factory argument. The
parent's explicit target-backend config section remains an override, but its scalar bypass
permission does not become the target's permission. Retain a resume id only when the backend
is compatible. Minimal public runtime metadata may report effective model, effort and pending
restart for verification; it must not return the effective config object or transport values.

P1-A owns settings/model/config/restart behavior first. The same Opus owner then implements
P1-B transport discovery/redaction/reference migration/widget identity, after P1-A review.

## MCP discovery

Use the existing scoped stores behind one injected resolver. A concrete execution directory and
explicit backend homes are required inputs; tests supply isolated homes. Remove the legacy
loader from shipping paths or require explicit inputs that cannot fall back to a personal home.

API precedence is explicit agent configuration, API-owned entries, then inherited Claude and
Codex entries. Resolve names before filtering disabled entries so a disabled higher-priority
entry cannot resurrect an inherited server. Preserve transport, arguments, environment, cwd,
URL and headers. Preserve Claude project approval/disabled precedence from its store.

Full transport values stay in the main process. Public integration entries expose `envKeys`
and `headerKeys` only. Use per-key set/unset mutations; omitted keys preserve existing values.
An edit form must not submit redaction placeholders back as values. Treat every env/header
value uniformly rather than guessing which names indicate credentials.

Backend-owned config files remain authoritative and retain their values; do not migrate their
credentials into capygen. For API-owned entries, store only encrypted-secret references in
`api_mcp_servers`. Migrate legacy API plaintext on first touch only after encryption succeeds;
otherwise preserve the row and refuse sensitive mutations. Non-sensitive edits may still work
without dropping those existing values. Resolve references in the main process before computing
pool identity. Never hash reference labels in place of their resolved connection values.

S0 adds a main-process-only MCP namespace to the existing safeStorage file, with opaque stable
refs `mcp/<32 lowercase hex>` so server renaming does not move secrets. Provider keys remain
compatible. Atomic ciphertext writes preserve previous bytes on failure/corruption; there is no
new plaintext or IPC read endpoint. P1 handles reference creation, cleanup and migration.
Environment-variable interpolation requires a pinned backend contract and fixture evidence;
do not silently replace it with a different expansion rule or claim parity without that proof.

API tools and widgets must resolve the configuration of the agent whose tool call produced the
widget. Share an MCP pool only when complete effective connection identities match. Bind widget
ownership to the original session/agent and configuration snapshot; a settings edit must not
redirect an already-open widget to a different same-name server. Retire old access through the
existing lifecycle without leaking pools or watchers. Do not expose configuration credentials
to the renderer or model.

## Acceptance

- Legacy-only profile migration, restart, canonical-wins, malformed canonical data, reset,
  unrelated patch, and transaction failure preserve the intended preferences.
- Both IPC settings APIs cause matching platform effects and window updates.
- Captured Claude SDK, Codex protocol, and Anthropic request options prove global low effort,
  explicit override priority, fresh/resume/restart behavior, and delegated target settings.
- Isolated fixture MCP server added/disabled through IPC is reflected in actual API tools and
  widget access. Verify API-owned and inherited name collisions, disabled shadowing, project
  approval, headers/cwd round trips, and two agents with different same-name servers.
- No implicit personal-home reads or child spawns; no settings/pane data in model requests.
- Independent review and the full phase gate remain required. Passing a pure layering helper
  test or setting hub defaults in an e2e helper does not establish runtime propagation.
