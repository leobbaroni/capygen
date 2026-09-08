/**
 * The `codex app-server` wire surface capygen actually reads.
 *
 * The authoritative types are the generated bindings recorded by the Phase 1
 * spike (`docs/spikes/codex-app-server-schema/v0.153.4-ts/`), which are not a
 * package and are not imported at runtime — this file restates *only the fields
 * this harness touches*, each with its binding's file name, so a schema move
 * shows up as a compile error here instead of as a silent `undefined` three
 * layers away. Everything the harness passes through untouched (a tool result's
 * `_meta`, a command's `commandActions`) stays `unknown`.
 *
 * Framing note (`docs/spikes/codex-shapes.md` §2): messages are newline-delimited
 * JSON and the `"jsonrpc":"2.0"` member is **omitted on the wire** — the schema
 * bundle has no such property and the server answers plain `{id, method, params}`.
 */

// ---------------------------------------------------------------------------
// JSON-RPC framing (JSONRPCMessage.json)
// ---------------------------------------------------------------------------

/** `RequestId = string | int64`. */
export type CodexRequestId = string | number;

export interface CodexRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexRpcFrame {
  id?: CodexRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CodexRpcError;
}

// ---------------------------------------------------------------------------
// Handshake (InitializeParams.ts, InitializeResponse.ts)
// ---------------------------------------------------------------------------

export interface CodexClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface CodexInitializeResponse {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

// ---------------------------------------------------------------------------
// Threads and turns (v2/ThreadStartParams.ts, v2/Thread.ts, v2/Turn.ts)
// ---------------------------------------------------------------------------

/** `v2/AskForApproval.ts` — the object variant (`granular`) is passed through. */
export type CodexApprovalPolicyWire = "untrusted" | "on-request" | "never" | Record<string, unknown>;

/** `v2/SandboxMode.ts`. */
export type CodexSandboxModeWire = "read-only" | "workspace-write" | "danger-full-access";

/** `v2/ApprovalsReviewer.ts`. capygen always asks for `"user"` (spike §2). */
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

/**
 * `v2/UserInput.ts` — the three variants capygen sends.
 *
 * `localImage` is the app-server's own attachment variant, spelled exactly as
 * the pinned binding does (`docs/spikes/codex-app-server-schema/v0.153.4-ts/
 * v2/UserInput.ts`: `{"type":"localImage", detail?, path}`); Codex opens the
 * file itself, so the bytes never cross the JSON-RPC pipe. The sibling `image`
 * variant takes a URL and is deliberately unused — a stored file is what
 * capygen already has, and keeping base64 out of the protocol keeps it out of
 * the protocol log.
 */
export type CodexUserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "skill"; name: string; path: string }
  | { type: "localImage"; path: string };

export interface CodexThreadStartParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: CodexApprovalPolicyWire;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandbox?: CodexSandboxModeWire;
  config?: Record<string, unknown>;
}

/** `v2/ThreadStatus.ts`. */
export interface CodexThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: ("waitingOnApproval" | "waitingOnUserInput")[];
}

/** `v2/Thread.ts` — the members the harness reads. */
export interface CodexThread {
  id: string;
  model?: string | null;
  cwd?: string;
  path?: string | null;
  status?: CodexThreadStatus;
  turns?: CodexTurn[];
}

export interface CodexThreadStartResponse {
  thread: CodexThread;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexApprovalPolicyWire;
  approvalsReviewer?: CodexApprovalsReviewer;
  reasoningEffort?: string | null;
}

/** `v2/TurnStatus.ts`. */
export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

/** `v2/TurnError.ts`. `codexErrorInfo === "unauthorized"` is the sign-in case. */
export interface CodexTurnError {
  message: string;
  codexErrorInfo?: string | null;
  additionalDetails?: string | null;
}

/** `v2/Turn.ts`. */
export interface CodexTurn {
  id: string;
  items?: CodexItem[];
  status: CodexTurnStatus;
  error?: CodexTurnError | null;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

// ---------------------------------------------------------------------------
// Items (v2/ThreadItem.ts)
// ---------------------------------------------------------------------------

/** `v2/FileUpdateChange.ts` + `v2/PatchChangeKind.ts`. */
export interface CodexFileChange {
  path: string;
  kind: { type: "add" | "delete" | "update"; move_path?: string | null };
  diff: string;
}

/** `v2/McpToolCallResult.ts` — `_meta` is kept verbatim for the widget host (R31). */
export interface CodexMcpToolCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  _meta?: unknown;
}

