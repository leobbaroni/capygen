# Parity and requirement evidence

This maps the implemented requirements to observed evidence. Phases 1–12 and 9C are accepted;
v0.1.3 has clean CI, publication, actual older-build discovery and installed/uninstall proof.
The latest local gate passed 2923 unit tests and 56 native tests; 4 units and 12
credential-dependent native cases were explicitly skipped.

## Parity inventory

| Item | Current evidence / implementation | Gap |
|---|---|---|
| P1 Landing | `tests/e2e/launch.spec.ts`, `worktrees.spec.ts`, mascot tests | Microphone acceptance listed under P18 |
| P2 Chat | `skeleton.spec.ts`, `roundtable.spec.ts`, transcript/block component suites | Live backend fixtures require dedicated auth |
| P3 Sessions | launch/restart suites, sidebar/session component tests | Historical accepted gates |
| P4 Workspace | `workspace.spec.ts`, pane component tests | Historical accepted gates |
| P5 General settings | `settings.spec.ts`, UpdatesSection tests, actual 0.1.2 → private 0.1.3 discovery | 0.1.0/0.1.1 need manual repair |
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
| R1–R4 | launch/shell e2e; `prereqs/runGate.ts` tests; updater tests; published v0.1.3 and installed smoke | R4 live private discovery passed; installed focused launch 2946ms |
| R5–R6 | session, transcript block and renderer component tests | Native/fixture coverage; live provider-specific cases remain separate |
| R7–R8 | Claude/Codex spike docs and native MCP/session evidence | Authenticated live backend proof remains separate |
| R9 | API harness/provider tests, `apiCompaction.test.ts`, tool runtime tests | Live API smoke remains open |
| R10–R12 | round-table/custom delegation tests and routing evidence | Accepted phases 4 and 9C; bounded fixture routing and restart proved |
| R13–R15 | agent info/slash/session persistence and restart e2e | Accepted historical gate for existing paths |
| R16–R18 | workspace/pane/dev-server tests and native drag/restart evidence | Native workspace and packaged ConPTY checks pass |
| R19 | settings navigation and section tests | Accepted gate and private updater live discovery passed |
| R20–R21 | backend config round-trip tests; secrets/safeStorage tests | Live external CLI permutations remain open |
| R22 | this P1–P20 inventory and the extension capability mapping | Local-scope inventory accounted for; backend limitations remain explicit |
| R23–R26 | usage/cache/compaction/output-limit fixtures and complete live paired cohort | Sonnet 5 low: 102.25% baseline tokens; other provider-live permutations not measured |
| R27 | prereq/install gates, policy runtime tests, visible update confirmation path | Confirmation/cancel fixtures pass; hosted NSIS smoke is isolated; updater discovery invokes no install |
| R28–R29 | integration settings, backend file watchers and MCP tests | Full connector/live CLI matrix open |
| R30 | global settings schema/repository and settings UI tests | Focused evidence |
| R31 | MCP Apps host/widget fixture tests | Live Higgsfield connector remains open |
| R32 | permission/question/elicitation/approval fixture tests and Claude evidence | Backend-specific edge cases remain open |

Phase 12 is accepted: full clean CI and tag publication passed for v0.1.3; actual packaged
0.1.2 discovers the private release; the exact published installer passes installation,
runtime/restart and uninstall/data-preservation checks. See `release-results/v0.1.3/README.md`.
Provider-specific live API, connector and backend permutations listed above remain explicit
coverage limitations, including authenticated transcript reconstruction through the installed SDK worker; the completed benchmark is the documented Claude cohort only.
