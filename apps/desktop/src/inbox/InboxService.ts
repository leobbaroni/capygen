import type { CapygenStore } from "@capygen/db";
import type { EventChannel, EventInput, EventPayload, InboxItemDraft } from "@capygen/shared";

/** Durable activity index over the engine's existing events; never model input. */
export class InboxService {
  constructor(private readonly store: CapygenStore, private readonly changed: () => void) {}

  handle<E extends EventChannel>(event: E, input: EventInput<E>): void {
    const save = (item: InboxItemDraft) => {
      if (this.store.inbox.insertIgnore(item).inserted) this.changed();
    };
    if (event === "permission.request" || event === "question.request" || event === "elicitation.request") {
      const p = input as EventPayload<"permission.request"> | EventPayload<"question.request"> | EventPayload<"elicitation.request">;
      const kind = event === "permission.request" ? "permission" : event === "question.request" ? "question" : "elicitation";
      const requestId = "request" in p ? p.request.requestId : p.requestId;
      const title = kind === "permission" ? "Permission needed" : kind === "question" ? "Question for you" : "Input needed";
      save({ sessionId: p.sessionId, turnId: p.turnId, requestId, kind, title, body: this.store.sessions.get(p.sessionId)?.title || "Session needs your input", targetBlockId: p.blockId, dedupeKey: `${kind}:${p.sessionId}:${requestId}`, createdAt: Date.now() });
    } else if (event === "chat.turnStatus") {
      const p = input as EventPayload<"chat.turnStatus">;
      if ((p.status === "done" || p.status === "error") && this.store.turns.get(p.turnId)?.role === "agent") {
        const kind = p.status === "done" ? "finished" : "error";
        save({ sessionId: p.sessionId, turnId: p.turnId, requestId: null, kind, title: kind === "finished" ? "Turn finished" : "Agent stopped", body: (p.error || this.store.sessions.get(p.sessionId)?.title || "Session").slice(0, 8192), targetBlockId: null, dedupeKey: `${kind}:${p.turnId}`, createdAt: Date.now() });
      }
      if (p.status !== "streaming" && p.status !== "pending") this.resolveTurn(p.turnId);
    } else if (event === "chat.block") {
      const block = input as EventPayload<"chat.block">;
      const requestId = block.kind === "permission" && block.decision ? block.request.requestId
        : block.kind === "question" && (block.status === "answered" || block.status === "cancelled" || block.answers !== null) ? block.requestId
        : block.kind === "elicitation" && block.status !== "pending" ? block.requestId : null;
      if (requestId && this.store.inbox.resolveByRequest(block.sessionId, requestId)) this.changed();
    }
  }

  private resolveTurn(turnId: string): void {
    const count = this.store.db.run("UPDATE inbox_items SET resolved_at=? WHERE turn_id=? AND request_id IS NOT NULL AND resolved_at IS NULL", Date.now(), turnId);
    if (count) this.changed();
  }

  reconcile(): void {
    // A restarted backend cannot answer requests from its previous process.
    const count = this.store.db.run("UPDATE inbox_items SET resolved_at=? WHERE request_id IS NOT NULL AND resolved_at IS NULL AND turn_id IN (SELECT id FROM turns WHERE status NOT IN ('streaming','pending'))", Date.now());
    if (count) this.changed();
  }
}
