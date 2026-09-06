/**
 * The MCP Apps widget card (SPEC R31).
 *
 * Layout follows Claude Code desktop's: a quiet header line — the server that
 * owns the widget, the tool that produced it, and a chevron that reveals the
 * arguments the model sent — over the widget itself. The widget gets the full
 * card width and its own negotiated height, because it *is* the content;
 * everything capygen draws around it stays out of its way.
 *
 * Three states:
 *   pending      the tool result is in but the `ui://` document has not been
 *                read yet (the read is one MCP round trip in the main process).
 *   ready        the sandboxed frame, live, bridged to its server.
 *   unavailable  the rich result card — images, links, structured payload —
 *                plus why there is no widget. This is what every claude.ai
 *                connector renders as, by necessity (spike §c), so it is a
 *                first-class rendering and not an error banner.
 */
import { ChevronRightIcon, ExternalLinkIcon, Loader2Icon, PuzzleIcon } from "lucide-react";
import { useMemo } from "react";
import type { WidgetBlock } from "@capygen/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";
import { WidgetFrame } from "@/widgets/WidgetFrame";
import { buildFallback, safeJson } from "@/widgets/fallback";

export function WidgetCard({ block }: { block: WidgetBlock }) {
  const agentId = useAppStore(
    (s) => s.turns.find((turn) => turn.id === block.turnId)?.agentId ?? s.agents[0]?.id ?? "",
  );
  const inputJson = useMemo(() => safeJson(block.toolInput), [block.toolInput]);
  const fallback = useMemo(() => buildFallback(block.toolResult), [block.toolResult]);

  return (
    <section
      data-testid="block-widget"
      data-state={block.htmlStatus}
      data-server={block.serverName}
      data-tool={block.toolName}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-2"
    >
      {/* `group` is what `group-data-[state=open]:rotate-90` on the chevron
          below needs; without it the arrow never turned. */}
      <Collapsible className="group">
        <CollapsibleTrigger
          data-testid="widget-header"
          className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <PuzzleIcon className="size-3.5 shrink-0" />
          <span>
            Widget from <span className="text-foreground">{block.serverName}</span>
          </span>
          <span className="font-mono text-[11px]">{block.toolName}</span>
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <pre
            data-testid="widget-input"
            className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground"
          >
            {inputJson ?? "(no arguments)"}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      {block.htmlStatus === "pending" ? (
        <p
          data-testid="widget-pending"
          className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground"
        >
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading this tool&rsquo;s widget…
        </p>
      ) : null}

      {block.htmlStatus === "ready" ? (
        <WidgetFrame
          blockId={block.id}
          sessionId={block.sessionId}
          agentId={agentId}
          title={`${block.serverName} ${block.toolName}`}
          toolInput={block.toolInput}
          toolResult={block.toolResult}
          {...(block.size?.height !== undefined ? { initialHeight: block.size.height } : {})}
          callTool={(name, args) =>
            ipc().invoke("widget.callTool", {
              sessionId: block.sessionId,
              agentId,
              blockId: block.id,
              name,
              args,
            })
          }
          readResource={(uri) =>
            ipc().invoke("mcp.readResource", {
              sessionId: block.sessionId,
              agentId,
              serverName: block.serverName,
              uri,
            })
          }
          event={(type, payload) => ipc().invoke("widget.event", { blockId: block.id, type, payload })}
        />
      ) : null}

      {block.htmlStatus === "unavailable" ? (
        <div data-testid="widget-fallback" className="flex flex-col gap-2">
          {fallback.images.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {fallback.images.map((image, index) => (
                <img
                  key={`${image.src.slice(0, 32)}-${index}`}
                  src={image.src}
                  alt={image.alt}
                  className="max-h-64 rounded-md border border-border"
                />
              ))}
            </div>
          ) : null}
          {fallback.text.map((text, index) => (
            <p key={index} className="whitespace-pre-wrap text-sm text-foreground">
              {text}
            </p>
          ))}
          {fallback.links.length > 0 ? (
            <ul className="flex flex-col gap-1" data-testid="widget-links">
              {fallback.links.map((link) => (
                <li key={link.href}>
                  {/* Never a real anchor: a click has to reach the main process,
                      which decides whether the URL may be handed to the OS. */}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                    onClick={() =>
                      void ipc().invoke("widget.event", {
                        blockId: block.id,
                        type: "ui/open-link",
                        payload: { url: link.href },
                      })
                    }
                  >
                    <ExternalLinkIcon className="size-3" />
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {fallback.json ? (
            <pre className="max-h-64 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
              {fallback.json}
            </pre>
          ) : null}
          <p className="text-[11px] text-muted-foreground" data-testid="widget-unavailable-reason">
            No interactive widget for this result.
          </p>
        </div>
      ) : null}
    </section>
  );
}
