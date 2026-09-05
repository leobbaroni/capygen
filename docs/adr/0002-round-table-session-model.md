# ADR-0002: Session modes — round-table and solo orchestrator, both with routed sub-agents

Date: 2026-09-05 · Status: accepted

## Context

"Multiple models work with one another" can mean an orchestrator delegating to sub-agents on
other models (Omnigent's routing, Claude Code's `Task`) or several top-level agents sharing one
conversation. The user chose both, round-table first, selectable per session.

## Decision

- A session has a **mode**: `solo` (one lead agent) or `round-table` (N top-level agents).
  The mode can be switched later; history is preserved.
- Round-table dispatch: a user message goes to the @-mentioned agents in mention order; with no
  mention it goes to the **lead**. Agents may @-mention each other; an agent-to-agent chain
  stops after **3 hops** (per-session setting) until the user speaks or presses Continue.
- Every agent's sub-agent spawns pass through the **routing policy** (per-agent config or a
  session rule such as "sub-agents run on codex/gpt-5"); the policy is advisory and fails open.
- The transcript is one ordered list of turns; each agent turn records `agent_id`, optional
  `parent_turn_id` and `hop_index`. Agents see the shared transcript rendered with speaker
  labels; each backend receives it as its own conversation history.

## Consequences

- One dispatcher owns turn-taking; harnesses never talk to each other directly.
- Cost is visible per agent; the hop cap and a per-session budget alert bound runaway loops.
- Solo mode is round-table with one agent, so there is a single code path.

## Reversal

Mode is a session column; removing round-table means hiding the picker and the mention parser.
