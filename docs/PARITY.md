# Parity and requirement evidence

This maps the implemented requirements to observed evidence. Phases 1–11 and 9C are accepted;
Phase 12 still requires clean CI, release publication and the actual older-build updater check.
The latest local gate passed 2923 unit tests and 56 native tests; 4 units and 12
credential-dependent native cases were explicitly skipped.

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
| P18 Dictation | User-confirmed Whisper microphone transcription; bounded capture/progress/cancel fixtures | CPU latency varies by hardware; draft remains editable |
| P19 Local host/raw terminal | `hosts.spec.ts`, `tests/packaged-smoke.spec.ts` raw Codex startup | Local scope; remote hosts parked |
| P20 Extensions | `extensions.spec.ts`: real isolated view, storage/reopen/theme/network denial | Native sample passed; no claim of arbitrary third-party compatibility |

## Requirements

| Requirement | Evidence map | Status |
|---|---|---|
| R1–R4 | launch/shell e2e; `prereqs/runGate.ts` tests; `UpdatesSection.test.tsx`; packaging scripts | R4 live feed/published release open |
| R5–R6 | session, transcript block and renderer component tests | Native/fixture coverage; live provider-specific cases remain separate |
| R7–R8 | Claude/Codex spike docs and native MCP/session evidence | Authenticated live backend proof remains separate |
| R9 | API harness/provider tests, `apiCompaction.test.ts`, tool runtime tests | Live API smoke remains open |
| R10–R12 | round-table/custom delegation tests and routing evidence | Accepted phases 4 and 9C; bounded fixture routing and restart proved |
| R13–R15 | agent info/slash/session persistence and restart e2e | Accepted historical gate for existing paths |
| R16–R18 | workspace/pane/dev-server tests and native drag/restart evidence | Native workspace and packaged ConPTY checks pass |
| R19 | settings navigation and section tests | Accepted historical gate; private updater live acceptance remains |
| R20–R21 | backend config round-trip tests; secrets/safeStorage tests | Live external CLI permutations remain open |
| R22 | this P1–P20 inventory and the extension capability mapping | Local-scope inventory accounted for; backend limitations remain explicit |
| R23–R26 | usage/cache/compaction/output-limit fixtures and complete live paired cohort | Sonnet 5 low: 102.25% baseline tokens; other provider-live permutations not measured |
| R27 | prereq/install gates, policy runtime tests, visible update confirmation path | Confirmation/cancel fixtures pass; smoke does not execute an installer |
| R28–R29 | integration settings, backend file watchers and MCP tests | Full connector/live CLI matrix open |
| R30 | global settings schema/repository and settings UI tests | Focused evidence |
| R31 | MCP Apps host/widget fixture tests | Live Higgsfield connector remains open |
| R32 | permission/question/elicitation/approval fixture tests and Claude evidence | Backend-specific edge cases remain open |

Open Phase 12 acceptance areas are the actual private-feed updater check, published release,
and full clean CI. Local 0.1.1 installer/portable/feed audit and packaged runtime pass.
Provider-specific live API, connector and backend permutations listed above remain explicit
coverage limitations; the completed benchmark is the documented Claude cohort only.
