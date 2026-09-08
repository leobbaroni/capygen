# Phase 9C implementation sequence

Astra lead, 2026-09-08. Implements accepted ADR-0006 and SPEC R33–R34 after Phase 9
acceptance. No additional framework or independent dispatcher. Current crew has no Fable
review; the ADR's earlier Fable review is historical. Nothing here marks implementation done.

1. Shared contract first: strict versioned crew document, semantic validation of exactly one
   lead and all roster/routing/debate references, first-match routing, explicit default worker,
   supported task/difficulty vocabulary, model/backend/effort availability. Keep instructions
   bounded and inert. Add custom session mode and optional crew settings without changing
   existing solo/round-table defaults. Central IPC contracts must land before parallel wiring.
2. Runtime and persistence: use existing RoundTable and SessionRunner, with structured
   delegation classification and recorded resolved route. Custom failures refuse visibly;
   preserve ordinary R12 fallback. Queue debate only after the active turn, enforce remaining
   hops and explicit return to lead, stop on cancellation or refusal. Apply checks quiescence
   and current model availability, atomically persists roster plus settings, then releases
   affected captures; expose restart errors without rewriting past turns. No grants transfer.
3. Isolated authoring: selected available backend, empty owned temporary project, no tools,
   hooks or MCP, bounded one-turn output and cancellation, normal usage accounting in a
   dedicated archived authoring session. Prove Codex tool denial and inherited-MCP isolation
   against the pinned app-server before enabling it. Read-only sandbox alone is insufficient.
   Use dedicated test homes and local provider fixtures; any real prompts only Luna/Sonnet low.
4. Renderer: small prompt box and generator selection, complete visual and JSON editors over
   one parsed document, errors remain editable, preview includes all instructions/rules/roster
   changes and restart consequences. Apply uses the normal idle guard and shows failure.
   Preserve fields while switching views; do not silently substitute unavailable models.
5. Native acceptance: persist/apply/restart, exact user-diagram offline routes, debate return
   ordering, hop refusal, pending-permission refusal, cancellation and unavailable assignment.
   Include generation invalid output and no-tool positive/negative fixtures. Independent model
   review, fix high/medium findings, then full project gate before ticking Phase 9C.

Parallel ownership after contracts: Opus desktop runtime/authoring versus Opus renderer;
Luna bounded fixtures/docs where independent. Root owns integration e2e, final decisions and
serial staging/commits. Shared contract changes are coordinated through the lead; no two
workers edit the central schemas simultaneously. Follow-on Phase 10 work uses its separate
extension brief and must also deliver dictation, local Hosts and raw terminal attachment.
