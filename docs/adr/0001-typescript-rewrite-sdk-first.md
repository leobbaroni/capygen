# ADR-0001: Clean TypeScript rewrite, SDK-first engine

Date: 2026-09-05 · Status: accepted

## Context

Omnigent (Apache-2.0) is a 435k-line Python server plus a 260k-line React SPA. Its terminal
harnesses are tmux-based and refuse to run on native Windows (`omnigent/inner/terminal.py`);
its SDK harnesses do run there. The user wants a native-Windows standalone app with Omnigent's
UI and features, no server/host step, multi-model collaboration, dockable panes and in-app
harness management. Three routes were weighed: embed a fork of Omnigent, reuse only the SPA on a
new backend, or rewrite in TypeScript.

## Decision

Rewrite in TypeScript (Electron 44, React 18, Tailwind 4) and drive agents **headless through
their SDKs** — Claude via the Claude Agent SDK, Codex via `codex app-server`, API models via the
Anthropic/OpenAI SDKs with capygen's own tool runtime. The chat UI, permission/question cards and
plugin/skill screens are capygen's. No embedded interactive CLI TUI is a primary path; the
terminal pane can still open the raw CLIs.

## Consequences

- Full Omnigent parity is a staged goal (milestones M1–M7), not a single deliverable.
- One consistent UI across backends; no screen-scraping of TUIs; no tmux/ConPTY dependency for
  the core path (ConPTY remains for the terminal pane and any spike-identified gap).
- Omnigent is reference only (`reference/omnigent/`); its CSS tokens are reused verbatim under
  Apache-2.0 with NOTICE retained.
- Phase 1 must verify the SDK capabilities before anything builds on them.

## Reversal

If the Claude SDK cannot surface a required capability, the affected piece falls back to a
ConPTY-driven CLI session; the `Harness` interface isolates that change to one adapter.
