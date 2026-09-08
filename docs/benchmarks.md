# Efficiency benchmark

Status: **unavailable — no live benchmark has run**. No processed-token ratio or Phase 11
acceptance is claimed. Separately authenticated dedicated test homes are required; the
current orchestration login does not satisfy that prerequisite. No personal credentials
are read or copied by the benchmark.

## Reproducible cohort

The tracked workload is `scripts/benchmark/prompts.json` (exactly 20 prompts) and
`scripts/benchmark/fixture/INVENTORY.md`. The runner resets its owned temporary workspace
to identical bytes before every lane and starts a fresh native conversation each time.
The baseline uses the Agent SDK's pinned native Claude Code CLI. The application lane
uses the production `createSessionRunner.dispatch` solo path, `ClaudeHarness`, and a
throwaway database. This measures the desktop engine path, not renderer or Electron startup.
Both use `claude-sonnet-5`, low effort, plan permissions, no MCP servers, and no inherited
settings sources. Both lanes enforce the same fixture-only Read restriction before
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
$env:CAPYGEN_TEST_CLAUDE_HOME = 'C:\capygen-test-identities\claude'
$env:CAPYGEN_TEST_CODEX_HOME = 'C:\capygen-test-identities\codex'
corepack pnpm exec tsx scripts/benchmark/run.mts --live
```

Missing or invalid homes stop before a model call. An authentication/provider failure
invalidates the cohort and preserves partial measurements. The runner does not perform
sign-in, installation, model substitution, or per-lane retries.

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

## Results awaiting measurement

| Cohort | Source revision | Pairs | Pooled ratio | Verdict |
| --- | --- | --- | --- | --- |
| None run | — | 0/3 | unavailable | unavailable |

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
