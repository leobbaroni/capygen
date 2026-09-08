# Phase 9 resume review — 2026-09-08

Open findings, not phase acceptance. Astra reviewed the completed worker outputs after
resuming. The initial expired-login blocker was resolved by the user; Opus work has resumed.

## Current review queue

The sections below retain chronological findings; some are already corrected. Current work:

- Engine accepted/pushed as `96f4cf9`: 602 tests passed, four explicit skips, types clean,
  eight native Claude cases proven after environment/deadline cleanup. A separate Windows
  8.3-path containment false positive is now assigned to Opus.
- Desktop: typed originating-turn permission events and authority rechecks passed the real
  API tool test, including exact grants, revocation, busy reassignment refusal and restrictive
  viewer cancellation with zero further provider requests. Claude capability reporting and
  widget ownership/lifecycle remain under review. NEW: widget captures retain Claude/Codex
  backend but request api-tool; LocalPolicyService.capabilityProblem requires backend equality,
  so marking api-tool available alone cannot authorize those widget calls. Resolve explicitly.
- Sharing/renderer: native Prepare/save/import/restart first-use flow passed. NEW native
  repeat-use regression: after successful save, useStagedShare.exclusive increments generation
  before finally checks it, leaving busy true and Prepare disabled (resume-sharing-repeat.log).
  All stale-operation finally blocks also unconditionally clear running, potentially unlocking
  a newer generation's in-flight operation. Give running/busy ownership to the operation.
  Approve aggregation and shared fresh continuation are being implemented.
- Notes: complete CRUD/reply/export plumbing reported; final root review still needs native
  proof. Live block anchors currently become session-level on export; preserve a safe projected
  entry mapping where available and disclose any deliberately dropped anchors/count limits.
- Still required: session MCP editor/Composer catalogue integration, native acceptance evidence
  and the full phase gate. Phase 9 and later phases remain unchecked.

Do not repeat already-passing checks without a change or unresolved concern, and do not run
mutation sweeps in the shared working tree while another agent is building it.

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

## Desktop runtime first review, 2026-09-08

Opus delivered lifecycle contexts, a local ask broker, main wiring and runner hooks, reporting
96 focused tests passing. Astra review found a blocking composition defect: preflight dispatch
calls the service before capture, while its context resolver only recognizes captures. Every
cold live dispatch is therefore refused as unknown. Mocked hook tests did not exercise this
composition. The corrective wave must combine the actual service and runner in regression
tests, resolve effective preflight configuration without starting a backend, and separately
require captured lifecycle authority at tool execution.

Other required corrections: delegated children need pre-model subject/boundary checks and
their actual Codex approval configuration; synchronous harness construction failure must
release captures; abort/cancel/shutdown must settle persisted permission cards; permission
cards must attach to the originating agent's turn instead of the newest session turn.
Displayed permission scope must match the effective once/session authorization.

Review also found no management-mutation policy.changed publication in localPolicies.ts.
Grant lifecycle notifications alone cannot invalidate another window's rule/member preview.
Add successful-mutation events for members, subjects, rules and explicit grant revocation,
and prove both windows refresh through the actual IPC surface. Widgets, automation subject
copy, catalogue wiring and edited-input validation remain unfinished integration requirements.

Astra native regression `tests/e2e/localPoliciesShell.spec.ts` now proves real main/service/
runner viewer refusal and assignment persistence after restart (1 passed, 2.0s, before adding
the invalidation assertion). With the additional preload policy.changed subscription, a
successful profile rename produces no event: expected members/null, received an empty array,
15s assertion timeout (`e2e-out/policy-native-invalidation-red.log`). This is an intentional
red regression awaiting the management event correction, not phase acceptance. The test
strips provider keys even when a dedicated suite identity is configured and uses no model.

Engine policy/catalogue confirmation by Astra: 2 files, 98 passed, 2.46s
(`e2e-out/engine-policy-catalogue-astra.log`), including the four Codex approval cancellation
regressions. Claude native hook precedence remains undecided: the loopback response did not
produce an actual tool call, so absence of a sentinel is not denial evidence. The worker is
continuing the fixture protocol correction with a required positive execution control.

## Sharing UI first integration review

Initial source review, awaiting the renderer worker's completed wave:

- Export save does not consume the main staging handle (`staging.use`), but the renderer
  clears its held handle without cancelling it. Keep the reviewed snapshot for another
  format or explicitly release it; do not orphan its reservation until expiry.
- Preview/picker completion can arrive after unmount, discard, session/project changes or
  reasoning-toggle changes. Invalidate operation tickets and release late returned handles;
  do not populate a new selection with the old snapshot or silently retain its reasoning.
- Paging/save/commit errors and late completions need the same generation ownership. An
  old rejection must not discard a newer preview. Disable duplicate actions synchronously.
- Export/import and the shared reader fetch only the first comments page without controls
  to reach the remainder. Provide separate bounded comment pagination and an honest total.
- Shared-reader metadata survives a session change until the next response, so the old
  title/claims/comments can appear under the new session. Clear or key its full snapshot.
- Local comment authoring/replies/resolution and fresh shared continuation are still open
  P15 work. Read-only received comments alone do not satisfy that requirement.

