# Phase 11 measurement brief

Astra preparation, 2026-09-08. No benchmark has run and no ratio is claimed here.
SPEC G9 requires a measured 20-turn session at no more than 110% of the Claude Code CLI
baseline. The reference harness-bench document describes capability conformance, explicitly
not performance measurement; its pass/skip matrix cannot substitute for this requirement.

## Paired baseline before optimization

Use one tracked, non-sensitive fixture workspace and exactly 20 tracked prompts. Run the
native Claude Code baseline first, then the app's normal solo-session path with the same
model, effort, workspace contents, tools, MCP settings and native permissions. Both paths
must actually use the pinned native CLI. A direct Agent SDK baseline is acceptable only if
the report proves the underlying CLI/version and records its options; an in-memory harness
double is not the CLI baseline.

Use `claude-sonnet-5` at low effort. Any supplementary Codex measurement uses
`gpt-5.6-luna` at low. Reuse the existing test-policy validators and separately authenticated
test homes (`CAPYGEN_TEST_CLAUDE_HOME` / `CAPYGEN_TEST_CODEX_HOME`); never copy personal
credentials or point tests at personal homes. Missing authentication reports unavailable,
not a passing ratio. Orchestration login is not proof of an authenticated isolated test home.

Run fresh conversations for the two lanes and reset the owned workspace to identical bytes
between them. Record versions, effective model/effort, fixture/prompt hashes, settings and
run order. Do not include secrets or backend configuration contents in the report. Record
observed cache hits rather than claiming both runs were cold; vendor cache sharing may make
the second lane cheaper without changing the amount of context it processes.

## Accounting and verdict

Record each turn's actual usage, including internal continuations and compaction calls.
Do not sum cumulative usage snapshots as if each were a new call. Preserve input, cache-read,
cache-write, output and any separately reported reasoning counts in distinct columns, with
the exact backend accounting semantics documented in COMPAT.md.

The acceptance ratio uses total processed tokens: uncached input plus cache-read input plus
cache-created input plus output, avoiding double-counting fields that a backend already
includes in a parent total. Cost, latency and cached fraction are useful separate measures;
a cost reduction is not proof of the token requirement. Unknown usage is unavailable, not
zero. Baseline zero, incomplete turns, cancellation, provider errors or mismatched settings
invalidate the comparison rather than produce an attractive ratio.

Pre-register three paired 20-turn runs. The first pair runs baseline first; alternate lane
order for subsequent pairs and record it. Reset the owned workspace to identical bytes for
every lane and use fresh conversations. Report every pair, the mean, standard deviation
and range, plus the pooled ratio (sum of app tokens / sum of baseline tokens). The pooled
ratio must be at most 1.10. Three pairs describe observed variation, not a confidence claim.
Missing or invalid pairs leave the cohort unavailable; never discard a failed valid pair.
If optimization changes the implementation, retain the old cohort and run a new complete
cohort with its source revision recorded. Publish all results in docs/benchmarks.md.
Caching can reduce cost without reducing processed tokens; report both effects separately.

## Independent efficiency checks

- Capture Anthropic requests in owned fixtures: session-stable system/tool prefixes and
  cache_control markers at the actual provider boundary, not just a helper's return value.
- Trigger compaction at a configurable threshold with a bounded fixture. Preserve the latest
  user intent and pending state, account for compaction work, and prevent repeated triggering
  on the same usage snapshot. Native and API backends need their own supported mechanism.
- Prove tool outputs above 64 KiB are stored whole with an outputRef but only a bounded stub
  enters subsequent model context. Include UTF-8 boundaries and all backend paths.
- Prove MCP schema discovery is lazy and cached per captured connection lifecycle; settings,
  catalogues, policy views and IPC updates must not become model context.
- Fix the known RoundTable.ts full-history read on every turn; use bounded projections rather
  than loading all tool payloads to discard them. Keep that finding visible until measured.

The Phase 11 gate combines these fixture proofs, the real paired result and the full project
gate. Offline conformance and skipped live tests do not meet the measured acceptance bar.
