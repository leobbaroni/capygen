# Parity and requirement evidence

This is an evidence map, not an acceptance claim. “Accepted” refers to the historical Phase 9 and 9C
gates; focused tests and implementation proofs below do not replace the full Phase 10–12 gate.

## Parity inventory

| Item | Current evidence / implementation | Gap |
|---|---|---|
| P1 Landing | `tests/e2e/launch.spec.ts`, `worktrees.spec.ts`, mascot tests | Microphone acceptance listed under P18 |
| P2 Chat | `skeleton.spec.ts`, `roundtable.spec.ts`, transcript/block component suites | Live backend fixtures require dedicated auth |
| P3 Sessions | launch/restart suites, sidebar/session component tests | Historical accepted gates |
| P4 Workspace | `workspace.spec.ts`, pane component tests | Historical accepted gates |
| P5 General settings | `settings.spec.ts`, UpdatesSection tests | Actual private updater proof open |
| P6 Backend settings | settings/config round-trip and catalogue suites | Native backend format limitations in COMPAT.md |
| P7 Setup | prerequisites/runGate suites | Visible real sign-in remains user operated |
| P8 Projects/worktrees | `worktrees.spec.ts`, project/git fixtures | Phase 7 accepted |
| P9 Import | `imports.spec.ts`, import worker fixtures | Unsupported transcript cases reported explicitly |
| P10 Tasks | `activity.spec.ts`, Tasks component/repository tests | Phase 8 accepted |
| P11 Inbox | `activity.spec.ts`, Inbox/deduplication tests | Phase 8 accepted |
| P12 Usage | `activity.spec.ts`, per-model meter tests | Live efficiency ratio is separate Phase 11 evidence |
| P13 Automations | native minute-timer activity proof, scheduler fixtures | Phase 8 accepted; app/tray must remain running |
| P14 Session MCP/catalogue | `sessionMcp.spec.ts`, native scoped MCP fixtures | Phase 9 accepted |
| P15 Sharing/comments | `sharingShell.spec.ts`, share worker/redaction fixtures | Phase 9 accepted; local sharing scope |
| P16 Local members/accounts | `localPoliciesShell.spec.ts`, role/config fixtures | Local scope; no cloud membership service |
| P17 Policies/Approve | `localPolicyTools.spec.ts`, policy/routing fixtures | Phase 9 accepted |
| P18 Dictation | compiled helper metadata, DictationService and composer fixtures | Real microphone transcription pending |
| P19 Local host/raw terminal | `hosts.spec.ts`, `tests/packaged-smoke.spec.ts` raw Codex startup | Local scope; remote hosts parked |
| P20 Extensions | `extensions.spec.ts`: real isolated view, storage/reopen/theme/network denial | Native sample passed; no claim of arbitrary third-party compatibility |

## Requirements

| Requirement | Evidence map | Status |
|---|---|---|
| R1–R4 | launch/shell e2e; `prereqs/runGate.ts` tests; `UpdatesSection.test.tsx`; packaging scripts | R4 live feed/published release open |
| R5–R6 | session, transcript block and renderer component tests | Focused coverage; full parity audit open |
| R7–R8 | Claude/Codex spike docs and native MCP/session evidence | Authenticated live backend proof remains separate |
| R9 | API harness/provider tests, `apiCompaction.test.ts`, tool runtime tests | Live API smoke remains open |
| R10–R12 | round-table/custom delegation tests and routing evidence | Custom Mode integration newly accepted; broader parity open |
| R13–R15 | agent info/slash/session persistence and restart e2e | Accepted historical gate for existing paths |
| R16–R18 | workspace/pane/dev-server tests and native drag/restart evidence | Full visual parity remains open |
| R19 | settings navigation and section tests | Accepted historical gate; private updater live acceptance remains |
| R20–R21 | backend config round-trip tests; secrets/safeStorage tests | Live external CLI permutations remain open |
| R22 | this P1–P20 inventory | P18 microphone acceptance remains |
| R23–R26 | usage tests, API compaction tests, dynamic output/MCP catalogue tests | Benchmark evidence and some provider-live cases open |
| R27 | prereq/install gates, policy runtime tests, visible update confirmation path | Packaged install proof remains open |
| R28–R29 | integration settings, backend file watchers and MCP tests | Full connector/live CLI matrix open |
| R30 | global settings schema/repository and settings UI tests | Focused evidence |
| R31 | MCP Apps host/widget fixture tests | Live Higgsfield connector remains open |
| R32 | permission/question/elicitation/approval fixture tests and Claude evidence | Backend-specific edge cases remain open |

Known open acceptance areas are real microphone behavior, live model/API benchmarks, private-feed
and updater behavior, published-release verification, and full CI acceptance (clean packaging diagnostic and local runtime proof passed). No entry here
claims those checks passed.
