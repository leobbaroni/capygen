# Spike — MCP Apps widget host (SPEC R31, PLAN A13)

**Question.** A tool result can carry a UI: an HTML document that lives inside the MCP server,
behind a `ui://` URI. capygen has to render it, run the host side of the bridge, and let the
widget call tools back. The unknown that blocked the implementation was narrow and concrete:

> **Where does the widget's HTML come from, for a server that *the backend* hosts and capygen
> does not?**

Everything below is something that was run on this machine on 2026-09-06 (Windows 10 19045,
Node 22.16, Electron 44.2.0, `@modelcontextprotocol/ext-apps` 1.7.5,
`@anthropic-ai/claude-agent-sdk` 0.3.261, Claude Code signed in with claude.ai OAuth).

Reproduce: `SPIKE_STEPS=status,client,claude,higgs,higgscost corepack pnpm --dir packages/engine
exec tsx scripts/spike-mcp-apps.ts`. Raw stream → `docs/spikes/mcp-apps.raw.json` (gitignored);
trimmed evidence → `docs/spikes/mcp-apps.evidence.json` (committed, merged per step).

**Answer, in one line:** the backend never hands over the HTML — capygen opens **its own MCP
client to the same server** and reads the resource itself; for a server it cannot dial (a
claude.ai connector) there is no widget and the result renders as a rich card instead.

---

## a) The protocol, from the package

Read from `node_modules/@modelcontextprotocol/ext-apps@1.7.5/dist/src/`.

### a1 · How a tool declares a UI

`spec.types.d.ts` `McpUiToolMeta`: the tool's `_meta` carries `ui.resourceUri` (a `ui://…` URI)
and `ui.visibility` (`["model"]`, `["app"]`, default both). The deprecated flat form
`_meta["ui/resourceUri"]` is still accepted — the fixture server emits **both**, and the evidence
confirms a server SDK writes both:

```jsonc
// evidence.client.showCardMeta — tools/list, fixture server
{ "ui": { "resourceUri": "ui://capygen-fixture/card.html", "visibility": ["model", "app"] },
  "ui/resourceUri": "ui://capygen-fixture/card.html" }
```

The document itself is a `resources/read` on that URI, served as
`RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"` (`app.d.ts:78`). Its **own** `_meta.ui`
(`McpUiResourceMeta`) carries `csp`, `permissions`, `domain`, `prefersBorder`. The spec is
explicit that `csp`/`permissions` on the *tool* must be ignored (`McpUiToolMeta.csp?: never`) —
hosts read them off the `resources/read` content item.

```jsonc
// evidence.client — the read
{ "resourceUri": "ui://capygen-fixture/card.html",
  "resourceMimeType": "text/html;profile=mcp-app",
  "resourceMeta": { "ui": { "csp": {}, "prefersBorder": true } },
  "htmlBytes": 5789 }
```

Capability negotiation: a client advertises MCP Apps support under
`capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }`
(`server/index.d.ts:315`, `getUiCapability`). Servers *may* gate their App tools on it. capygen's
own client does not send it yet — see §Limitations.

### a2 · What the host must send

`AppBridge` (`app-bridge.d.ts`) + `PostMessageTransport` are the reference host implementation:
JSON-RPC over `postMessage`, protocol version `2026-01-26`.

| Direction | Message | Meaning |
|---|---|---|
| View → Host | `ui/initialize` | handshake; host answers with `hostInfo`, `hostCapabilities`, `hostContext` |
| View → Host | `ui/notifications/initialized` | view is ready to receive |
| Host → View | `ui/notifications/tool-input` | the tool's arguments |
| Host → View | `ui/notifications/tool-result` | the MCP `CallToolResult` |
| Host → View | `ui/notifications/host-context-changed` | theme + CSS variables changed |
| View → Host | `ui/notifications/size-changed` | content height/width |
| View → Host | `tools/call` | the widget calls a tool **through the host** |
| View → Host | `resources/read` | the widget reads a resource through the host |
| View → Host | `ui/open-link` | open a URL in the real browser |
| View → Host | `ui/download-file` | save a file (sandboxed frames cannot) |
| View → Host | `ui/request-display-mode` | inline / fullscreen / pip |