/** `v2/McpToolCallAppContext.ts` — where an MCP App's `ui://` resource is named. */
export interface CodexMcpAppContext {
  connectorId?: string;
  linkId?: string | null;
  resourceUri?: string | null;
  appName?: string | null;
  actionName?: string | null;
}

export interface CodexUserMessageItem {
  type: "userMessage";
  id: string;
  content?: unknown[];
}

export interface CodexAgentMessageItem {
  type: "agentMessage";
  id: string;
  text?: string;
  phase?: string | null;
}

export interface CodexReasoningItem {
  type: "reasoning";
  id: string;
  summary?: string[];
  content?: string[];
}

export interface CodexCommandExecutionItem {
  type: "commandExecution";
  id: string;
  command?: string;
  cwd?: string;
  /** `v2/CommandExecutionStatus.ts`. */
  status?: "inProgress" | "completed" | "failed" | "declined";
  commandActions?: unknown[];
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

export interface CodexFileChangeItem {
  type: "fileChange";
  id: string;
  changes?: CodexFileChange[];
  /** `v2/PatchApplyStatus.ts`. */
  status?: "inProgress" | "completed" | "failed" | "declined";
}

export interface CodexMcpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  /** `v2/McpToolCallStatus.ts`. */
  status?: "inProgress" | "completed" | "failed";
  arguments?: unknown;
  appContext?: CodexMcpAppContext | null;
  /** Deprecated alias for `appContext.resourceUri`, still emitted. */
  mcpAppResourceUri?: string;
  result?: CodexMcpToolCallResult | null;
  error?: { message: string } | null;
}

export interface CodexWebSearchItem {
  type: "webSearch";
  id: string;
  query?: string;
  results?: unknown[] | null;
}

/**
 * `v2/CollabAgentState.ts` — the last known state app-server has for one
 * target thread of a `collabAgentToolCall` (its `agentsStates` map is keyed by
 * thread id).
 */
export interface CodexCollabAgentState {
  /** `v2/CollabAgentStatus.ts`. */
  status:
    | "pendingInit"
    | "running"
    | "interrupted"
    | "completed"
    | "errored"
    | "shutdown"
    | "notFound";
  message: string | null;
}

/** `v2/CollabAgentTool.ts` — which collaboration-mode operation this call is. */
export type CodexCollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent"
  | "sendMessage"
  | "followupTask"
  | "interruptAgent"
  | "listAgents";

/**
 * `ThreadItem`'s `collabAgentToolCall` variant (Phase 4, SPEC R12) — Codex's
 * multi-agent collaboration mode routing a tool call (`spawnAgent` and
 * friends) through the orchestrating agent's own thread. `receiverThreadIds`
 * names the sub-agent(s) being acted on; for `spawnAgent` that is the newly
 * created thread.
 */
export interface CodexCollabAgentToolCallItem {
  type: "collabAgentToolCall";
  id: string;
  tool: CodexCollabAgentTool;
  /** `v2/CollabAgentToolCallStatus.ts` — the status of the *call*, not of the
   *  target agent (that is `agentsStates[threadId].status`). */
  status: "inProgress" | "completed" | "failed" | "interrupted";
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort?: string | null;
  agentsStates: Record<string, CodexCollabAgentState | undefined>;
}

/** `v2/SubAgentActivityKind.ts`. */
export type CodexSubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed";

/**
 * `ThreadItem`'s `subAgentActivity` variant — a lifecycle ping for one
 * sub-agent thread, named by `agentPath` (the collaboration-mode nickname/path
 * app-server shows in its own UI, e.g. `"explorer"` or a nested path).
 */
export interface CodexSubAgentActivityItem {
  type: "subAgentActivity";
  id: string;
  kind: CodexSubAgentActivityKind;
  agentThreadId: string;
  agentPath: string;
}

/**
 * The item variants capygen maps to blocks.
 *
 * `ThreadItem` has ~18 more (`imageGeneration`, `contextCompaction`, …). They
 * are deliberately **not** in this union: an unrecognised `item.type` arrives
 * as an unchecked cast and falls through `routeItem`'s `default:` to a log
 * line. Widening the union with a `{ type: string }` catch-all instead would
 * destroy the discriminant and make every `item.command` access a compile
 * error, which is exactly the "silent undefined three layers away" this file
 * exists to prevent.
 *
 * `collabAgentToolCall` / `subAgentActivity` joined this union in Phase 4
 * (SPEC R12) — see `CodexHarness.emitCollabAgentToolCall` /
 * `.emitSubAgentActivity`, mapped to `subagent` blocks the same way Claude's
 * `Task` sub-agent notifications are.
 */
