# ADR-0007: Local policy enforcement at observable execution boundaries

Date: 2026-09-07. Status: Astra design decision; implementation and capability proofs pending.
Implements Phase 9 / P17. Opus inspected the pinned SDK/protocol; Astra owns this decision.

## Authority

Backend configuration files remain authoritative for native permission rules. Capygen's
additional local restrictions and scoped grants are application state, not a copied native
policy store. The existing integrations cache must not become a second authority. Native
Claude permission edits continue through its config store. A separate local rule store uses
explicit global/project/session identity, avoiding the legacy cache's project-name collision.

Rules match backend and tool name, using bounded literal text with `*` wildcards only.
Do not add arbitrary regex, executable expressions or argument matching in v1. Across all
applicable scopes, deny wins, then ask, then allow; a narrower allow cannot defeat a broader
deny. Scope specificity and stable rule identity choose attribution among equal decisions.
Refusals identify the owning rule and scope and link to that rule's editor; exceptions require
editing that owning restriction, not silently bypassing it. An evaluation/storage failure
refuses execution; R12's routing fail-open does not apply.
Native hard denials and API plan-mode denials still win over a local allow or grant.

API tools consult current policy per call at dequeue immediately before execution, including
MCP and delegated tools; admission of a batch never authorizes its later queued calls. A waiting approval rechecks current policy and cancellation after the answer arrives.
Modified approval input is revalidated before execution. MCP App widget tool calls consult
the same originating session/agent policy before host execution; widget visibility alone is
not authorization. No policy/config object enters prompts.

Claude's `canUseTool` callback is not universal under native allow rules or bypass mode.
Use one matcher-less PreToolUse hook, with subagent routing as a branch inside it. Local deny
returns deny. Local ask waits on capygen's existing permission card; approval returns a neutral
hook decision so native rules still apply. A local allow never returns an unconditional native
allow. Session-fixed disallowedTools may enforce fixed restrictions, but are not a substitute
for revocable runtime rules. Native bypass/allow precedence requires a dedicated live proof;
unproven coverage must not be described as complete enforcement.

Codex exposes command/file/permission approval requests and dynamic client-tool calls, not a
universal native-tool callback. Local policy enforcement is limited to those boundaries.
Each rule names its enforcement boundary: API tool, Claude pre-tool hook, Codex dynamic client
tool, or Codex approval category. The editor names that exact boundary and its limitations.
Activating a session restriction for an unavailable boundary is refused (including native
Codex approval restrictions under `never`). Global rules may be stored for future compatible
sessions; dispatch refuses affected sessions whose boundary cannot satisfy their rules.
Every dispatch refusal names the unavailable boundary and links to the owning rule/scope
editor, just like a per-tool refusal. Do not silently change approvalPolicy/sandbox settings.
Capability availability belongs to the specific agent and captured harness lifecycle. Never
union one agent's supported boundaries into another agent's authorization. Dispatch checks the
actual target backend; a Codex-only global rule does not block an API-only target. Delegated
children and automation runs receive their own checks.
Codex MCP/web/native-spawn interception remains unavailable until a concrete supported path
is proved. `never` approval mode cannot advertise native approval-category enforcement.

## Grants, cancellation and audit

Allow once authorizes only the current request. Allow for session creates an exact grant for
the session, originating agent/backend, tool and canonical input signature, bound to the
captured connection/configuration lifecycle. The signature includes the complete JSON input
with recursively sorted object keys, array order and string bytes preserved, no field elision
and no Unicode normalization, plus execution cwd. It is exact equality, never wildcard matching.
Main mints an opaque authorization lifecycle token per harness and captured widget connection;
the captured MCP pool connection identity (including credential/configuration-sensitive
identity from ipc/mcpPools.ts) is the source of truth, never a display name or server URL alone.
A new connection instance or restarted harness gets a new token even if its settings look equal.
Credentials and the private connection identity are never exposed in grant UI or audit records. The token is part
of grant equality. A grant is not a policy rule: it only satisfies an exact `ask` outcome after
current deny checks, and can never override a deny. It does not authorize a different tool input,
agent, endpoint or later restarted backend lifecycle. No permanent grant is created by that
button. Explicit policy edits are the persistent way to allow a tool. Existing historical
`allow_always` records are not migrated into authority.

Policy changes, revocation and session shutdown invalidate affected grants. Pending calls
re-resolve at execution; revocation cannot undo a tool already executing. Delegated children
retain independent approval requirements and never inherit the parent's bypass/grant.

Audit records contain request/session/agent identity, tool name, policy/grant identity,
decision/source/scope/time, actual enforcement boundary/availability and actor display metadata. Do not copy tool arguments, credentials
or arbitrary output into the audit. Imported transcripts/shares never create grants or approvals.
The Approve page addresses existing pending requests and reuses the permission answer path;
stale cards do not become successful decisions.

## Local identity boundary

This is a single Windows-user application, not remote multi-user authentication. Member labels
must not be presented as verified identities. The Phase 9 member-role contract must bind its
session subject in the main process and gate dispatch/approval there; a renderer-supplied role
is never authority. Do not claim isolation against the operating-system account that owns the
profile. Members are named local execution profiles with owner/editor/viewer roles. The application
operator manages them; they are not logins. A session may select a member, and main resolves
that persisted assignment before dispatch and tool approval. A viewer can inspect history but
cannot dispatch turns or approve tool execution. An editor may dispatch and answer ordinary
approvals under current backend/local restrictions. Owner has the same execution restrictions
and may explicitly manage policy/grants. The UI names this as the session execution role, not
the identity of the person at the keyboard. Ordinary reassignment requires a quiescent session; restrictive revocation to viewer is the
explicit exception and immediately interrupts execution and denies waiting approvals.
Removing an assigned member is refused until sessions are reassigned. Existing sessions use
the built-in local owner profile, without importing any identity from transcript contents.
Automations resolve the source session's current member at fire time and copy that assignment
to the fresh run before dispatch. A viewer/revoked member produces a visible refused run with
no model call; it never silently falls back to owner. Audit member labels remain explicitly
unauthenticated display labels, not a claimed attribution to a verified person.

## Verification

Pure rule tests prove bounded matching, deny/ask/allow precedence, scope attribution and errors.
Actual harness captures prove API denial before tool execution, Claude hook behavior, and Codex
request/reply enforcement. Revocation while approval waits and input changes are regression
cases. Native capability checks use only owned homes; authenticated proofs use dedicated
identities and only Luna low / Sonnet 5 low. Synthetic transport proves client handling, not
that a live model chose a tool. Phase 9 remains open until its Done-when and full gate hold.

## Widget execution-site clarification (Astra, 2026-09-08)

A widget call is executed by the app's MCP host, while its restrictions and grant identity
belong to the originating agent/backend. Evaluate the origin's tool rule family: api-tool,
claude-pre-tool or codex-dynamic-tool respectively. This deliberately also restricts widgets
opened by that origin; it does not claim interception of Codex's native MCP calls. Keep
actual execution site separately as widget-host in display metadata. Do not reinterpret a
Claude/Codex origin as API, or apply unrelated backend/category rules.

The execution site is a main-owned capture fact. A request claiming widget-host cannot bypass
backend equality, capture ownership, lifecycle checks or tool-family selection. A backend
capture still requires its actual boundary availability; only a captured widget connection
uses the app host's interception point. Its connection token keeps grants separate from the
origin harness and other widget connections. Connection disposal settles pending cards and
revokes its grants. The UI must identify host execution so a tool-family label is not mistaken
for proof that the native backend intercepted this widget call.
