# Efficiency benchmark

Status: **passed, 2026-09-09**. The complete registered cohort measured **102.25%** of
the native CLI baseline, below the 110% limit. All six 20-turn lanes completed using the
separately authenticated test identity. No personal Claude/Codex credentials were copied.

## Reproducible cohort

The tracked workload is `scripts/benchmark/prompts.json` (exactly 20 prompts) and
`scripts/benchmark/fixture/INVENTORY.md`. The runner resets its owned temporary workspace
to identical bytes before every lane and starts a fresh native conversation each time.
The baseline uses the Agent SDK's pinned native Claude Code CLI. The application lane
uses the production `createSessionRunner.dispatch` solo path, `ClaudeHarness`, and a
throwaway database. This measures the desktop engine path, not renderer or Electron startup.
Both use `claude-sonnet-5`, low effort, plan permissions, the same capygen delegation MCP
schema, and no inherited settings sources. Both explicitly select the native `claude_code`
system preset with snapshot enabled. The app's 671-byte delegation instructions remain
app-only measured overhead. Both lanes enforce the same fixture-only Read restriction before
native permissions; native subagents and other tools are denied. Read is pre-approved;
unexpected permission/questions invalidate the lane.
No Codex or other model cohort is included.

Three pairs are pre-registered: baseline/app, app/baseline, baseline/app. Every cohort has
its own immutable directory identity under `e2e-out/benchmarks/`; collection updates only
that cohort's journal. Failed or incomplete cohorts remain visible and never acquire a
passing pooled ratio. A changed implementation requires a fresh complete cohort; retain
and publish the earlier cohort alongside it.

Run from the repository with the installed toolchain:

```powershell
corepack pnpm exec tsx scripts/benchmark/run.mts
# Above: pre-registration/unavailable report only; no model calls.

# Separately authenticate dedicated homes before opting into billed measurements.
# Never use personal .claude/.codex directories or copy their credentials.
powershell.exe -NoProfile -NoExit -ExecutionPolicy Bypass -File scripts/benchmark/login.ps1
# The visible confirmation names the pinned CLI command and isolated paths.
# Complete Claude sign-in yourself; this cohort makes no Codex model calls.
$env:CAPYGEN_TEST_CLAUDE_HOME = 'C:\capygen-test-identities\claude'
$env:CAPYGEN_TEST_CODEX_HOME = 'C:\capygen-test-identities\codex'
corepack pnpm exec tsx scripts/benchmark/run.mts --live
```

Missing or invalid homes stop before a model call. An authentication/provider failure
invalidates the cohort and preserves partial measurements. The runner does not perform
sign-in, installation, model substitution, or per-lane retries.
The runner creates its workspace under Windows Temp, outside the personal profile,
and replaces HOME/USERPROFILE/APPDATA/LOCALAPPDATA in child processes with a throwaway
home. Dedicated backend authentication directories remain explicit; empty settings
sources alone are not treated as protection against ancestor-based discovery.

## Accounting

Each completed turn records deltas between the SDK's cumulative per-model `modelUsage`
snapshots. Internal continuations and native compaction included in those cumulative
counters remain included. Counters that disappear or decrease invalidate the lane;
unknown usage is never replaced with zero. App meter events are not used as the benchmark's
source of truth, avoiding an apparently efficient score caused by dropped app accounting.

Processed tokens = uncached input + cache-read input + cache-created input + output.
Claude's input field excludes its separately reported cache counters. Separately reported
`modelUsage.thinkingTokens` is retained as reasoning, a subset of output and never added again. Cost is retained
separately, including unknown cost as null. Cache hits are observed, not assumed cold;
shared vendor caches may reduce the second lane's cost without reducing processed tokens.

Every report records requested settings, observed native CLI version, SDK version, model,
effort, fixture/prompt hashes, source revision/hash, run order and per-turn latency/usage.
Effective tool names, MCP status and native permission mode are compared by hash. No
transcripts, credentials or backend configuration contents enter the report.

The report includes all pair ratios, arithmetic mean, sample standard deviation (n−1),
range and pooled ratio: sum(app processed tokens) / sum(baseline processed tokens).
Acceptance requires all three complete valid pairs and pooled ratio ≤1.10. This describes
observed variation; three pairs do not establish a statistical confidence guarantee.

## Results

| Cohort | Source revision | Pairs | Pooled ratio | Verdict |
| --- | --- | --- | --- | --- |
| [Complete cohort](benchmark-results/2026-09-08T23-19-36-901Z-61d6a47b-4b52-4630-9de5-120e3b399a00.json) | ce2e6dc + recorded source hash | 3/3 | 1.022469 | pass |

| Pair / order | Baseline tokens | App tokens | Ratio |
| --- | ---: | ---: | ---: |
| 1 baseline → app | 846412 | 901351 | 1.064908 |
| 2 app → baseline | 851819 | 853210 | 1.001633 |
| 3 baseline → app | 851710 | 852674 | 1.001132 |

Arithmetic mean: 1.022558; sample standard deviation: 0.036677; range:
1.001132–1.064908. Pooled processed tokens: 2,549,941 baseline versus 2,607,235 app.
The source revision predates the task commit; the report also records the exact source
hash at collection start. Later terminal/UI/packaging repairs did not change the measured engine path.

All [retained journals](benchmark-results/) are published, including unsuccessful and
diagnostic attempts. The first two live attempts exposed an unpinned native helper model;
the next partial cohort exposed the app environment scrub removing the effort override.
The 23:13 UTC cohort completed one pair before a Windows cwd lock interrupted reset;
its baseline also omitted the explicit native CLI system preset and is not an acceptance
comparison. Diagnostic runs identified the delegation MCP mismatch and verified final
preset/tool parity. None of those lanes was reused or selectively replaced in the passing
cohort. Missing usage and incomplete cohorts retain `unavailable` verdicts.

Publish every real cohort here, including unsuccessful cohorts, with links to its retained
report. Offline accounting fixtures and request-capture tests do not satisfy the live
20-turn measurement requirement.

## Implementation checks (not benchmark results)

The round-table history path now asks SQLite for text only, excluding delegated content and
streaming turns before rows reach JavaScript. A fixture with 3.6 MB of tool data verifies the
projection stays below 1500 bytes while preserving empty settled-turn watermarks.

API context compaction has a separate same-model provider fixture: at the configured
threshold it summarizes bounded older groups, preserves recent tool pairs, keeps the primary
system/tools stable, and includes summary usage. Unknown model capacity disables this path;
set `config.api.contextWindowTokens` only to the verified capacity of the chosen model.
The context estimate is UTF-8 bytes/4 plus output reserve and is not the benchmark denominator.