Theme passthrough is a fixed **set of CSS variable names** (`McpUiStyleVariableKey`: 80 of them,
`--color-text-primary`, `--font-sans`, `--border-radius-md`, …) whose *values* the host supplies.

### a3 · Sandboxing, as the spec asks for it

`McpUiResourceCsp` maps to `connect-src` (`connectDomains`), `img/script/style/font/media-src`
(`resourceDomains`), `frame-src` (`frameDomains`), `base-uri` (`baseUriDomains`); "empty or
omitted → no network" is the stated secure default. `McpUiResourcePermissions` maps to the iframe
`allow` attribute (`buildAllowAttribute`). The spec notes that MCP App HTML "runs in a sandboxed
iframe with no same-origin server" and that hosts serve it from a dedicated origin
(`{hash}.claudemcpcontent.com` for Claude, `*.oaiusercontent.com` for OpenAI).

### a4 · Measured: `srcdoc` cannot work, a custom scheme can

The obvious implementation — `<iframe sandbox="allow-scripts" srcdoc={html}>` — was tested inside
this app's own Electron before being written. Probe: a page carrying capygen's exact renderer CSP
(`default-src 'self'; …; script-src 'self'`) hosting two sandboxed frames with the same document,
one via `srcdoc`, one via a registered privileged scheme served with its own CSP header.

```
PROBE {"srcdoc":{},"scheme":{"ok":true,"origin":"capygen-widget://w",
                             "windowOrigin":"null","localStorage":"denied: SecurityError",
                             "href":"capygen-widget://w/probe","img":"loaded"}}
CSPERRORS [
 "Executing inline script violates the following Content Security Policy directive 'script-src 'self''…",
 "Loading the image 'https://www.google.com/…' violates the following Content Security Policy directive: \"img-src 'self' data:\"…",
 "Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''…"
]
```

* `srcdoc` posted **nothing**: an `about:srcdoc` document inherits the parent's policy container,
  so the renderer's `script-src 'self'` kills every widget's inline script and every remote asset
  it declared. The same applies to `data:` and `blob:` (all "local schemes" inherit).
* The custom-scheme frame ran, and its **response** CSP governed it (the remote image loaded).
* The frame is still opaque-origin under `sandbox` without `allow-same-origin`:
  `window.origin === "null"` and `localStorage` throws `SecurityError`.

A first run of the same probe failed with
`Framing 'capygen-widget://w/' violates … "default-src 'self'" … 'frame-src' was not explicitly set`,
which is why `apps/renderer/index.html` now adds `frame-src capygen-widget:` and nothing else.

**Consequence for the implementation:** widgets are served by the main process from
`capygen-widget://<block>/index.html` with a per-widget `Content-Security-Policy` built from the
resource's own `_meta.ui.csp`, deny-by-default.

---

## b) Claude backend — the fixture server through the SDK

Fixture: `tests/fixtures/mcp-apps-server/server.mjs`, written with ext-apps' server SDK
(`registerAppTool` / `registerAppResource`). Two tools sharing one `ui://` resource: `show_card`
(`visibility: ["model","app"]`) and `echo` (`visibility: ["app"]`, so only the widget may call it).

### b1 · `Query.mcpServerStatus()` — what a host learns about the CLI's servers

Free (no model turn). `evidence.mcpServerStatus`:

