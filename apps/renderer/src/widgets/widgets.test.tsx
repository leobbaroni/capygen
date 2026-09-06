/**
 * The renderer half of the MCP Apps host (SPEC R31).
 *
 * The bridge itself is proved end to end in `tests/e2e/widget.spec.ts` — it
 * needs a real cross-origin iframe, which jsdom does not have. What is tested
 * here is everything a wrong answer in would break silently: the URL both
 * processes must agree on, the fallback reading of a tool result, and the
 * card's three states.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WidgetBlock } from "@capygen/shared";
import { WidgetCard } from "@/components/blocks/WidgetCard";
import { buildFallback, extractUrls, isWebLink } from "./fallback";
import { clampWidgetHeight, DEFAULT_WIDGET_HEIGHT, MAX_WIDGET_HEIGHT } from "./WidgetFrame";
import { WIDGET_SCHEME, widgetHost, widgetUrl } from "./url";

const invoke = vi.fn();
// `hasBridge` too: importing the card pulls in the app store, which reads it at
// module scope, and a partial mock would leave that call undefined.
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

function widget(overrides: Partial<WidgetBlock> = {}): WidgetBlock {
  return {
    id: "blk_abc123",
    sessionId: "ses_1",
    turnId: "trn_1",
    index: 0,
    createdAt: 1,
    updatedAt: 1,
    kind: "widget",
    toolCallId: "toolu_1",
    serverName: "capyfixture",
    toolName: "show_card",
    resourceUri: "ui://capygen-fixture/card.html",
    html: null,
    htmlStatus: "pending",
    toolInput: { title: "Hello" },
    toolResult: null,
    meta: null,
    ...overrides,
  } as WidgetBlock;
}

beforeEach(() => invoke.mockReset());

describe("the widget URL", () => {
  it("matches what the main process serves", () => {
    // apps/desktop/src/ipc/widgets.ts builds the same string; its own test
    // pins this exact form from the other side.
    expect(WIDGET_SCHEME).toBe("capygen-widget");
    expect(widgetHost("blk_abc123")).toBe("blkabc123");
    expect(widgetUrl("blk_abc123")).toBe("capygen-widget://blkabc123/index.html");
  });
  it("refuses an id that could not be a host label", () => {
    expect(widgetUrl("")).toBeNull();
    expect(widgetUrl("x".repeat(200))).toBeNull();
  });
});

describe("clampWidgetHeight", () => {
  it("keeps a widget between the readable bounds", () => {
    expect(clampWidgetHeight(undefined)).toBe(DEFAULT_WIDGET_HEIGHT);
    expect(clampWidgetHeight(10)).toBe(80);
    expect(clampWidgetHeight(10_000)).toBe(MAX_WIDGET_HEIGHT);
    expect(clampWidgetHeight(301.2)).toBe(302);
  });
});

describe("the fallback reading of a tool result", () => {
  it("pulls out text, inline images, resource links and structured JSON", () => {
    const fallback = buildFallback({
      content: [
        { type: "text", text: "Generated at https://cdn.example/a.png" },
        { type: "image", data: "AAA=", mimeType: "image/png" },
        { type: "resource_link", uri: "https://higgsfield.ai/job/1", name: "Open job" },
      ],
      structuredContent: { credits: 196 },
    });
    expect(fallback.text).toEqual(["Generated at https://cdn.example/a.png"]);
    expect(fallback.images).toEqual([{ src: "data:image/png;base64,AAA=", alt: "Tool result image" }]);
    expect(fallback.links.map((l) => l.href)).toEqual([
      "https://cdn.example/a.png",
      "https://higgsfield.ai/job/1",
    ]);
    expect(fallback.json).toBe('{\n  "credits": 196\n}');
  });

  it("never offers a non-web link", () => {
    expect(isWebLink("file:///C:/secrets.txt")).toBe(false);
    expect(extractUrls("see https://a.example/x, and file:///y")).toEqual(["https://a.example/x"]);
  });

  it("survives a result with nothing in it", () => {
    expect(buildFallback(null)).toEqual({ text: [], images: [], links: [], json: null });
  });
});

describe("WidgetCard", () => {
  it("shows the server and tool it belongs to, and the arguments on demand", async () => {
    render(<WidgetCard block={widget()} />);
    expect(screen.getByTestId("block-widget")).toHaveAttribute("data-server", "capyfixture");
    expect(screen.getByText("show_card")).toBeInTheDocument();
    expect(screen.queryByTestId("widget-input")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("widget-header"));
    expect(screen.getByTestId("widget-input")).toHaveTextContent('"title": "Hello"');
  });

  it("says the widget is loading until the document arrives", () => {
    render(<WidgetCard block={widget()} />);
    expect(screen.getByTestId("widget-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("widget-frame")).not.toBeInTheDocument();
  });

  it("frames a ready widget with no same-origin privileges", () => {
    render(<WidgetCard block={widget({ htmlStatus: "ready", html: "<p>hi" })} />);
    const frame = screen.getByTestId("widget-frame");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("falls back to the rich result card when there is no widget", async () => {
    render(
      <WidgetCard
        block={widget({
          htmlStatus: "unavailable",
          toolResult: {
            content: [{ type: "text", text: "Balance: see https://higgsfield.ai/billing" }],
            structuredContent: { credits: 196 },
          },
        })}
      />,
    );
    expect(screen.getByTestId("widget-fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("widget-frame")).not.toBeInTheDocument();

    // A link is a button, not an anchor: the main process decides whether a URL
    // may be handed to the OS browser.
    const link = screen.getByRole("button", { name: /higgsfield\.ai\/billing/ });
    await userEvent.click(link);
    expect(invoke).toHaveBeenCalledWith("widget.event", {
      blockId: "blk_abc123",
      type: "ui/open-link",
      payload: { url: "https://higgsfield.ai/billing" },
    });
  });
});
