/**
 * The renderer half of the MCP Apps host: one {@link AppBridge} per widget
 * iframe (SPEC R31).
 *
 * `AppBridge` and `PostMessageTransport` come from
 * `@modelcontextprotocol/ext-apps` itself rather than a hand-rolled
 * `postMessage` protocol — the handshake, version negotiation, capability
 * assertions and JSON-RPC framing are exactly the parts that must match the
 * spec byte for byte, and the package *is* the spec's reference implementation.
 * It is constructed with a `null` MCP client, because the client lives in the
 * main process: every request a widget makes is forwarded over typed IPC
 * instead (`widget.callTool`, `mcp.readResource`, `widget.event`), which is
 * also the only place the "same server only" rule can be enforced.
 *
 * Trust boundary: the iframe is sandboxed without `allow-same-origin`, so its
 * document has an opaque origin and `event.origin` is the useless `"null"`.
 * The transport therefore identifies its peer by `event.source ===
 * iframe.contentWindow`, which is what `PostMessageTransport` does and why the
 * iframe element is passed to it rather than a window reference we kept.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { buildHostContext, currentTheme, type WidgetHostContext } from "./hostContext";

/** Everything the host needs to answer for one widget. */
export interface WidgetBridgeOptions {
  iframe: HTMLIFrameElement;
  blockId: string;
  sessionId: string;
  agentId: string;
  toolInput: unknown;
  toolResult: { content?: unknown[]; structuredContent?: unknown; isError?: boolean } | null;
  /** Typed IPC calls, injected so the bridge is testable without Electron. */
  callTool(name: string, args: unknown): Promise<unknown>;
  readResource(uri: string): Promise<{ mimeType?: string; text?: string; blob?: string }>;
  event(type: string, payload: unknown): Promise<{ ok: boolean }>;
  /** Called when the widget reports its content height. */
  onResize?(size: { width?: number; height?: number }): void;
  hostContext?: WidgetHostContext;
  log?: (message: string, detail?: unknown) => void;
}

export interface WidgetBridgeHandle {
  bridge: AppBridge;
  /** Push a new theme/style set after the app's theme changed. */
  syncTheme(): void;
  close(): void;
}

const HOST_INFO = { name: "capygen", version: "0.1.0" };

/**
 * What capygen promises a widget it can do. `serverTools` and `serverResources`
 * are declared because both are proxied to the widget's own MCP server;
 * `message`, `updateModelContext` and `sampling` are **not**, because letting a
 * third-party document write into the model's context or spend tokens is a
 * decision for a later phase, not a default (SPEC R27).
 */
const HOST_CAPABILITIES = {
  openLinks: {},
  downloadFile: {},
  serverTools: {},
  serverResources: {},
  logging: {},
} as const;

function asCallToolResult(value: unknown): {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      content: Array.isArray(record.content) ? record.content : [],
      ...(record.structuredContent !== undefined
        ? { structuredContent: record.structuredContent }
        : {}),
      ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
    };
  }
  // A server that answered with something un-MCP-shaped still has to reach the
  // widget as a result rather than as a dropped promise.
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
}

export function attachWidgetHost(options: WidgetBridgeOptions): WidgetBridgeHandle {
  const { iframe } = options;
  const log = options.log ?? ((): void => {});
  const hostContext = options.hostContext ?? buildHostContext({ maxWidth: iframe.clientWidth });

  const bridge = new AppBridge(null, HOST_INFO, HOST_CAPABILITIES, { hostContext });

  bridge.oncalltool = async (params) => {
    const result = await options.callTool(params.name, params.arguments ?? {});
    return asCallToolResult(result) as never;
  };

  bridge.onreadresource = async (params) => {
    const item = await options.readResource(params.uri);
    return {
      contents: [
        {
          uri: params.uri,
          ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
          ...(item.text !== undefined ? { text: item.text } : {}),
          ...(item.blob !== undefined ? { blob: item.blob } : {}),
        },
      ],
    } as never;
  };

  bridge.onopenlink = async (params) => {
    const { ok } = await options.event("ui/open-link", { url: params.url });
    return { isError: !ok };
  };

  bridge.ondownloadfile = async (params) => {
    // MCP allows several contents; the host saves the first, which is what a
    // "Download" button in a widget means in practice.
    const first = (params.contents ?? [])[0] as Record<string, unknown> | undefined;
    const resource =
      first && typeof first === "object" && "resource" in first
        ? (first.resource as Record<string, unknown>)
        : first;
    const { ok } = await options.event("ui/download-file", {
      fileName: fileNameFor(resource),
      ...(typeof resource?.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
      ...(typeof resource?.text === "string" ? { text: resource.text } : {}),
      ...(typeof resource?.blob === "string" ? { base64: resource.blob } : {}),
      ...(typeof resource?.uri === "string" ? { uri: resource.uri } : {}),
    });
    return { isError: !ok };
  };

  bridge.onrequestdisplaymode = async () => ({ mode: "inline" as const });

  bridge.onloggingmessage = (params) => log(`[widget ${options.blockId}] log`, params);

  bridge.onsizechange = (size) => {
    options.onResize?.(size);
    void options.event("ui/notifications/size-changed", size).catch(() => {});
  };

  /**
   * The tool call is delivered *after* the view says it is initialised: a view
   * that has not run its own `connect()` yet has no handler for these and the
   * notifications would be dropped.
   */
  bridge.oninitialized = () => {
    void bridge
      .sendToolInput({ arguments: asArguments(options.toolInput) })
      .catch((err: unknown) => log("sendToolInput failed", err));
    if (options.toolResult) {
      void bridge
        .sendToolResult({
          content: (options.toolResult.content ?? []) as never,
          ...(options.toolResult.structuredContent !== undefined
            ? { structuredContent: options.toolResult.structuredContent as never }
            : {}),
          ...(options.toolResult.isError !== undefined
            ? { isError: options.toolResult.isError }
            : {}),
        })
        .catch((err: unknown) => log("sendToolResult failed", err));
    }
  };

  const transport = new PostMessageTransport(
    iframe.contentWindow ?? undefined,
    iframe.contentWindow as MessageEventSource,
  );
  void bridge.connect(transport).catch((err: unknown) => log("bridge connect failed", err));

  return {
    bridge,
    syncTheme: () => {
      const next = buildHostContext({ maxWidth: iframe.clientWidth });
      void Promise.resolve(
        bridge.sendHostContextChange({ theme: currentTheme(), styles: next.styles }),
      ).catch(() => {});
    },
    close: () => {
      void bridge.close().catch(() => {});
    },
  };
}

function asArguments(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function fileNameFor(resource: Record<string, unknown> | undefined): string {
  const uri = typeof resource?.uri === "string" ? resource.uri : "";
  const tail = uri.split(/[/\\]/).pop() ?? "";
  return tail.length > 0 ? tail : "widget-file";
}