Require deferred-response renderer regressions, actual page navigation through native IPC,
and verification that the saved snapshot is the one the user reviewed.

Second runtime review: delegated IDs (`parent#delegate-N`) have no turns.agent_id row. The
new findActiveTurn query therefore returns null for a child's local ask, broadcasts only
permission.request and persists no chat.block. The renderer has no permission.request
subscription; its cards come from blocks. Bind the child to its actual parent turn when
creating the capture/authorization context, preserve the child's separate grant identity,
and prove its ask appears and can be answered in the conversation. Do not recover a parent
by parsing display IDs or by using another agent's newest turn. Widget-origin asks likewise
need a deterministic originating turn/block association.

Native Sharing UI regression now fails at Prepare export: the page uses Promise.all for
entries and comments on the same handle, while main's staging.use admits one operation at
a time. The user sees 'this share is already being saved or imported' and the preview is
discarded. Both export and import use this pattern. Fetch those pages sequentially (or add
a deliberately reviewed combined bounded read contract), preserving exclusive save/commit
semantics. Evidence: `e2e-out/sharing-ui-native.log` and its Playwright error snapshot. The
preceding direct-IPC import/export/restart assertions in that run passed.

Codex admission review: command/file approval handlers capture this.active but do not compare
the incoming params.threadId/turnId to that active native turn before creating the card.
The cancellation fix prevents a request already admitted under an old turn from approving
after replacement; it does not reject an old turn's request arriving after replacement.
Add wrong-thread/wrong-turn/ended-turn admission refusal before card or local authorizer,
using the pinned protocol's required identifiers. Dynamic tools already have identity guards;
native approvals need their own protocol-appropriate equivalent.

PermissionCard still sends historical `allow_always` for its 'Allow for session' action.
The local broker correctly collapses that legacy value to once, so this UI currently cannot
mint a local session grant and misstates its button's effect. For request.localPolicy cards,
send decision allow with explicit scope session through the existing answer channel/store;
retain ordinary native behavior. Render rule/scope attribution and an owning-rule link.
Prove the user action creates a grant and an identical second call uses it, while a different
input/agent/lifecycle asks again. Approve aggregation remains required separately.

Local notes repository review (new 0011 foundation): label validation currently bounds JS
characters rather than the share format's UTF-8 bytes, so a stored multibyte author may fail
re-export. `remapEntry?.(original) ?? original` incorrectly restores an anchor when the
remapper deliberately returns null for withheld content. Validate block/entry ownership
and existence at creation/update; retain existing notes as unanchored if content later goes
away. Define a bounded export path instead of selecting every note without a count cap.
Received-comment replies are not yet representable by the local-only parent foreign key;
complete that requirement without mutating received rows or their canonical identity.

AskBroker finalization follow-up: normalize both legacy behavior allow_always and explicit
scope always to the effective once display (allow + scope always currently still records
always). If settleCard throws after deleting the waiter/detaching abort, ensure the waiting
authorization resolves denied/cancelled rather than becoming permanently unreachable.
Persisting an answer failure must never produce an executable allow.

Native API fixture `tests/e2e/localPolicyTools.spec.ts` uses the real provider adapter and
tool runtime with an owned loopback SSE endpoint, dummy key and Sonnet low metadata. Its
positive control writes the temporary project's sentinel. Local asks then fail before a
waiter is registered: createPermissionCardPublisher emits sessionId/agentId/request while
permission.request requires sessionId/turnId/blockId/request. Main parseEventPayload throws
after the card was stored. Fix the typed event publisher and add real schema validation to
its test. The native test now requires a streaming turn while waiting and a successful
answer delivery, so this error cannot masquerade as successful policy denial. Evidence:
e2e-out/policy-tools-native.log. Runtime worker was briefly interrupted to receive this
blocking finding and resumed with all its existing corrections retained.

The same fixture found an existing Windows path limitation: write_file rejects a short
8.3 absolute path under the project when main stores its expanded equivalent. The policy
fixture now uses a relative path, isolating policy behavior; the alias issue remains a
Windows path compatibility item to fix with canonical-parent/containment tests.

Widget integration review: runtime currently captures backend=originating agent backend but
always authorizes boundary api-tool. Claude/Codex captures advertise no api-tool availability;
define and test the intended host boundary semantics explicitly instead of silently treating
all widgets as API agents. Also the comment 'native host restrictions first' is not reflected
in callTool: bridge.get only verifies an open state, then local authorization runs, and the
bridge's tool allowlist check happens inside bridge.callTool afterward. An unadvertised tool
must be refused before creating a local ask or grant. Test the actual bridge, not a permissive
stub, including a valid Claude/Codex-origin widget call and a forbidden tool with an ask rule.

Native Claude probe review: offHostRequests currently counts absolute-form request URLs seen
by its own loopback server; it is not an observation of all child network traffic. Rename or
remove that field and narrow the claim accordingly. makeHomes should use a small Windows
process environment allowlist plus owned homes and dummy key (or case-insensitively strip
all provider auth/proxy/backend-selection variables), rather than inheriting unrelated real
provider credentials. Keep real model requests routed to the owned endpoint and disable
nonessential CLI network traffic where the pinned CLI supports it. No request bodies or
credential values belong in evidence. The sentinel/control precedence result is independent
of this reporting correction.
