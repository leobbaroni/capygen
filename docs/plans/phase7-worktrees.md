# Phase 7 worktree and commit implementation brief

Astra contract, prepared against the existing `GitService`, `DiffPane`, project store and
read-only reference `useHostWorktrees.ts` / `worktreeDefaultPreferences.ts`.
Implementation starts after the corrective runtime configuration batch is accepted.

## Identity and storage

A project remains one concrete execution directory. Git's resolved common directory identifies
the repository shared by its worktrees; it must never replace a session's execution directory.
Use Git's own worktree inventory as authority, and match registered project rows by canonical
path. Avoid a second persisted list of worktrees that can diverge after command-line changes.
Existing project rows and sessions must open without migration-induced cwd changes.

## Operations

- List worktrees for an explicit source project, returning main/linked, branch/detached,
  locked/prunable state and any matching project id. Parse machine-readable Git output with
  correct handling of spaces, Unicode and delimiters; pin the actual command in COMPAT.md.
- The composer chip offers the main directory, an existing worktree, or creation of a new one.
  Show the destination and branch before creation. A new session is created only after Git has
  successfully created/validated the chosen directory and its project row exists.
- New worktrees start from the chosen committed base; explain that uncommitted source changes
  are not copied. Validate branch/base inputs with Git, pass argument arrays, and prevent
  option/pathspec interpretation. No shell interpolation, fetch or implicit clone.
- On partial failure, report the actual surviving directory/branch. Do not delete user files
  as speculative rollback. Register only a successfully verified worktree.
- Removal rejects the main worktree, a different repository's directory, and an active session's
  execution directory. Git's locked state is respected. Any operation that would discard dirty,
  untracked or ignored user content requires a separate native destructive confirmation naming
  the exact directory; there is no automatic force retry.

Use the existing cleaned child environment and `windowsHide`; no default homes from tests.
Errors distinguish missing Git, non-repository, unborn HEAD, occupied branch, missing base,
locked worktree and access failure. Detached HEAD is represented accurately, not as a branch.

## Explicit commit selection

The existing Diff pane already sends checked paths, but `GitService.commit` still interprets
missing/empty paths as `--all`. Require a nonempty explicit selection in IPC and service code.
Reject paths outside the requested project and Git pathspec magic; a leading hyphen must be
treated literally. Do not include unrelated staged files. Preserve other index/worktree changes
and surface commit-hook failures without reporting a successful commit.

Refreshes retain the user's current checked selection for surviving paths. Newly discovered
changes must not silently become checked after the user made a selection. Clear selections on
project change. Bound status/diff refreshes and drop stale responses after selection changes.

## Acceptance

Real temporary Git repositories, with isolated Git configuration and fixture identity, prove:
create/list/register/restart; session and child cwd; Unicode/space paths; invalid branch/base;
unborn/detached/locked/dirty cases; no files removed on refusal; selection-only commit with
unrelated staged and unstaged content; hostile pathspecs; and source project changes unaffected.
Renderer tests prove selection persistence and explicit target payloads. Offline Electron e2e
creates a worktree through the chip, starts a fixture agent in it, edits a file, sees the diff,
and commits only selected paths. The existing full phase gate and independent review still apply.
