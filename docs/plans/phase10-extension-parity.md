# Phase 10 extension parity inventory

Astra design, implemented and reviewed by 2026-09-09 using the available-model fallback
recorded in PLAN.md. This resolves the inventory called out at the end of ADR-0008.
The implemented package includes the capability services below; a static sample alone
would not establish P20. The local adaptation does not promise Python plugin compatibility.
Reference is read-only: `reference/omnigent/docs/extending/browser_extensions.md` and
`extension_manifest.md`. No reference module may be imported into capygen.

## Contract and local adaptation

Keep ADR-0008's separate protocol, sandbox partition, strict response CSP, denied ambient
network/permissions and realpath checks. A capability bridge is separate from capygen preload
and from MCP Apps: it has no tool-execution, raw IPC, authenticated fetch or session-stream
access. Transfer a nonce-bound MessagePort only to the verified extension view. Bind requests
to extension ID, view instance, protocol version and granted capabilities in main. Bound
requests/responses, deadlines and concurrency; cancellation/disposal invalidates the port and
late replies. Reopening the same extension creates a new authority instance.

The reference discovers Python distribution entry points. Capygen uses operator-registered
local extension packages instead, with a versioned JSON manifest and bundled JS/CSS under a
verified root. The UI must describe that local package format, not claim Python plugin
compatibility. Registration displays the exact root, identity and requested capabilities.
No download, install, upgrade or sign-in runs silently. Installed-package identity/version
checks and local-development overrides must be explicit parts of the chosen package format.

Namespaced extension and contribution IDs are immutable. Reserve built-in names; reject all
participants in a collision deterministically. Reject an entire invalid extension while
allowing independent valid extensions to load. Routes are single safe segments inside the
extension namespace. Missing, escaping or oversized assets suppress its pages/navigation.
Hash bundles for revision/cache identity; a hash alone is not a trust or signature claim.
Limit registration to 64 extensions and aggregate extension storage to 8 MiB per app
profile. Per-value, per-namespace, key-count and aggregate limits all apply simultaneously;
reaching any one refuses the write atomically. These are ceilings, not promised capacity.

## Required capability mapping

| Reference capability | Capygen implementation requirement | Evidence needed |
| --- | --- | --- |
| Namespaced pages and primary navigation | Manifest contributions populate the existing shell; mount only verified bundles and unload them completely | Two extensions, collision refusal, reload/dispose and missing-asset fixtures |
| `theme.getCurrent`, `theme.subscribe` | Read current theme tokens and publish bounded theme changes; unsubscribe on disposal | Theme switch reaches sample, old port receives nothing |
| `navigation.openPage` | Only registered, available namespaced pages; bounded route parameters | Unknown/escaping page refused; valid sample navigation |
| `navigation.openSession`, `openNewSession` | Existing shell navigation, optionally an existing project; never dispatch a model prompt | Valid and missing session/project tests; zero model requests |
| `navigation.openExternal` | Only a URL previously returned by a permitted host service to this same extension instance | Arbitrary URL, stale instance and cross-extension URL refused |
| `storage.user.get/set/delete` | Main-owned storage scoped by app profile and extension namespace, 32 KiB/value, 256 KiB total, 128 keys; paced writes and explicit quota errors | Restart persistence, namespace isolation, atomic quota failure; uninstall does not silently erase data |
| `sessions.getCached` | Optional bounded cached summaries or explicit unavailable/null; never imply canonical completeness | Stale cache does not become pagination authority |
| `sessions.listPage` | Canonical non-archived top-level session summaries, default 25/max 1000; shorten to response budget; stable cursor | Same-time rows, deletions, oversized labels, cross-page deduplication |
| SDK `sessions.listAll` | Bounded helper, at most 200 pages/5000 sessions; merge canonical rows by ID and discard preview-only rows at completion | Truncation disclosed and finite iteration under changing pages |
| `sessions.pullRequest` | Bounded main-process GitHub adapter reads the PR for the trusted session branch; no arbitrary commands or repository mutation | `pullRequest.ts`, `integration.ts`, fixed-command/branch/output fixtures in `extensions.test.ts` |
| `projects.list` | Only ID, name and icon for current app-profile projects | No path/config/credential fields beyond the capability contract |
| `projects.create` | Use the same native directory selection and project-creation path as the sidebar; trimmed name <=100 chars | Cancellation creates nothing; success refreshes shell; no arbitrary extension-chosen filesystem write |

Session summaries include ID, title, status, unread state, provisional-title state, working
directory, worktree branch, project ID and timestamps. `sessions.read` consent must explicitly
say it exposes titles and local working-directory paths. It does not expose messages, tool
inputs/results, credentials or backend configuration. Derive unread/provisional flags from
canonical app state; do not invent a value when the app lacks the corresponding state.
The PR lookup is implemented. `titleProvisional` and other unavailable cached state are
reported as nullable fields rather than invented facts. `sessions.getCached` may return null;
canonical paginated rows remain the source of truth, as specified above.

## Recorded implementation evidence

`apps/desktop/src/extensions/service.ts` implements grants, instance/nonce validation,
bounded theme/navigation/storage/session/project operations and lifecycle cleanup.
`integration.ts` binds canonical database paging, native project creation and PR lookup;
`packages/shared/src/extensions.ts` supplies the bounded `listAllExtensionSessions` helper.
`extensions.test.ts` covers collisions, junction/missing assets, per-namespace and aggregate
quotas, stale authority, issued URLs, deadlines and fixed read-only PR commands.
`extensionHost.test.ts` checks partition, permission, CSP, fresh-port and disposal wiring.
Native `extensions.spec.ts` exercises the real isolated view and port, appearance,
storage/restart, project navigation, blocked ambient fetch/image/popup access, exact
geolocation permission denial, encoded traversal refusal with a valid image control,
and rejected invalid-nonce/unknown-method requests through the real port.
The packaged smoke verifies the shipped helper and sample assets. Phase 12's release/CI
and live-updater acceptance remain separate from these local extension checks.

## Acceptance sequence

1. Strict manifest and message contracts, namespace registration, sandboxed static sample.
2. Theme, namespaced storage and navigation using explicit capability grants.
3. Session/project services and matching SDK helpers, with the table above completed.
4. Native Electron sample exercises the granted methods. Hostile sample attempts ambient
   network, image fetch, file traversal/junction replacement, popups, permissions, forged
   ports, unknown capabilities and stale-instance calls; each is refused without weakening
   the ordinary browser pane or MCP Apps host.
5. Opus review of Astra design, different-model implementation review, Phase 10 full gate,
   and Phase 12 packaged extension/sample verification. Keep P20 open until the full inventory
   is accounted for; the sample-page Done-when alone must not hide missing capabilities.