```jsonc
[ { "name": "capyfixture", "status": "connected", "scope": "dynamic",
    "config": { "type": "stdio", "command": "C:\\Program Files\\nodejs\\node.exe",
                "args": ["…/tests/fixtures/mcp-apps-server/server.mjs"] },
    "toolCount": 2, "toolKeys": ["name", "annotations"], "firstToolHasMeta": false },
  { "name": "claude.ai Higgsfield", "status": "pending", "scope": "claudeai",
    "config": { "type": "claudeai-proxy", "url": "https://mcp.higgsfield.ai/mcp", "id": "<31-char id>" },
    "toolCount": null, "toolKeys": null, "firstToolHasMeta": false },
  { "name": "claude.ai Gmail", "status": "connected", "scope": "claudeai",
    "config": { "type": "claudeai-proxy", "url": "https://gmailmcp.googleapis.com/mcp/v1", "id": "<31-char id>" },
    "toolCount": 29, "toolKeys": ["name", "annotations"], … } ]
```

Two findings, both load-bearing:

1. **The status listing does not carry tool `_meta`** — a tool entry is `{name, annotations}` only
   (`CAP sdk_mcp_server_status_tool_meta FAIL - tools[] keys = ["name","annotations"]`). So the
   `ui://` URI cannot be learned from here.
2. **It does carry the server's own `config`**, and for a locally hosted server that config is
   exactly what an MCP client needs to reconnect. That is the way in.

### b2 · What the stream exposes for an MCP tool call

One live Sonnet turn asking for `show_card`. `evidence.claudeFixture`:

```jsonc
{ "toolNameOnTheWire": "mcp__capyfixture__show_card",
  "toolUseMeta": null,
  "toolResultContent": "{\"title\":\"Hello from capygen\",\"note\":\"spike\"}",
  "toolResultMeta": null,
  "toolUseResult": { "content": "{\"title\":…}", "structuredContent": { "title": "Hello from capygen", "note": "spike" } },
  "resourceLinks": null, "error": null }
```

```
CAP claude_stream_exposes_mcp_tool_call PASS - mcp__capyfixture__show_card → …
CAP claude_stream_exposes_ui_meta      FAIL - no ui:// uri anywhere on the tool_use / tool_result frames
```

The raw frames add one thing the trace missed — the assistant message carries a top-level
`tool_use_meta` array with display names (useful for the card header, not for resolution):

```jsonc
"tool_use_meta": [ { "id": "toolu_01Q2…", "display_name": "Show Card",
                     "server_display_name": "capygen-fixture" } ]
```

**So: the `ui://` URI is not on the Claude stream, at all.** Neither on `tool_use._meta` nor on
`tool_result._meta`. `structuredContent` *is* there, and the tool_result `content` is the
serialised `structuredContent` rather than the tool's own text block.

### b3 · The resolution path that works: capygen's own MCP client

```
CAP own_mcp_client_resource_read PASS - ui://capygen-fixture/card.html → 5789 bytes of text/html;profile=mcp-app
CAP own_mcp_client_call_tool     PASS - [{"type":"text","text":"echo: ping"}]
```

A second, read-only `@modelcontextprotocol/sdk` client over the same stdio config gives
`tools/list` (with `_meta`, hence the URI), `resources/read` (the HTML *and* its `_meta.ui`), and
`tools/call` for the widget's own calls. **This is the implemented path for `claude` and `api`
agents.** It costs one extra child process per server, connected lazily and only when a widget
actually needs it (SPEC R26).

Where the config comes from in the app: `loadMcpServers()` reads `<project>/.mcp.json`,
`~/.claude/settings.json` and `~/.codex/config.toml` — the same files the CLIs read — so a server
the user registered once is visible to both sides with no capygen-specific configuration. The
widget e2e registers the fixture in the project's `.mcp.json` for exactly that reason.

---

## c) Claude backend + a claude.ai connector (Higgsfield)

The user has the Higgsfield connector installed in Claude Code. Two live turns, both free of
credits: `balance`, and `generate_image` with `get_cost: true` (returns the price, generates
nothing).