export type CodexItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexDynamicToolCallItem
  | CodexWebSearchItem
  | CodexCollabAgentToolCallItem
  | CodexSubAgentActivityItem;

/** Any item off the wire, before `routeItem` decides whether it is mapped. */
export interface CodexRawItem {
  type: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Notifications (ServerNotification.ts, params under v2/)
// ---------------------------------------------------------------------------

export interface CodexItemNotification {
  item: CodexItem;
  threadId: string;
  turnId: string;
}

export interface CodexDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexPatchUpdatedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: CodexFileChange[];
}

/** `v2/TurnPlanUpdatedNotification.ts` + `TurnPlanStepStatus.ts`. */
export type CodexTurnPlanStepStatus = "pending" | "inProgress" | "completed";

export interface CodexTurnPlanStep {
  step: string;
  status: CodexTurnPlanStepStatus;
}

export interface CodexTurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: CodexTurnPlanStep[];
}

/** `v2/TokenUsageBreakdown.ts`. */
export interface CodexTokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

/** `v2/ThreadTokenUsage.ts` — `last` is this turn, `total` the thread. */
export interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface CodexTokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: CodexThreadTokenUsage;
}

/** `v2/ErrorNotification.ts`. */
export interface CodexErrorNotification {
  error: CodexTurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface CodexTurnCompletedNotification {
  threadId: string;
  turn: CodexTurn;
}

// ---------------------------------------------------------------------------
// Server → client requests (ServerRequest.ts)
// ---------------------------------------------------------------------------

/** `v2/CommandExecutionApprovalDecision.ts` — the plain variants capygen sends. */
export type CodexCommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

/** `v2/FileChangeApprovalDecision.ts` — same four names. */
export type CodexFileChangeApprovalDecision = CodexCommandApprovalDecision;

/** `v2/CommandExecutionRequestApprovalParams.ts`. */
export interface CodexCommandApprovalParams {
  kind?: string;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
  availableDecisions?: unknown[] | null;
}

/** `v2/FileChangeRequestApprovalParams.ts`. */
export interface CodexFileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

/** `v2/ToolRequestUserInputQuestion.ts` — Codex's AskUserQuestion equivalent. */
export interface CodexUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}

/** `v2/ToolRequestUserInputParams.ts`. */
export interface CodexUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
  isBlocking?: boolean;
}

/** `v2/McpServerElicitationRequestParams.ts` (the `form` modes). */
export interface CodexElicitationParams {
  threadId: string;
  turnId?: string | null;
  serverName: string;
  mode?: string;
  message?: string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
  _meta?: unknown;
}

/** `v2/McpServerElicitationAction.ts`. */
export type CodexElicitationAction = "accept" | "decline" | "cancel";

// ---------------------------------------------------------------------------
// Dynamic (client-hosted) tools — `thread/start` + `item/tool/call`
// ---------------------------------------------------------------------------

/**
 * `v2/DynamicToolFunctionSpec.ts`. One tool capygen implements and Codex
 * advertises to the model. `inputSchema` is an arbitrary JSON value on the wire
 * (`serde_json/JsonValue`); capygen always sends a JSON Schema object.
 *
 * `deferLoading` exists in the binding but is deliberately never set here: a
 * deferred tool is one more round trip before the model can use it, and the
 * whole list is two entries at most.
 */
export interface CodexDynamicToolFunctionSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

/** `v2/DynamicToolNamespaceSpec.ts` — declared for completeness; capygen never
 *  sends one, and therefore never accepts a namespaced call (see
 *  `CodexDynamicToolCallParams.namespace`). */
export interface CodexDynamicToolNamespaceSpec {
  type: "namespace";
  name: string;
  description: string;
  tools: CodexDynamicToolFunctionSpec[];
}

/** `v2/DynamicToolSpec.ts` — the `dynamicTools` array on `ThreadStartParams`. */
export type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

/**
 * `v2/DynamicToolCallParams.ts` — the server→client request `item/tool/call`.
 *
 * Every field is typed as it arrives, not as it is promised: this is a frame
 * from another process, so the harness validates each one before anything runs.
 */
