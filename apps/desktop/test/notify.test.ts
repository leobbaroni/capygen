/**
 * The notifications switch, made real (Phase 6, Task C item 1 — SPEC R19/R30).
 *
 * Everything Electron-shaped is injected, so these are the actual rules
 * `main.ts`'s `broadcast` tap runs, not a paraphrase of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalNotifications } from "@capygen/shared";
import { NOTIFY_DEDUPE_LIMIT, createNotifier, type NotificationRequest } from "../src/win/notify.js";

const ALL_ON: GlobalNotifications = {
  enabled: true,
  onFinish: true,
  onNeedsInput: true,
  onRunnerDisconnect: true,
};

let shown: NotificationRequest[];
let settings: GlobalNotifications;
let focused: boolean;

function notifier(over: { show?: (r: NotificationRequest) => void } = {}) {
  return createNotifier({
    settings: () => settings,
    isFocused: () => focused,
    show: over.show ?? ((r) => void shown.push(r)),
    sessionTitle: (id) => (id === "s1" ? "Ship the thing" : null),
    log: { info: () => undefined, warn: () => undefined },
  });
}

beforeEach(() => {
  shown = [];
  settings = { ...ALL_ON };
  focused = false;
});

describe("onFinish", () => {
  it("toasts a finished turn, naming the session", () => {
    notifier().handle("chat.turnStatus", { sessionId: "s1", turnId: "t1", status: "done" });
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("Turn finished");
    expect(shown[0]?.body).toContain("Ship the thing");
  });

  it("falls back to a generic phrase for a session with no title", () => {
    notifier().handle("chat.turnStatus", { sessionId: "other", turnId: "t1", status: "done" });
    expect(shown[0]?.body).toContain("a session");
  });

  it("says nothing for pending/streaming/interrupted", () => {
    const n = notifier();
    for (const status of ["pending", "streaming", "interrupted"] as const) {
      n.handle("chat.turnStatus", { sessionId: "s1", turnId: `t-${status}`, status });
    }
    expect(shown).toEqual([]);
  });

  it("is silent while a window has focus", () => {
    focused = true;
    notifier().handle("chat.turnStatus", { sessionId: "s1", turnId: "t1", status: "done" });
    expect(shown).toEqual([]);
  });

  it("is silent when the switch is off, and when notifications are off wholesale", () => {
    settings = { ...ALL_ON, onFinish: false };
    notifier().handle("chat.turnStatus", { sessionId: "s1", turnId: "t1", status: "done" });
    settings = { ...ALL_ON, enabled: false };
    notifier().handle("chat.turnStatus", { sessionId: "s1", turnId: "t2", status: "done" });
    expect(shown).toEqual([]);
  });

  it("reads the settings per event, so turning them off takes effect at once", () => {
    const n = notifier();
    n.handle("chat.turnStatus", { sessionId: "s1", turnId: "t1", status: "done" });
    settings = { ...ALL_ON, enabled: false };
    n.handle("chat.turnStatus", { sessionId: "s1", turnId: "t2", status: "done" });
    expect(shown).toHaveLength(1);
  });
});

describe("onNeedsInput", () => {
  it("covers all three blocking cards (R32)", () => {
    const n = notifier();
    n.handle("permission.request", {
      sessionId: "s1",
      turnId: "t1",
      blockId: "b",
      request: { requestId: "req", toolName: "Bash", input: {}, suggestions: [] },
    });
    n.handle("question.request", {
      sessionId: "s1",
      turnId: "t2",
      blockId: "b",
      requestId: "r",
      questions: [],
    });
    n.handle("elicitation.request", {
      sessionId: "s1",
      turnId: "t3",
      blockId: "b",
      requestId: "r",
      schema: {},
    });
    expect(shown.map((s) => s.title)).toEqual([
      "Permission needed",
      "Question for you",
      "Input needed",
    ]);
  });

  it("toasts once per turn, however many cards it raises", () => {
    const n = notifier();
    for (let i = 0; i < 3; i += 1) {
      n.handle("permission.request", {
        sessionId: "s1",
        turnId: "t1",
        blockId: `b${i}`,
        request: { requestId: "req", toolName: "Bash", input: {}, suggestions: [] },
      });
    }
    expect(shown).toHaveLength(1);
  });
});

describe("onRunnerDisconnect", () => {
  it("toasts an errored turn with the backend's own message", () => {
    notifier().handle("chat.turnStatus", {
      sessionId: "s1",
      turnId: "t1",
      status: "error",
      error: "the backend ended the turn without a result",
    });
    expect(shown[0]?.title).toBe("Agent stopped");
    expect(shown[0]?.body).toBe("the backend ended the turn without a result");
  });

  it("toasts an app.status error, and ignores info/warn", () => {
    const n = notifier();
    n.handle("app.status", { level: "info", kind: "servers", message: "started", ts: 1 });
    n.handle("app.status", { level: "warn", kind: "servers", message: "port taken", ts: 2 });
    n.handle("app.status", { level: "error", kind: "engine", message: "Codex died", ts: 3 });
    expect(shown.map((s) => s.body)).toEqual(["Codex died"]);
  });

  it("does not repeat the identical app.status failure", () => {
    const n = notifier();
    for (let i = 0; i < 4; i += 1) {
      n.handle("app.status", { level: "error", kind: "engine", message: "Codex died", ts: i });
    }
    expect(shown).toHaveLength(1);
  });

  it("re-toasts once the dedupe ring has rolled past the old key", () => {
    const n = notifier();
    n.handle("chat.turnStatus", { sessionId: "s1", turnId: "t1", status: "done" });
    for (let i = 0; i < NOTIFY_DEDUPE_LIMIT + 1; i += 1) {
      n.handle("chat.turnStatus", { sessionId: "s1", turnId: `filler-${i}`, status: "done" });
    }
    shown = [];
    n.handle("chat.turnStatus", { sessionId: "s1", turnId: "t1", status: "done" });
    expect(shown).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("swallows a throwing notification rather than taking the event down", () => {
    const show = vi.fn(() => {
      throw new Error("no toast host");
    });
    expect(() =>
      notifier({ show }).handle("chat.turnStatus", {
        sessionId: "s1",
        turnId: "t1",
        status: "done",
      }),
    ).not.toThrow();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("ignores every event it has no rule for", () => {
    const n = notifier();
    n.handle("session.updated", {
      id: "s1",
      projectId: "p",
      title: "x",
      mode: "solo",
      leadAgentId: null,
      status: "idle",
      settings: { hopCap: 3, parallelAgents: false },
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    n.handle("settings.changed", { settings: {} as never });
    expect(shown).toEqual([]);
  });
});