```jsonc
// evidence.higgsfield
{ "toolNameOnTheWire": "mcp__claude_ai_Higgsfield__balance",
  "toolUseMetaFrame": { "display_name": "Balance", "server_display_name": "Higgsfield",
                        "icon_url": "https://www.google.com/s2/favicons?domain=higgsfield.ai&sz=64" },
  "toolResultContent": "{\"credits\":196,\"subscription_plan_type\":\"free\"}",
  "toolUseResult": { "_meta": { "io.modelcontextprotocol/serverInfo":
                       { "name": "Higgsfield AI", "version": "1.0.0", "description": "…" } },
                     "structuredContent": { "credits": 196, "subscription_plan_type": "free" } } }

// evidence.higgsfieldGenerateImageCost
{ "toolNameOnTheWire": "mcp__claude_ai_Higgsfield__generate_image",
  "input": { "params": { "prompt": "a capybara wearing a pink hoodie", "get_cost": true, "model": "nano_banana_pro" } },
  "toolResultContent": "{\"cost\":{\"credits\":2,\"credits_exact\":2}}",
  "toolUseResult": { "_meta": { "io.modelcontextprotocol/serverInfo": { … } },
                     "structuredContent": { "cost": { "credits": 2, "credits_exact": 2 } } } }
```

```
CAP higgsfield_tool_call_visible          PASS    - mcp__claude_ai_Higgsfield__balance
CAP higgsfield_ui_meta                    PARTIAL - no ui:// uri on the connector's tool frames
CAP higgsfield_generating_tool_ui_meta    PARTIAL - no ui:// uri on generate_image's frames either
```

Three conclusions:

1. `tool_use_result._meta` **is** passed through by the SDK (Higgsfield's `serverInfo` arrives
   there). So the earlier "no `_meta`" finding is specifically about the *tool definition's*
   `_meta`, which is where MCP Apps puts `resourceUri`. If a server ever puts `ui.resourceUri` on
   a *result*, capygen will see it — the host checks the result `_meta` first, for free.
2. **Higgsfield declares no MCP App UI**, on `balance` or on `generate_image`. Its Animate / Edit /
   Download affordances in Claude Code desktop are therefore not MCP Apps widgets reaching us over
   this stream; they are something the desktop client does with the connector out of band.
3. Even if it did, capygen could not read the resource: the connector's config is
   `{type: "claudeai-proxy", url: "https://mcp.higgsfield.ai/mcp", id: <31 chars>}` — the upstream
   URL plus an Anthropic-side id, with no local credential. An `https` client to that URL would
   need the connector's own OAuth, which lives in claude.ai, not on this machine.

**Fallback (implemented).** For any server the host cannot dial, the widget block resolves
`unavailable` with the reason, and the card renders the result richly instead: inline images as
`data:` URIs, `resource_link`s and URLs found in the text or structured payload as buttons (that
route through `ui/open-link` in the main process, never as raw anchors), and the
`structuredContent` as a JSON block. Nothing about it is an error state — it is the normal
rendering for the whole `claudeai-proxy` class.

---

## d) Codex backend — the app-server already exposes everything

From the generated bindings in `docs/spikes/codex-app-server-schema/v0.153.4-ts/`:

| Binding | Content |
|---|---|
| `v2/ThreadItem.ts` | `{ "type": "mcpToolCall", id, server, tool, status, arguments, appContext: McpToolCallAppContext \| null, … }` |
| `v2/McpToolCallAppContext.ts` | `{ connectorId, linkId, resourceUri: string \| null, appName, actionName }` |
| `v2/McpToolCallResult.ts` | `{ content, structuredContent, _meta }` |
| `ClientRequest.ts` | `mcpServer/resource/read` → `McpResourceReadParams { threadId?, originCallId?, server, uri, connectorId? }` |
| `ClientRequest.ts` | `mcpServer/tool/call` → `McpServerToolCallParams { threadId, server, tool, arguments?, _meta? }` |
| `ResourceContent.ts` | `{ uri, mimeType?, text \| blob, _meta? }` |
| `v2/McpServerStatus.ts` | `{ name, …, tools: {[name]: Tool}, resources: Resource[], … }`, and `Tool`/`Resource` both carry `_meta` |

