# capygen — CONTEXT (glossary)

Terms used in SPEC.md, PLAN.md, code and UI. One meaning each.

- **capygen** — this app. Product name shown in the wordmark (CheGuevaraBarry-Brown font).
- **Backend** — where an agent's model runs: `claude` (Claude Code via the Claude Agent SDK),
  `codex` (Codex via `codex app-server`), or `api` (a model reached directly through the
  Anthropic/OpenAI/OpenRouter APIs with capygen's own tool runtime).
- **Harness** — capygen's adapter for one backend. Implements the `Harness` interface
  (start, send, interrupt, resume, listCommands, capabilities). One harness instance per agent.
- **Agent** — a named participant in a session: backend + model + role + config. The **lead**
  is the agent that receives unaddressed messages and, in solo mode, the only top-level agent.
- **Session** — one conversation in one project directory, in one **mode**:
  - **Solo orchestrator** — one lead agent; it may spawn sub-agents.
  - **Round-table** — several top-level agents share the transcript and @-mention each other.
- **Turn** — one message by the user or an agent, with its blocks (text, thinking, tool calls,
  cards). Agent-to-agent turns carry a **hop index**; the **hop cap** (default 3) stops chains.
- **Sub-agent** — an agent spawned by an agent's own tool (Claude `Task`, Codex `spawn_agent`).
  **Routing policy** decides which backend/model a sub-agent runs on; it fails open.
- **Block** — a rendered unit inside a turn: text, thinking, tool_call, diff, permission,
  question (AskUserQuestion), subagent, error, usage.
- **Pane** — a dockable workspace panel: Files, Editor, Diff, Browser, Terminal, Agents,
  Tasks, Servers. **Layout** — the dockview arrangement, saved per project.
- **Dev server** — a detected or configured long-running process (`.claude/launch.json`,
  package scripts, …) with Start/Stop and a preview URL.
- **Setup panel** — the prerequisites screen: each step confirms its exact command and runs it
  in a visible console. Nothing installs silently.
- **Mascot** — the reactive pixel capybara on the landing page; its **state** mirrors the active
  session (idle, thinking, working, waiting-for-you, success, error, sleeping, listening).
- **Parity item (P#)** — one Omnigent surface listed in SPEC.md §P that capygen reproduces.
- **Reference** — `reference/omnigent/`: Omnigent's SPA sources, routes and API description,
  read for layout/behaviour, never imported.
- **Compaction** — replacing older context with a summary when usage crosses the threshold.

- **Custom Mode** — a reviewed declarative crew policy layered on the round-table dispatcher:
  a lead, optional chat members for decision debate, and worker targets selected by task rules.
  The visual editor and JSON editor operate on the same versioned document (ADR-0006).
