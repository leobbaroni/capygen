# ADR-0006: Custom Mode as a reviewed declarative crew policy

Date: 2026-09-07 · Status: accepted design; implementation and capability proofs pending · Implements R33–R34

Astra leads this decision; Fable 5.1 reviewed existing routing and round-table mechanisms.
The user requests a third mode choice with prompt generation, editable visual and code views,
role/difficulty routing, and solo work combined with in-chat decision debate.

## Decision

The UI offers Custom alongside Solo and Round-table. A custom session uses the existing
round-table dispatcher plus a versioned `SessionSettings.crew` policy; it does not introduce
another independent dispatcher. One strict declarative JSON document is authoritative.
Visual controls and the text editor project that same document without losing fields.
No JavaScript, arbitrary expressions or executable policy scripts are accepted.

The document contains a roster of named lead/member/worker targets (backend/model/effort),
ordered routing rules matching task kind and difficulty, an explicit default worker,
per-role instructions and a debate configuration. Exactly one lead is required. All target
references and model/effort availability are validated, including again when Apply runs.
Ordered rules use first-match precedence, shown in both views. No implicit model substitution.

Members participate in the shared chat; workers run through existing delegation. The lead
supplies structured task kind/difficulty to delegation; the runtime chooses the target and
records that choice. Classification is a lead decision, not a claim that the app understands
all task semantics. A structured decision/debate request records a queue intent on the active turn. After that
turn ends, the existing dispatcher runs debaters then the lead in the same chat, including
an explicit return-to-lead queue entry (mention parsing alone drops self-hops). The request
refuses when insufficient hops remain (one debater and a final decision need two hops).
Debate allowance never exceeds the remaining session hop limit. Existing
permissions, cancellation and usage accounting apply to both mechanisms.

Legacy R12 fail-open behavior remains for ordinary sessions. Custom policy route failures
are visible structured refusals; they do not instruct the model to fall back to an inherited
model. Native spawns that cannot be routed under a custom policy are denied with guidance to
use the structured delegation tool; do not label an uncontrolled native spawn policy-routed. Unsupported cross-backend delegation blocks activation of affected custom modes until
the Phase 9 Codex bridge capability proof succeeds. The user's Astra-led example must work
before R34 acceptance; a Claude-only workaround is not completion of that example.

Generation is a bounded, cancellable, billed draft operation on the user-selected available
model in an empty temporary workspace with backend-specific configuration isolation. Production
authoring uses the user-selected authenticated backend home (never copies credentials). Claude
requires tools:[], settingSources:[], no hooks/MCP and one turn; API has no tools/MCP; Codex
requires a proven way to disable or deny tool execution and inherited MCP before this authoring
path is enabled. Read-only sandbox alone is not proof of no tool access. Tests use only dedicated
isolated test identities. Only the schema,
necessary model IDs/capabilities and the user's prompt enter that authoring context. No keys,
backend settings or unrelated session history. Invalid output stays a draft with errors.

Preview shows the complete routing, instructions, roster changes and affected backend
restarts. Apply requires an idle session with no pending interactions; persist policy and
roster changes atomically, then restart affected harnesses with stable prompt additions.
A restart failure remains visible and retryable, never misreported as a successful runtime.
History and prior turns remain unchanged; deleting a policy does not delete chat history.
The quiescence check covers active turns, queued chains and unanswered interaction blocks,
not only the session status field. Authoring usage is persisted under a dedicated archived
policy-authoring session, keeping its transcript out of the target working conversation.
Strict crew schemas do not reuse legacy passthrough targets. Canonical equality uses parsed
values with defaults applied, not raw whitespace/key ordering. Routed subagent blocks include
optional rule identity, classified kind/difficulty and resolved target for visible evidence.

## Verification and consequences

Phase 9C follows Phase 9 permission/delegation implementation. Tests prove visual/JSON
round-trip, validation and error recovery, draft cancellation, apply/restart persistence,
routing of each example branch, decision→debater→lead ordering, hop/cancel/permission limits,
and visible runtime unavailability. Fixtures verify the full example without model calls.
Any live test prompts use only GPT Luna low and Sonnet 5 low as the user now requires.

Fable reviewed two rounds; Astra resolved the identified dispatcher, hop, native-spawn,
authentication, billing, quiescence, schema and routing-evidence gaps in this contract.