So Codex is the *easy* backend: `appContext.resourceUri` states the widget URI outright, the
result keeps its `_meta`, and `mcpServer/resource/read` + `mcpServer/tool/call` are the two calls
the host needs — no second MCP client, and connectors the app-server owns are reachable through
it. Not exercised live here (the Codex harness is task B1); `WidgetMcpAccess` is the seam that
implementation plugs into, and `createPoolWidgetAccess` is the Claude/api implementation of it.

---

## What was implemented, and where

| Piece | File |
|---|---|
| `_meta` readers, CSP/`allow` builders, `mcp__server__tool` parsing | `packages/engine/src/mcp/apps/protocol.ts` |
| `WidgetHostBridge` — resolution, per-widget state, `callTool` policy | `packages/engine/src/mcp/apps/WidgetHostBridge.ts` |
| `WidgetMcpAccess` over the generic client pool (Claude / api) | `packages/engine/src/mcp/apps/poolAccess.ts` |
| Privileged scheme, per-widget CSP, `widget.*` + `mcp.readResource` handlers | `apps/desktop/src/ipc/widgets.ts` |
| Scheme registration + `protocol.handle` + save dialog | `apps/desktop/src/main.ts` |
| "this MCP tool call has a widget" hook | `apps/desktop/src/engine/SessionRunner.ts` |
| `AppBridge` host over `postMessage`, wired to IPC | `apps/renderer/src/widgets/bridge.ts` |
| Sandboxed frame + size negotiation | `apps/renderer/src/widgets/WidgetFrame.tsx` |
| Theme → MCP Apps CSS variables | `apps/renderer/src/widgets/hostContext.ts` |
| Rich fallback card reading | `apps/renderer/src/widgets/fallback.ts` |
| The card | `apps/renderer/src/components/blocks/WidgetCard.tsx` |
| Fixture MCP Apps server + its hand-written View | `tests/fixtures/mcp-apps-server/` |
| Live proof | `tests/e2e/widget.spec.ts` |

Host messages implemented: `ui/initialize`, `ui/notifications/initialized`,
`ui/notifications/tool-input`, `ui/notifications/tool-result`,
`ui/notifications/host-context-changed`, `ui/notifications/size-changed`, `tools/call`,
`resources/read`, `ui/open-link`, `ui/download-file`, `ui/request-display-mode`,
`notifications/message`, `ping`.

Deliberately **not** advertised: `message` (`ui/message`), `updateModelContext` and `sampling`.
Letting third-party HTML write into the model's context or spend tokens is a decision for a later
phase, not a default (SPEC R27).

## Limitations, honestly

* **capygen's own client does not advertise the MCP Apps extension capability yet.**
  `McpClientPool` constructs its `Client` with `{capabilities: {}}` (that file belongs to the API
  harness task). A server that hides App tools behind `getUiCapability()` would therefore not show
  them to *our* listing — the resolution would come back "no ui:// resource" and the card would
  fall back. `MCP_APPS_CLIENT_CAPABILITY` in `protocol.ts` is the exact object to pass once the
  pool takes one.
* **`_meta.ui.permissions` is honoured in the main process but not forwarded to the frame**: the
  widget block carries no `allow` attribute, so camera/microphone/geolocation stay denied. A
  widget that needs one will need the state to reach the renderer first.
* **`tools/list` from inside a widget is not answered** — `AppBridge` has no `onlisttools` setter
  when constructed without an MCP client. Widgets that enumerate tools instead of calling a known
  one will get a method-not-found. Not hit by any server seen so far.
* **One widget's document is read once.** A `notifications/resources/updated` from the server does
  not re-read it.
* Codex's path (§d) is designed for but not yet wired — `WidgetMcpAccess` is where it lands.