export interface CodexDynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

/** `v2/DynamicToolCallOutputContentItem.ts`. capygen only ever returns text. */
export type CodexDynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | { type: "inputAudio"; audioUrl: string };

/**
 * `v2/DynamicToolCallResponse.ts`. `success: false` is a *tool* failure the
 * model can read and act on — the JSON-RPC call itself still succeeded. A
 * JSON-RPC error would tell Codex capygen cannot speak the method at all.
 */
/** `v2/ThreadItem.ts` — Codex's own item for a client-hosted tool call. Its
 *  `id` **is** the `callId` of the matching `item/tool/call`, and `item/started`
 *  arrives before that request (both verified against the pinned binary through
 *  the loopback provider, `scripts/probe-codex-dynamic-tools.ts`). */
export interface CodexDynamicToolCallItem {
  type: "dynamicToolCall";
  id: string;
  namespace: string | null;
  tool: string;
  arguments?: unknown;
  status?: string;
  contentItems?: CodexDynamicToolCallOutputContentItem[] | null;
  success?: boolean | null;
  durationMs?: number | null;
}

export interface CodexDynamicToolCallResponse {
  contentItems: CodexDynamicToolCallOutputContentItem[];
  success: boolean;
}

// ---------------------------------------------------------------------------
// Discovery (model/list, skills/list, mcpServerStatus/list)
// ---------------------------------------------------------------------------

/** `v2/Model.ts` — the members the model picker needs. */
export interface CodexModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  isDefault?: boolean;
}

export interface CodexModelListResponse {
  data?: CodexModel[];
  nextCursor?: string | null;
}

/** `v2/SkillMetadata.ts`. */
export interface CodexSkill {
  name: string;
  description?: string;
  shortDescription?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
  pluginId?: string | null;
}

/** `v2/SkillsListResponse.ts` + `v2/SkillsListEntry.ts`. */
export interface CodexSkillsListResponse {
  data?: { cwd: string; skills?: CodexSkill[]; errors?: unknown[] }[];
}

/** `v2/McpServerStatus.ts`. */
export interface CodexMcpServerStatus {
  name: string;
  runtimeStatus?: unknown;
  pluginId?: string | null;
  serverInfo?: { name?: string; version?: string } | null;
  tools?: Record<string, unknown>;
  resources?: unknown[];
  authStatus?: unknown;
}

export interface CodexMcpServerStatusListResponse {
  data?: CodexMcpServerStatus[];
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// Method names — one place, so COMPAT.md and the code cannot drift apart
// ---------------------------------------------------------------------------

export const CODEX_METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadCompactStart: "thread/compact/start",
  threadSettingsUpdate: "thread/settings/update",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  reviewStart: "review/start",
  skillsList: "skills/list",
  modelList: "model/list",
  mcpServerStatusList: "mcpServerStatus/list",
  accountRead: "account/read",
} as const;

export const CODEX_NOTIFICATIONS = {
  threadStarted: "thread/started",
  threadStatusChanged: "thread/status/changed",
  threadSettingsUpdated: "thread/settings/updated",
  threadTokenUsageUpdated: "thread/tokenUsage/updated",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  reasoningTextDelta: "item/reasoning/textDelta",
  reasoningSummaryTextDelta: "item/reasoning/summaryTextDelta",
  commandExecutionOutputDelta: "item/commandExecution/outputDelta",
  fileChangePatchUpdated: "item/fileChange/patchUpdated",
  turnPlanUpdated: "turn/plan/updated",
  mcpToolCallProgress: "item/mcpToolCall/progress",
  mcpServerStartupStatusUpdated: "mcpServer/startupStatus/updated",
  serverRequestResolved: "serverRequest/resolved",
  error: "error",
  warning: "warning",
} as const;

export const CODEX_SERVER_REQUESTS = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  requestUserInput: "item/tool/requestUserInput",
  elicitation: "mcpServer/elicitation/request",
  /** A model call to one of the client-hosted tools declared on `thread/start`
   *  (`ServerRequest.ts:20` `{method:"item/tool/call", params:
   *  DynamicToolCallParams}`). Note the near-miss with `requestUserInput`
   *  above: `item/tool/call` and `item/tool/requestUserInput` are different
   *  requests with unrelated payloads. */
  dynamicToolCall: "item/tool/call",
  currentTime: "currentTime/read",
} as const;
