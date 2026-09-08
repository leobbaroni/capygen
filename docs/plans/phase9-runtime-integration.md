# Phase 9 remaining runtime integration

Astra decision, 2026-09-08. This supplements ADR-0007; it is an implementation brief,
not evidence that the boundaries below are already enforced.

## Engine and desktop boundary

The engine receives an optional local authorization callback, never a rule store or policy
document. Each call names its observable boundary, exact tool name, complete JSON input,
execution cwd and cancellation signal. A local allow only removes capygen's additional
restriction; native hard denials still win. Execute the returned approved input, not the
original mutable object. Native approval protocols that cannot execute an edited payload
must refuse edits rather than claim to apply them.

API and Codex client tools apply native host gates first, then consult current local policy
immediately before execution, after any native approval wait. Claude uses a matcher-less
PreToolUse hook with its existing routing branch preserved; an approved local request returns
a neutral native permission decision. Codex command/file boundaries exist only where the
captured native configuration actually asks the app. Permission-profile approvals remain
unavailable until their pinned protocol and response semantics are implemented and proved.

## Captured authority in SessionRunner

One desktop-owned LocalPolicyService serves management, dispatch, tools and widgets. The
runner supplies contexts from the actual captured harness, with a fresh opaque lifecycle
token. Before lazy startup, dispatch uses the resolved effective target configuration to
check applicable unavailable boundaries and the persisted execution subject. Do not start
a model and then discover the profile was a viewer.

Bind the callback to session/agent/token in main, never to values supplied by the renderer
or model. Delegated children get their own captured contexts and tokens, including children
whose ephemeral agent ID is not a persisted roster row. Remove those contexts and revoke
their lifecycle grants on every release/error/cancel path. Parent grants and bypass settings
do not authorize children. A changed harness configuration gets a new token even when it
resumes the same native conversation.

The ask broker persists a normal permission card with local rule/scope attribution and
routes answers through the existing permission answer path. Allow once and Allow for
session are distinct; historical Allow always must not mint authority. Stale answers return
failure. Cancellation and restrictive reassignment settle pending requests as denied and
interrupt execution. Ordinary reassignment uses the runner's actual quiescence, including
queued round-table work and pending interactions, rather than only the session status row.

Main owns the management actor (the built-in local operator). The session execution subject
still comes from the persisted assignment on every dispatch/approval. Automation copies the
source session's current assignment before dispatch into a fresh run; missing/viewer subjects
produce a visible refused run with no model call. No fallback to owner.

## Widgets and invalidation

Widget tool calls bind to the originating session, agent and captured MCP connection. Derive
an opaque token from the actual connection instance, not a display name or server URL; do
not expose the private connection fingerprint. Apply native host restrictions and the same
local service before execution. A disposed/replaced connection invalidates its grants.

Add a metadata-only policy.changed event for management mutations and grant lifecycle
changes. Open Members/Policies/Approve views reload affected data without adding anything
to model context. Use existing agents.list for a preview roster, never sessions.get with
all historical blocks. A changed preview input invalidates any pending result.

## Catalogue seam

Root added agents.catalogue(sessionId, agentId, initialize), with explicit session ownership
and imported-artifact refusal, plus Engine.catalogueAgent as the runtime seam. The renderer
contract is AgentToolCatalogueSchema. Wire this to the same captured harness: initialize is
true only for explicit refresh, and no model turn may be enqueued. Missing runtime, pending,
unsupported, cancelled/timeout and stale remain distinct visible states. Cancelled does not
necessarily mean the user cancelled: an earlier backend query may still be outstanding.

Composer reads the informational MCP collection separately from selectable slash commands.
Session additions reuse agent.config.<backend>.mcpServers and agents.update, preserving
existing non-MCP fields and respecting credential rejection and restart behavior.

## Required integration evidence

- Actual adapter fixtures deny API execution and Codex client-tool callbacks; native hard
  denial beats local allow. Edited approved input is exactly what executes.
- Change/revoke policy while an approval waits; stale approval never runs or creates a grant.
- Viewer dispatch, delegated child and automation refusal happen before any model call.
- Same tool/input on another agent, restarted harness or replaced widget connection cannot
  reuse a session grant. Widget visibility alone grants nothing.
- Real local MCP fixture appears through session configuration, runtime catalogue and the
  informational menu with no model prompt or duplicate server process.
- UI previews, rule editor links, pending approval aggregation and cross-window invalidation
  use actual IPC. No dev fixture is counted as native integration acceptance.

Run the phase's full gate and independent review after integration. Phases 9, 9C and 10–12
remain open until their own Done-when checks hold.
