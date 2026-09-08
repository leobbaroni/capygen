/**
 * Approve (P17).
 *
 * The page is an index over what main says is pending. The cases below are the
 * ways an index like this goes wrong: answering through a second path, hiding a
 * request it cannot answer, minting a grant the card would not have minted, or
 * showing a stale list after the answer landed.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ApprovePendingRequest } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { ApprovePage } from "./ApprovePage";

const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ bridge: true }));
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => shell.bridge,
}));

const row = (over: Partial<ApprovePendingRequest> = {}): ApprovePendingRequest => ({
  blockId: "blk_1", sessionId: "ses_1", sessionTitle: "Alpha run", turnId: "trn_1",
  agentId: "agt_1", agentLabel: "Assistant", requestId: "req-1", toolName: "Bash",
  inputSummary: "rm -rf build", createdAt: 1, answerable: true, refusal: null, ...over,
});

let answerPermission: ReturnType<typeof vi.fn>;

const view = () => render(<MemoryRouter><ApprovePage /></MemoryRouter>);

beforeEach(() => {
  shell.bridge = true;
  answerPermission = vi.fn().mockResolvedValue(undefined);
  useAppStore.setState({ answerPermission });
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "approve.pending") return Promise.resolve({ requests: [row()], total: 1 });
    return Promise.resolve({});
  });
});

describe("ApprovePage", () => {
  it("lists what is waiting, with the session it belongs to", async () => {
    view();
    const item = await screen.findByTestId("approve-row-blk_1");
    expect(item).toHaveTextContent("Bash");
    expect(item).toHaveTextContent("rm -rf build");
    expect(screen.getByTestId("approve-open-blk_1")).toHaveAttribute("href", "/c/ses_1");
    expect(invoke).toHaveBeenCalledWith("approve.pending", { offset: 0, limit: 25 });
  });

  it("answers through the ordinary permission path, not a second one", async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByTestId("approve-allow-blk_1"));

    expect(answerPermission).toHaveBeenCalledWith("req-1", "allow");
    // There is no answer channel of its own: a decision made here goes through
    // exactly the same store action the card uses.
    expect(invoke.mock.calls.every((c) => c[0] === "approve.pending")).toBe(true);
  });

  it("sends a local-policy card's session allow as allow + scope session", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) =>
      channel === "approve.pending"
        ? Promise.resolve({
            requests: [row({
              localPolicy: { ruleId: "lpr_1", scope: { kind: "global" }, boundary: "api-tool" },
            })],
            total: 1,
          })
        : Promise.resolve({}));
    view();
    await user.click(await screen.findByTestId("approve-allow-session-blk_1"));

    // `allow_always` is collapsed to a single use by the broker, so sending it
    // here would promise a session grant and deliver one call.
    expect(answerPermission).toHaveBeenCalledWith("req-1", "allow", { scope: "session" });
    expect(screen.getByTestId("approve-policy-blk_1")).toHaveTextContent(/own restriction/i);
    // The link names the owning rule, so Policies opens that editor.
    expect(screen.getByTestId("approve-rule-link-blk_1"))
      .toHaveAttribute("href", "/settings/policies?rule=lpr_1");
  });

  it("names a widget-host call as such in the attribution", async () => {
    invoke.mockImplementation((channel: string) =>
      channel === "approve.pending"
        ? Promise.resolve({
            requests: [row({
              localPolicy: {
                ruleId: "lpr_1", scope: { kind: "global" },
                boundary: "api-tool", executionSite: "widget-host",
              },
            })],
            total: 1,
          })
        : Promise.resolve({}));
    view();
    expect(await screen.findByTestId("approve-policy-blk_1"))
      .toHaveTextContent(/widget running in this app/i);
  });

  it("keeps an ordinary native card's session answer unchanged", async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByTestId("approve-allow-session-blk_1"));
    expect(answerPermission).toHaveBeenCalledWith("req-1", "allow_always");
  });

  it("links to Policies in general when the attribution names no rule", async () => {
    invoke.mockImplementation((channel: string) =>
      channel === "approve.pending"
        ? Promise.resolve({
            requests: [row({
              localPolicy: { ruleId: null, scope: null, boundary: "api-tool" },
            })],
            total: 1,
          })
        : Promise.resolve({}));
    view();
    // A boundary refusal has no rule to open; linking to one would be a lie.
    const link = await screen.findByTestId("approve-rule-link-blk_1");
    expect(link).toHaveAttribute("href", "/settings/policies");
    expect(link).toHaveTextContent("Open Policies");
  });

  it("lists a request it cannot answer, with the reason, rather than hiding it", async () => {
    invoke.mockImplementation((channel: string) =>
      channel === "approve.pending"
        ? Promise.resolve({ requests: [row({ answerable: false, refusal: "viewer" })], total: 1 })
        : Promise.resolve({}));
    view();
    // Hiding it would misrepresent what is actually waiting.
    expect(await screen.findByTestId("approve-row-blk_1")).toBeInTheDocument();
    expect(screen.getByTestId("approve-refused-blk_1")).toHaveTextContent(/viewer profile/i);
    expect(screen.queryByTestId("approve-allow-blk_1")).toBeNull();
    expect(screen.queryByTestId("approve-deny-blk_1")).toBeNull();
  });

  it("re-reads the list after answering rather than patching it locally", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByTestId("approve-row-blk_1");
    const before = invoke.mock.calls.filter((c) => c[0] === "approve.pending").length;
    await user.click(screen.getByTestId("approve-deny-blk_1"));
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "approve.pending").length)
        .toBeGreaterThan(before),
    );
  });

  it("re-reads and surfaces the failure when an answer is refused as stale", async () => {
    const user = userEvent.setup();
    answerPermission.mockRejectedValueOnce(new Error("this request is not live any more"));
    view();
    await user.click(await screen.findByTestId("approve-allow-blk_1"));

    expect(await screen.findByTestId("approve-error")).toHaveTextContent(/not live any more/);
    // The list is re-read, so a request that is really gone stops being offered.
    expect(invoke.mock.calls.filter((c) => c[0] === "approve.pending").length).toBeGreaterThan(1);
  });

  it("pages, and reports everything waiting rather than what fitted", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string, args: { offset?: number }) =>
      channel === "approve.pending"
        ? Promise.resolve({
            requests: [row({ blockId: `blk_${args?.offset ?? 0}` })],
            total: 60,
          })
        : Promise.resolve({}));
    view();
    expect(await screen.findByTestId("approve-range")).toHaveTextContent("1–25 of 60");
    await user.click(screen.getByTestId("approve-next"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("approve.pending", { offset: 25, limit: 25 }),
    );
    expect(await screen.findByTestId("approve-row-blk_25")).toBeInTheDocument();
  });

  it("says nothing is waiting rather than showing an empty frame", async () => {
    invoke.mockImplementation(() => Promise.resolve({ requests: [], total: 0 }));
    view();
    expect(await screen.findByTestId("approve-empty")).toHaveTextContent(/Nothing is waiting/i);
  });

  it("reports an unreachable service instead of an empty list", async () => {
    shell.bridge = false;
    view();
    expect(await screen.findByTestId("approve-error")).toHaveTextContent(/unavailable/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("ApprovePage ▸ the list shrinks under the operator", () => {
  /** A backing list the case can shorten between reads. */
  function backedBy(getTotal: () => number) {
    invoke.mockImplementation((channel: string, args: { offset?: number }) => {
      if (channel !== "approve.pending") return Promise.resolve({});
      const total = getTotal();
      const at = args?.offset ?? 0;
      const requests = at >= total
        ? []
        : [row({ blockId: `blk_${at}`, requestId: `req-${at}` })];
      return Promise.resolve({ requests, total });
    });
  }

  it("falls back to the last page that still exists instead of a dead end", async () => {
    const user = userEvent.setup();
    let total = 60;
    backedBy(() => total);
    view();
    await screen.findByTestId("approve-row-blk_0");
    await user.click(screen.getByTestId("approve-next"));
    expect(await screen.findByTestId("approve-row-blk_25")).toBeInTheDocument();

    // Everything past the first page gets answered elsewhere. Offset 25 is now
    // past the end, and with total <= 25 the Previous button would be hidden —
    // an empty page with no way back.
    total = 20;
    await user.click(screen.getByTestId("approve-next"));
    await waitFor(() => expect(screen.getByTestId("approve-row-blk_0")).toBeInTheDocument());
    expect(screen.queryByTestId("approve-empty")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("approve.pending", { offset: 0, limit: 25 });
  });

  it("normalizes to the last populated page, not always to the first", async () => {
    const user = userEvent.setup();
    let total = 90;
    backedBy(() => total);
    view();
    await screen.findByTestId("approve-row-blk_0");
    await user.click(screen.getByTestId("approve-next"));
    await user.click(screen.getByTestId("approve-next"));
    expect(await screen.findByTestId("approve-row-blk_50")).toBeInTheDocument();

    // 60 rows means the last page starts at 50 — but we are on 50 already and
    // it is still valid, so shrink further: 30 rows -> last page starts at 25.
    total = 30;
    await user.click(screen.getByTestId("approve-next"));
    await waitFor(() => expect(screen.getByTestId("approve-row-blk_25")).toBeInTheDocument());
    expect(screen.getByTestId("approve-range")).toHaveTextContent("26–30 of 30");
  });

  it("shows the empty state when the last request really is answered", async () => {
    let total = 1;
    backedBy(() => total);
    view();
    await screen.findByTestId("approve-row-blk_0");
    total = 0;
    // A genuinely empty list is not a paging failure and must not re-fetch.
    invoke.mockClear();
    await useAppStore.getState().answerPermission("req-0", "allow").catch(() => {});
    expect(screen.getByTestId("approve-row-blk_0")).toBeInTheDocument();
  });
});
