import { afterEach, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { InboxService } from "../src/inbox/InboxService.js";
let store: CapygenStore | undefined;
afterEach(() => store?.close());
it("deduplicates requests and finishes, resolves interrupted input without marking it read", () => {
  store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/fixture-inbox" });
  const { session } = store.sessions.create({ projectId: project.id, mode: "solo", title: "Inbox test", agents: [] });
  const turn = store.turns.create({ sessionId: session.id, role: "agent", status: "streaming" });
  const changed = vi.fn();
  const service = new InboxService(store, changed);
  for (const role of ["user", "system"] as const) {
    const nonAgent = store.turns.create({ sessionId: session.id, role });
    service.handle("chat.turnStatus", { sessionId: session.id, turnId: nonAgent.id, status: "done" });
  }
  expect(store.inbox.list()).toHaveLength(0);
  store.blocks.upsert({ id: "block", sessionId: session.id, turnId: turn.id, index: 0, kind: "question", requestId: "request", questions: [], answers: null, createdAt: Date.now(), updatedAt: Date.now() });
  const request = { sessionId: session.id, turnId: turn.id, blockId: "block", requestId: "request", questions: [] };
  service.handle("question.request", request);
  service.handle("question.request", request);
  expect(store.inbox.list()).toHaveLength(1);
  expect(changed).toHaveBeenCalledTimes(1);
  store.turns.setStatus(turn.id, "interrupted");
  new InboxService(store, changed).reconcile();
  expect(store.inbox.list()[0]).toMatchObject({ readAt: null, resolvedAt: expect.any(Number) });
  service.handle("chat.turnStatus", { sessionId: session.id, turnId: turn.id, status: "done" });
  service.handle("chat.turnStatus", { sessionId: session.id, turnId: turn.id, status: "done" });
  expect(store.inbox.list()).toHaveLength(2);
  expect(store.inbox.unreadCount()).toBe(2);
});
