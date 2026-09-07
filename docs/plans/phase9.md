# Phase 9 execution ledger

Astra low leads; Opus 5 medium hard/medium; Luna low simple tasks. Root alone commits on main.
Start: accepted Phase 8 `f80500c`; fresh baseline 1883 unit passes / 4 skips, typecheck clean.

1. Codex dynamic-tool bridge: Opus owns packages/engine only. Typed start/resume/request/reply,
   cancellation/identity/duplicate guards; synthetic red/green tests and no-model native probe.
   Desktop delegation wiring follows reviewed engine support. Live choice proof remains separate.
2. Sharing schemas: Opus owns packages/shared only. Strict versioned inert content using the
   existing import-entry union; bounded UTF-8 envelope, comments/references/count consistency.
   Encoder/projection, DB/IPC and UI follow acceptance of that contract.
3. Runtime local policy: ADR-0007; implement shared contracts, separate local-rule/grant/audit
   persistence, then actual harness/main enforcement. Member-role subject contract comes first.
4. Sharing implementation: default projection excludes raw tool input/output, diffs, interaction
   answers, widget HTML, configuration and native identities. Reasoning is opt-in. Redaction
   precedes clipping; heuristic detection is not a guarantee. JSON <=32MiB, HTML <=96MiB with
   escaped display and inert embedded JSON; no scripts, active widgets or external assets.
   Preflight actual encoded bytes before opening Save. If the HTML carrier cannot fit, explain
   the limit and offer the already-reviewed JSON; never discover this only after a file write.
   The two formats have independent caps. Withheld reasoning has a droppedThinking tally.
   Imported dropped/redaction tallies are explicitly sender claims, not verified facts.
   Deleting an imported artifact removes its identity record; re-import creates a fresh session.
   Sharing imports use sibling share tables and the existing `origin=import` read-only guard.
   A session artifact-kind discriminator distinguishes shared bundles from native transcripts.
   Do not rebuild the heavily referenced sessions table merely to add another origin enum;
   native transcript provenance and UNIQUE constraints remain unchanged. Fresh continuation
   selects the explicit artifact-kind reader and creates new app/backend identities; neither
   native nor shared imports supply resume identity or executable historical tool messages.
   Main owns native picker/save, preview, immutable handles and atomic persistence.
5. Catalogue/session MCP, Members/Policies/Sharing/Approve UI: existing settings and permission
   primitives with reference layouts; fixture menus distinguish MCP tools from slash commands.
6. Native end-to-end acceptance, independent review/fixes, full gate and phase acceptance.

All unchecked work above is pending. Migration 0009 is allocated to share persistence; 0010 to local policies/members;
never reuse a number assigned to another task. No new phase is accepted by this file.


## MCP catalogue integration findings (Astra, 2026-09-07)

Reuse persisted agent.config.<backend>.mcpServers for credential-free session additions;
IntegrationsService.resolveMcpServers already merges these at highest precedence. Do not add
a shadow session MCP table. Authenticated registrations remain in backend stores/safeStorage.
The session editor updates the existing agent config path and respects harness restart rules.

Keep informational tool DTOs separate from SlashCommand. SlashMenu accepts serverName/name
rows already, with no selection execution. Composer/runtime wiring remains pending.
Use native runtime metadata rather than connecting duplicate MCP clients for native backends:

- Installed Claude SDK sdk.d.ts:1117 exposes McpServerStatus.tools (name/description), and
  Query.mcpServerStatus() at 2765. ClaudeHarness.ensureQuery can initialize its existing
  streaming query; catalogue discovery must not enqueue a prompt or make a model call.
- Pinned Codex mcpServerStatus/list supports threadId and returns server tools. Query the
  same thread/client; do not spawn an extra configured stdio server for catalogue display.
- API can reuse its existing reference-counted McpClientPool and cached listTools result.

Discovery is explicit/lazy, with bounded names/status metadata only across IPC—no schemas,
URLs, env, headers or raw backend failures. A failed/not-started catalogue is visible, not an
empty list claimed to prove no tools. Refresh after supported config changes without silently
showing an old lifecycle as current. Native/fixture tests must prove metadata only, no model
prompt, and no duplicate server spawn. These findings are not implementation acceptance.
