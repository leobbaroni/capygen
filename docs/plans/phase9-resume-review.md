# Phase 9 resume review — 2026-09-08

Open findings, not phase acceptance. Astra reviewed the completed worker outputs after
resuming. The initial expired-login blocker was resolved by the user; Opus work has resumed.

## Sharing worker and staging

1. `ShareWorkerClient.ensureChild` handles an old child's late exit by rejecting **all**
   pending requests, including those sent to a replacement child. Scope messages, exits,
   deadlines and pending requests to a child generation. A stale exit/message must not affect
   the new worker. Test timeout/kill followed by restart before the old exit arrives.
   Astra reproduced this with an owned fake-child probe: replacement request rejected after
   the old child's exit despite a valid replacement reply. Transient script:
   e2e-out/review/share-worker-generation-probe.ts; result `{"result":"rejected"}`.
2. `ShareStagingService.settle` releases its byte and concurrency reservations before awaiting
   worker release. Repeated cancellation can admit more work while old payloads still exist.
   Keep a deleting state and reservations until release is acknowledged or the owning process
   has exited. Concurrent settle calls must join the same completion, not return early.
3. Worker admission checks only completed `jobs.size`, ignoring `creating.size`; duplicate
   job IDs can overwrite controllers and payloads. Reserve at creation, reject duplicate IDs,
   and release a reservation only when its work has settled. Test overlapping file reads.
4. Main/worker protocol currently casts arbitrary messages and trusts response shapes. Validate
   version, request identity, expected operation and bounded result shape. A malformed worker
   response must produce a generic error, never a renderer-visible arbitrary error message.
5. Add an actual Electron utility-process proof of create, paged preview, save bytes and
   cancellation/exit cleanup. Bundling a worker entry is not proof that it can be forked.

## MCP catalogue

Sent to the runtime worker and now being corrected:

- A pre-aborted refresh currently starts execute/initialize before checking cancellation.
- A hung shared fetch keeps `inFlight` forever after every caller times out. Bound the shared
  operation and define recovery without duplicate live queries; discard late/stale results.
- Do not send raw errors to a logger. Backend errors may contain credentials or launch data.
- Bound scanned input entries, not only unique accepted tool names. Duplicate/invalid names
  otherwise permit an unbounded loop. Apply aggregate output limits and avoid unbounded
  adapter mapping before the cap. Omit invalid/overlong/control-containing names with a
  disclosure instead of rewriting identities into possible collisions.

## Policy management

The standalone contract and handler factory are awaiting final review and central wiring.
They do not yet enforce runtime tools. Always inject the per-session audit reader and
per-agent boundary resolver; management uses the main-owned desktop operator, not a role
or actor claimed in an IPC request. Null subjects and unavailable boundaries remain explicit.
Standalone factory/contract confirmation by Astra: 2 files, 20 passed, 1.74s
(e2e-out/phase9-policy-ipc-astra.log). Luna added central contract and optional desktop factory
wiring; central-context tests are being added. The sharing changes interleave with those
files, so they remain uncommitted until the dependency set can be reviewed together.


## Corrective waves now in progress

The initial catalogue findings were corrected with adapter-level lifecycle regressions and
an escaped-JSON aggregate byte test. Opus reports 40 catalogue tests and both native local
MCP probes passing; these are not yet a complete desktop catalogue integration proof.

Sharing has real native worker and shell proofs, but Astra's second review found that
creating-job cancellation released admission too early, and a requested kill was treated
as confirmed process exit. Keep reservations until actual settlement/exit, retain generation
ownership, and validate exact bounded response shapes. The worker is correcting those cases
and renamed-HTML detection. Raw worker stderr remains ignored by Astra decision; fixed failure
codes provide diagnostics without persisting hostile input or secret-bearing exceptions.

Members/Policies renderer tests pass, but review requires stale preview/query invalidation,
local rename drafts, full existing-rule editing and owning-rule links, and generic unexpected
errors. Use the already-existing agents.list instead of loading sessions.get history. Actual
700px Chrome viewport captures show no document horizontal overflow; the corrected UI still
needs a fresh visual pass and native IPC integration.

Engine policy hooks are under a corrective review wave: abort a hung authorizer promptly,
strict bounded input equality without JSON field elision, refuse invalid edited inputs,
per-turn Claude hook cancellation, complete Codex file-approval identity including diffs,
and honest capability availability. Desktop integration follows the brief in
phase9-runtime-integration.md. No Phase 9 acceptance is implied.
