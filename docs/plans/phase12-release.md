# Phase 12 release implementation brief

Astra proposal, 2026-09-08; independent Opus review and implementation remain pending.
Nothing in this document is packaging or updater acceptance evidence.

## Build and artifact contract

Keep `leobbaroni/capygen` private. Pin that owner and repository explicitly in release
configuration. Build Windows x64 NSIS and portable artifacts plus `latest.yml` from the
same versioned source commit. `build:win` builds locally without publishing; a separate
tag workflow verifies the version and publishes only after its checks succeed.

Use a pinned electron-builder/electron-updater pair after inspecting the chosen versions'
actual APIs and runtime dependencies. Neither dependency nor the release workflow exists
in this checkout yet. Dependency additions belong to the implementation task and lockfile;
record them visibly. Do not install global utilities or change the user's CLI installations.

Package an explicit allowlist: desktop bundles, renderer output, migrations, static PNG
assets, notices/font license, and required production dependencies. Claude's external SDK
and its executable must retain their expected relative layout. The node-pty addon and
helpers need real executable paths outside ASAR. Import/share utility workers must resolve
in the installed app. Include the Phase 10 speech helper and its recorded hash if accepted.
Exclude test homes, recordings, probes, source reference, credentials and development output.

## Private updates and deliberate installation

Electron-updater documents private GitHub access and NSIS updates. Its default installation
behavior requires explicit override for our app's confirmation rule. Portable builds must
offer a verified replacement download rather than pretend to support NSIS installation.
[Official updater documentation](https://www.electron.build/docs/features/auto-update/).

Each private-repository reader needs its own authorized credential. Never package a CI or
developer token. The documented runtime token option must not be written to configuration.
[Official GitHub provider options](https://www.electron.build/docs/api/builder-util-runtime.interface.githuboptions/).

Implementation proposal: add a dedicated main-only updater credential namespace to the
existing safeStorage store, with metadata-only status and removal. Credential entry should
follow the existing secret-entry path; plaintext is never returned to the renderer, logged,
or supplied to model children. Inject the token into the updater instance only. Do not set
process-wide GH_TOKEN or repurpose an MCP secret. Verify the selected provider's redirect
handling and redact errors before exposing them. Missing/expired authorization is a visible
state, not 'no updates'. Authentication and actual private-feed access remain proof items.

Disable automatic download and installation on quit/startup. Checking, downloading and
installing have distinct visible states. Installation must use the existing exact-command
confirmation and visible-console discipline, with a verified downloaded executable path and
fixed arguments. Cancel or close launches nothing. Do not call an updater convenience API
that installs silently behind that gate. Revalidate artifact identity before launch, prevent
concurrent installs, and refuse installation while active work cannot shut down cleanly.

Inspect the pinned NSIS provider's publisher-name and signature-verification behavior for
the accepted unsigned build scope. Record the effective settings and test the actual
unsigned artifact; never mistake a checksum match for authenticated publisher identity.
Retain HTTPS/private-feed authorization and artifact checksum verification.

Bound the app-owned download cache by both artifact count and bytes, with explicit limits
chosen from measured build sizes before implementation acceptance. Delete partial files
after cancellation or failure. Retain a verified pending installer until installation,
explicit clear, or safe pruning when a newer artifact replaces it. Never prune a portable
file the user saved outside the app-owned cache. Cover retention and cleanup with fixtures.

## Verification and release

- Native installed-app smoke in an owned profile: first launch, migrations, persisted
  restart, static assets, safeStorage, PTY, both utility workers, and packaged Claude/Codex
  discovery with isolated homes. Missing external prerequisites use the normal run gate.
- Build an older and newer version, then prove older NSIS finds and downloads the newer
  private release. Exercise checksum failure, missing credentials, offline state and cancelled
  installation. Loopback fixtures cover failures but do not replace the real private-feed check.
- Verify artifact contents and hashes, notices, renderer sandbox/CSP, and no embedded test
  secrets. Unsigned Windows builds are the accepted scope; never imply publisher verification.
- CI runs the full gate on Windows, builds artifacts, and publishes on a matching version tag
  with job-scoped release permissions. Never expose publishing credentials to app bundles.
- Complete README, ARCHITECTURE, COMPAT and RUN from the packaged behavior. Audit every SPEC
  requirement and parity item against evidence, preserving explicit gaps and skipped checks.
- Run two clean independent adversarial review rounds after fixes. Record output tails and
  artifact identities in PROJECT_LOG before marking Phase 12 complete.

The credential flow and install-command integration need review against the pinned updater
implementation before coding. Repository privacy and explicit installation are settled user
requirements, not tradeoffs available to simplify release work.
