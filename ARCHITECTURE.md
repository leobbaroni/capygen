# capygen architecture

Electron owns the privileged boundary. The main process holds SQLite, canonical backend config,
safeStorage secrets, filesystem/git/terminal services, update and dictation helpers, and harness
sessions. The preload exposes the typed, zod-validated IPC contract. The React renderer owns views
and local presentation state; it never receives credentials or backend configuration. Context
isolation, sandboxed extension views, and separate capability ports keep extensions away from raw
IPC, model prompts, and ambient network access.

`packages/shared` defines domain and IPC schemas. `packages/db` stores migrations, sessions, blocks,
agents and usage in SQLite. `packages/engine` runs Claude, Codex and API harnesses, routing and
round-table turns; backend files remain the source of truth for plugins, skills and MCP servers.
Usage is accounted per model and turn. Dynamic tool output is bounded with references, and prompts
use stable system/tool caching where the provider supports it.

Custom visual and JSON generated modes are explicit bounded artifacts, not arbitrary executable
configuration. The static PNG mascot is generated from the checked-in asset tooling. Dictation uses
a local Windows speech helper. Extensions are operator-registered local packages with verified roots,
isolated views, namespaced storage and explicit capabilities.

The private updater stores credentials in Electron safeStorage, checks private GitHub releases only
when requested by policy, requires explicit download, and requires a visible confirmation before an
installer runs; portable replacements are saved explicitly. Artifacts are currently unsigned local
Windows packages. Live updater, private-feed, microphone/accuracy, benchmark, and published-release
acceptance remain open.
