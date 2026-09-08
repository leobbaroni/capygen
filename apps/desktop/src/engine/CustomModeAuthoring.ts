import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapygenStore } from "@capygen/db";
import { ApiHarness, ClaudeHarness, type Harness, type HarnessAgent, type KeyProvider } from "@capygen/engine";
import { CrewTargetSchema, CustomModeDocumentSchema, parseCustomModeJsonText, validateCrewAvailability,
  type CrewCapability, type CrewTarget, type CustomModeIssue } from "@capygen/shared";

export interface CustomModeAuthoringDeps {
  store: CapygenStore;
  keys?: KeyProvider;
  capabilities: () => CrewCapability[];
  makeHarness?: (target: CrewTarget, systemPrompt: string) => Harness;
}
export interface AuthoringRequest { requestId: string; sessionId: string; target: CrewTarget; prompt: string }
export interface AuthoringResult { draft: string; issues: CustomModeIssue[]; authoringSessionId: string }
// Shared across service instances: authoring cannot fan out into unbounded paid work.
let activeCount = 0;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

export function createCustomModeAuthoring(deps: CustomModeAuthoringDeps) {
  const requests = new Map<string, AbortController>();
  const seen = new Set<string>();
  const completions = new Map<string, Promise<void>>();
  let disposed = false;
  return {
    async dispose(): Promise<void> {
      disposed = true;
      for (const controller of requests.values()) controller.abort();
      await Promise.all([...completions.values()]);
    },
    cancel(requestId: string): boolean {
      const controller = requests.get(requestId);
      if (!controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    async generate(input: AuthoringRequest): Promise<AuthoringResult> {
      if (disposed || seen.size >= 4096) throw new Error("Authoring service is unavailable");
      if (!input.requestId || input.requestId.length > 200 || seen.has(input.requestId)) throw new Error("Invalid or duplicate authoring request");
      if (!input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 8192) throw new Error("Authoring prompt must be 1–8192 UTF-8 bytes");
      const source = deps.store.sessions.get(input.sessionId);
      if (!source || source.origin === "import") throw new Error("Authoring requires a live session");
      const target = CrewTargetSchema.parse(input.target);
      if (target.backend === "codex") throw new Error("Codex authoring is unavailable until tool and MCP isolation is proven");
      const capabilities = deps.capabilities().map(({ backend, model, efforts, providers }) => ({ backend, model, efforts, providers }));
      if (capabilities.length > 4096 || !capabilities.some((c) => c.backend === target.backend && c.model === target.model
        && c.efforts?.includes(target.effort) && (!target.provider || c.providers?.includes(target.provider)))) throw new Error("Authoring target is unavailable");
      if (Buffer.byteLength(JSON.stringify(capabilities), "utf8") > 65536) throw new Error("Authoring catalogue exceeds 64 KiB");
      if (activeCount >= 2) throw new Error("Two authoring requests are already active");
      seen.add(input.requestId);
      const controller = new AbortController();
      requests.set(input.requestId, controller);
      activeCount++;
      let complete!: () => void;
      completions.set(input.requestId, new Promise<void>((resolve) => { complete = resolve; }));
      let closed = false;
      let directory: string | undefined;
      let harness: Harness | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let turnId: string | undefined;
      let authoringSessionId = "";
      let draft = "";
      const text = new Map<string, string>();
      const issues: CustomModeIssue[] = [];
      const fail = (message: string) => { if (issues.length < 256) issues.push({ path: "", code: "schema", message }); };
      try {
        directory = await mkdtemp(join(tmpdir(), "capygen-authoring-"));
        const { session, agents } = deps.store.sessions.create({ projectId: source.projectId, mode: "solo", title: "Custom mode draft", agents: [{ name: "Author", backend: target.backend, model: target.model, role: "lead", config: target.backend === "claude" ? { claude: { effort: target.effort } } : { api: { provider: target.provider, reasoningEffort: target.effort } } }] });
        authoringSessionId = session.id;
        deps.store.sessions.setArchived(session.id, true);
        const agent = agents[0]!;
        const userTurn = deps.store.turns.create({ sessionId: session.id, role: "user" });
        const stamp = Date.now();
        deps.store.blocks.upsert({ id: randomUUID(), sessionId: session.id, turnId: userTurn.id, index: 0, createdAt: stamp, updatedAt: stamp, kind: "text", text: input.prompt });
        const turn = deps.store.turns.create({ sessionId: session.id, agentId: agent.id, role: "agent", status: "streaming" });
        turnId = turn.id;
        const systemPrompt = "Return only JSON matching this schema. Exactly one lead; routing and defaultWorker reference workers; debate participants reference members. Use only available targets.\nSchema:\n"
          + JSON.stringify(z.toJSONSchema(CustomModeDocumentSchema)) + "\nCapabilities:\n" + JSON.stringify(capabilities);
        harness = deps.makeHarness?.(target, systemPrompt) ?? (target.backend === "claude"
          ? new ClaudeHarness({ authoringSystemPrompt: systemPrompt, disableNativeSubagents: true, log: quiet })
          : new ApiHarness({ authoringSystemPrompt: systemPrompt, keys: deps.keys, useMcp: false, maxIterations: 1, maxTokens: 16384, log: quiet }));
        const ownedHarness = harness;
        const stopped = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            void ownedHarness.interrupt().catch(() => {});
            reject(new Error("cancelled"));
          }, { once: true });
        });
        timer = setTimeout(() => controller.abort(), 120_000);
        const run = async () => {
          if (controller.signal.aborted) throw new Error("cancelled");
          const harnessAgent: HarnessAgent = { agentId: agent.id, name: "Author", backend: target.backend, model: target.model,
            config: target.backend === "claude" ? { claude: { effort: target.effort } } : { api: { provider: target.provider, reasoningEffort: target.effort } } };
          await ownedHarness.start({ sessionId: session.id, projectPath: directory! }, harnessAgent);
          if (controller.signal.aborted) return;
          for await (const event of ownedHarness.send({ turnId: turn.id, text: input.prompt }, { signal: controller.signal })) {
            if (closed) break;
            if (event.type === "usage") {
              const rows = Object.entries(event.byModel);
              for (const [model, usage] of rows.length ? rows : [[event.model, event.usage] as const]) {
                deps.store.usage.record({ sessionId: session.id, agentId: agent.id, turnId: turn.id, backend: event.backend, model, ...usage, costKnown: usage.costKnown ?? usage.costUsd > 0 });
              }
            } else if (!controller.signal.aborted && event.type === "block" && event.patch.kind === "text") {
              text.set(event.key, event.patch.text);
              const next = [...text.values()].join("\n");
              if (Buffer.byteLength(next, "utf8") > 65536) { fail("Draft exceeds 64 KiB"); controller.abort(); break; }
              draft = next;
            } else if (event.type === "block" && event.patch.kind === "error") fail("Authoring backend failed");
            else if (event.type === "turn" && event.status === "error") fail("Authoring backend failed");
            else if (event.type === "permission") ownedHarness.answerPermission(event.requestId, { behavior: "deny", message: "Authoring tools disabled" });
          }
        };
        await Promise.race([run(), stopped]);
        const parsed = parseCustomModeJsonText(draft);
        issues.push(...parsed.issues.slice(0, 256 - issues.length));
        if (parsed.ok) issues.push(...validateCrewAvailability(parsed.document, capabilities).slice(0, 256 - issues.length));
      } catch {
        fail(controller.signal.aborted ? "Authoring cancelled or timed out; usage may be partial" : "Authoring failed");
      } finally {
        closed = true;
        if (timer) clearTimeout(timer);
        if (harness) {
          let cleanupDone = false;
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            harness.dispose().catch(() => { if (!cleanupDone) fail("Authoring cleanup failed"); }),
            new Promise<void>((resolve) => { cleanupTimer = setTimeout(() => { fail("Authoring cleanup timed out; usage may be partial"); resolve(); }, 2000); }),
          ]);
          cleanupDone = true;
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        requests.delete(input.requestId);
        activeCount--;
        try {
          if (turnId) {
            const now = Date.now();
            deps.store.blocks.upsert({ id: randomUUID(), sessionId: authoringSessionId, turnId, index: 0, createdAt: now, updatedAt: now, kind: "text", text: draft });
            if (issues.length) deps.store.blocks.upsert({ id: randomUUID(), sessionId: authoringSessionId, turnId, index: 1, createdAt: now, updatedAt: now, kind: "error", message: issues.map((issue) => issue.message).join("\n") });
            deps.store.turns.setStatus(turnId, controller.signal.aborted ? "interrupted" : issues.length ? "error" : "done");
          }
        } finally { completions.delete(input.requestId); complete(); }
      }
      return { draft, issues, authoringSessionId };
    },
  };
}
