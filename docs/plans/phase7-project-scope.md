# Phase 7-P0 — explicit project context

Astra contract, 2026-09-07. Implements reviewed R-D before worktree operations.

- A Project id identifies one concrete execution directory. A future worktree is a separate
  Project id/path linked to its repository; selecting it must never execute at the parent root.
  Repository identity (git common directory) is discovered through git and does not replace cwd.
- Every integrations request accepts optional `projectId`. Omitted means global-only, never
  most-recent project. An explicit unknown id fails before reads, writes, probes or shell opens.
  Project/local mutations require an explicit valid id. Keep existing backend-owned files.
- Request scope is immutable across awaits. Do not set a mutable service-wide active project:
  concurrent windows must not redirect a write after a dialog/CLI await. Snapshots and watcher
  refreshes are keyed by explicit scope and backend. Project cache must not overwrite global
  cache rows; remove unused projection persistence or scope it, preserving app-owned policies.
- Renderer maintains selected project per window in app state. Landing selection and opening a
  session set it; recency may seed initial landing selection once, never resolve IPC requests.
  Settings shows the selected project and sends its id on every integrations operation.
  Stale async results after selection/backend changes must not replace current data.
- Global configuration changes invalidate affected project snapshots as well as global data.
  Watchers close on disposal; no double start or late callback may resurrect them.

Acceptance: two project directories with conflicting MCP/skill names; list A/B/global; mutate
A while B is most recent; interleave delayed operations; unknown ids refused; global edits
visible in both; external file changes refresh correct scope; selected project survives
settings navigation. All tests use isolated backend homes.

Files: shared IPC context fields, IntegrationsService/SyncCoordinator and integration handlers,
renderer project state/settings invocation boundary plus relevant tests. Keep MCP pool identity
files with their separate 7-P2 owner. No replacement config framework.
