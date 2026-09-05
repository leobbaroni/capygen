# Codex shapes — Phase 1 spike (2026-09-05)

Everything below is either read from the installed packages' `.d.ts` / generated bindings or observed
on the wire by `packages/engine/scripts/spike-codex.ts` (raw, redacted event log:
`docs/spikes/codex.raw.json`, gitignored). Citations are `file:line` (line numbers of the files as
installed on this machine) or `raw:<src>` (entries in the raw log by their `src` tag).

## 0. Binaries on this machine and which one the SDK spawns

| Binary | Path | Version |
| --- | --- | --- |
| installed (on PATH, `codex`) | `C:\Users\TugaPlayz\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` | `codex-cli 0.139.0` |
| bundled by `@openai/codex-sdk` → `@openai/codex` → `@openai/codex-win32-x64` | `node_modules/.pnpm/@openai+codex@0.153.4-win32-x64/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe` | `codex-cli 0.153.4` |

- The SDK resolves the binary itself: `dist/index.js:393-483` (`findCodexPath` → `resolveNativePackage`) walks
  `@openai/codex/package.json` → `@openai/codex-win32-x64/package.json` → `vendor/x86_64-pc-windows-msvc/bin/codex.exe`
  and prepends `vendor/.../codex-path` (contains `rg.exe`) to `PATH` (`dist/index.js:470,485-496`). So the SDK uses
  **0.153.4**, never the user's 0.139.0, unless `codexPathOverride` is passed (`index.d.ts:219`).
- `codex-package.json` next to the binary: `{"layoutVersion":1,"version":"0.153.4","target":"x86_64-pc-windows-msvc",
  "variant":"codex","entrypoint":"bin/codex.exe","resourcesDir":"codex-resources","pathDir":"codex-path"}`.
- Both binaries accept `codex exec --experimental-json` (the flag the SDK passes, `dist/index.js:177`); `--help` on both
  only advertises `--json`.
- Protocol drift 0.139.0 → 0.153.4 (from the generated `ClientRequest.ts` of each): 0.153.4 adds `server/diagnostics`,
  `thread/queue/*`, `thread/items/list`, `thread/timeline/list` (replaces `thread/turns/items/list`), `project/*`,
  `threadSection/*`, `turn/settings/update`, `thread/delete`, `thread/revert`, `plugin/search`, `mcpServer/event/stream/*`,
  `environment/info|status`, `account/bedrock/*`; server request `currentTime/read`; notifications
  `autoApprovalReview/strictReviewRequired`, `rawResponse/completed`, `thread/deleted`, `project/changed`, `thread/queue/changed`,
  `modelProvider/authRecovery*`. Nothing capygen needs was removed. `ThreadItem` gained `functionCallOutput`, `sleep`,
  `subAgentActivity`.
- Recommendation: spawn the **bundled 0.153.4** for both the SDK and the app-server (one protocol version, ships with the
  app, no dependency on what the user installed); expose the installed one only as an opt-in override.

## 1. `@openai/codex-sdk` 0.153.4 (`packages/engine/node_modules/@openai/codex-sdk/dist/index.d.ts`)

Transport: the SDK spawns `codex exec --experimental-json [--config k=v ...] [--model m] [--sandbox s] [--cd dir]
[--add-dir d] [--skip-git-repo-check] [--output-schema file] [resume <threadId>] [--image p]`, writes the prompt to
stdin, and parses one JSON event per stdout line (`dist/index.js:177-305`). It also sets
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts` (`dist/index.js:145,255`). **It does not pass `windowsHide`**
(`dist/index.js:263-266`), so from a GUI process on Windows a console window can flash — one reason to prefer app-server.

### Codex class and options
- `new Codex(options?: CodexOptions)` — `index.d.ts:266-270`.
- `CodexOptions` (`index.d.ts:218-240`): `codexPathOverride?`, `baseUrl?` (becomes `--config openai_base_url=`),
  `apiKey?` (becomes env `CODEX_API_KEY`), `config?: CodexConfigObject` (flattened to `--config a.b=<toml>`),
  `configOverrides?: string[]` (raw `--config` strings), `env?: Record<string,string>` (**replaces** `process.env`;
  the SDK still injects `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`/`CODEX_API_KEY` and prepends its `codex-path`).
- `startThread(options?: ThreadOptions): Thread`, `resumeThread(id, options?)` — `index.d.ts:274,282`. Threads persist in
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` (observed: `raw:appserver-c thread/started` `thread.path`).
- `ThreadOptions` (`index.d.ts:246-260`): `model?`, `threadSource?`, `sandboxMode?: "read-only"|"workspace-write"|
  "danger-full-access"`, `workingDirectory?`, `skipGitRepoCheck?`, `modelReasoningEffort?: "minimal"|"low"|"medium"|"high"|
  "xhigh"|"max"|"ultra"|"persistent"`, `networkAccessEnabled?`, `webSearchMode?: "disabled"|"cached"|"live"`,
  `webSearchEnabled?`, `approvalPolicy?: ApprovalMode`, `additionalDirectories?`.
- `ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted"` (`index.d.ts:242`). **Observed:** codex 0.153.4
  `exec` rejects `--config approval_policy="untrusted"` with `Error: approval_policy = "untrusted" is no longer supported;
  remove this setting` (`raw:sdk-b1`, process exit 1). Use `"on-request"`/`"on-failure"`/`"never"` from the SDK.
- **No approval callback exists.** `TurnOptions = { outputSchema?: unknown; signal?: AbortSignal }` (`index.d.ts:169-174`);
  nothing on `Thread`/`Codex` receives approval or user-input requests. `codex exec` is non-interactive, so a command that
  needs approval cannot be approved through the SDK.

### run vs runStreamed
- `Thread.runStreamed(input, turnOptions?) → Promise<{ events: AsyncGenerator<ThreadEvent> }>` (`index.d.ts:208`,
  type `StreamedTurn` `index.d.ts:185-187`).
- `Thread.run(input, turnOptions?) → Promise<Turn>` with `Turn = { items: ThreadItem[]; finalResponse: string; usage:
  Usage | null }` (`index.d.ts:177-181,211`); `run()` throws `new Error(turnFailure.message)` on `turn.failed`
  (`dist/index.js:118`).
- `Input = string | UserInput[]`, `UserInput = {type:"text",text} | {type:"local_image",path}` (`index.d.ts:191-198`);
  images become `--image` flags.

### ThreadEvent union (`index.d.ts:107-167`)
`thread.started{thread_id}` · `turn.started{}` · `turn.completed{usage}` · `turn.failed{error:{message}}` ·
`item.started{item}` · `item.updated{item}` · `item.completed{item}` · `error{message}`.
`Usage = { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens }`
(`index.d.ts:120-131`; the SDK back-fills `cache_write_input_tokens ??= 0`, `dist/index.js:89`).

### ThreadItem union (`index.d.ts:6-104`)
`agent_message{id,text}` · `reasoning{id,text}` · `command_execution{id,command,aggregated_output,exit_code?,status:
"in_progress"|"completed"|"failed"}` · `file_change{id,changes:[{path,kind:"add"|"delete"|"update"}],status:"completed"|
"failed"}` · `mcp_tool_call{id,server,tool,arguments,result?:{content,_meta?,structured_content},error?:{message},status}` ·
`web_search{id,query}` · `todo_list{id,items:[{text,completed}]}` · `error{id,message}`.

### Observed (auth failure path, `raw:sdk-a`)
```
{"type":"thread.started","thread_id":"01a0735a-b3fa-7de0-b1fa-cf5a4bc78191"}
{"type":"turn.started"}
{"type":"error","message":"Your access token could not be refreshed. Please log out and sign in again."}
{"type":"turn.failed","error":{"message":"Your access token could not be refreshed. Please log out and sign in again."}}
```
then the process exits 1 and the generator throws `Codex Exec exited with code 1: <stderr>` (`dist/index.js:305`).
The rollout file was still created, so `thread_id` is resumable once auth is fixed.

## 2. `codex app-server` JSON-RPC (generated bindings: `docs/spikes/codex-app-server-schema/v0.153.4-ts/`, JSON schema in `v0.153.4-json/`; 0.139.0 equivalents alongside)

Generated with `codex app-server generate-ts --experimental --out …` and `generate-json-schema --experimental --out …`.

### Transport framing (observed + `v0.153.4-json/JSONRPCMessage.json`)
- `codex app-server` (default `--listen stdio://`; also `unix://`, `ws://IP:PORT`) — newline-delimited JSON on stdin/stdout,
  logs on stderr. Spawned with `windowsHide:true` and a cleaned env (no `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
  `CLAUDE_CODE_*`; `PYTHONUTF8=1`) — `scripts/spike-codex.ts` `cleanEnv`.
- Messages: request `{id, method, params, trace?}`, notification `{method, params}`, response `{id, result}`, error
  `{id, error:{code, message, data?}}` (`JSONRPCMessage.json` definitions; `RequestId = string | int64`). **The
  `"jsonrpc":"2.0"` field is omitted on the wire** (no `jsonrpc` property anywhere in the schema bundle; the server
  answered plain `{id, method, params}` requests).
- Server → client requests carry `id` + `method` and must be answered with `{id, result}` / `{id, error}`.
- Unknown method → `{"error":{"code":-32600,"message":"Invalid request: unknown variant `server/diagnostics`, expected one
  of `initialize`, …"}}` (observed on 0.139.0; the message lists every method the binary supports — a cheap capability probe).
  Handler failures → `code:-32603` with the backend error text (observed for `account/rateLimits/read`, `app/list`).

### Handshake (`InitializeParams.ts`, `InitializeResponse.ts`, `ClientNotification.ts`)
```
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name":"capygen-spike","title":"capygen spike","version":"0.1.0"},
     "capabilities":{"experimentalApi":true,"requestAttestation":false}}}
← {"id":1,"result":{"userAgent":"capygen-spike/0.153.4 (Windows 10.0.19045; x86_64) xterm-256color (capygen-spike; 0.1.0)",
     "codexHome":"C:\\Users\\TugaPlayz\\.codex","platformFamily":"windows","platformOs":"windows"}}
→ {"method":"initialized"}
```
`InitializeCapabilities` also has `optOutNotificationMethods?: string[]` and `extensions?` (`InitializeCapabilities.ts:9-32`).
Requests before the handshake are rejected (upstream README). Unsolicited notifications right after init:
`remoteControl/status/changed{status:"disabled",serverName,installationId,environmentId}` and `app/list/updated`.

### Thread + turn (v2)
- `thread/start` params `ThreadStartParams` (`v2/ThreadStartParams.ts:18-76`): `model?`, `modelProvider?`, `cwd?`,
  `approvalPolicy?: AskForApproval`, `approvalsReviewer?: "user"|"auto_review"|"guardian_subagent"`, `sandbox?: SandboxMode`,
  `permissions?` (named profile, exclusive with `sandbox`), `config?` (per-thread overrides), `baseInstructions?`,
  `developerInstructions?`, `personality?`, `ephemeral?`, `historyMode?: "legacy"|"paginated"`, `threadSource?`,
  `dynamicTools?`, `experimentalRawEvents?`.
  `AskForApproval = "untrusted" | "on-request" | {granular:{sandbox_approval,rules,skill_approval,request_permissions,
  mcp_elicitations}} | "never"` (`v2/AskForApproval.ts:5`); `SandboxMode = "read-only"|"workspace-write"|"danger-full-access"`.
  **Observed:** `thread/start` with `approvalPolicy:"untrusted"` was accepted on 0.153.4 and echoed back
  (`raw:appserver-d1`), unlike `exec`'s config key.
  The user's `~/.codex/config.toml` sets `approvals_reviewer = "auto_review"`, which would route approvals to a review
  subagent instead of the client — capygen must pass `approvalsReviewer:"user"` when it wants to show approval cards.
- Response `ThreadStartResponse` (`v2/ThreadStartResponse.ts:14-41`), observed:
  `{thread:{id:"01a0735a-c101-…",sessionId,forkedFromId:null,parentThreadId:null,preview:"",ephemeral:false,historyMode:
  "paginated",modelProvider:"openai",model:"gpt-5.5",reasoningEffort:"high",createdAt,updatedAt,recencyAt,status:{type:
  "idle"},path:"C:\\Users\\…\\.codex\\sessions\\2026\\09\\05\\rollout-…jsonl",cwd,cliVersion:"0.153.4",source:"vscode",
  canAcceptDirectInput:true,threadSource:null,gitInfo:null,name:null,turns:[]}, model:"gpt-5.5", modelProvider:"openai",
  serviceTier:null, cwd, runtimeWorkspaceRoots, instructionSources, approvalPolicy:"never", approvalsReviewer:"user",
  sandbox:{type:"readOnly",networkAccess:false}, activePermissionProfile:null, reasoningEffort:"high",
  multiAgentMode:"explicitRequestOnly"}`. Note `source:"vscode"` — app-server threads are labelled that way regardless of
  `clientInfo`; `thread/list` filters by `sourceKinds`, so capygen should not rely on `source` to find its own threads
  (use `cwd` or its own store of thread ids).
- `turn/start` params `TurnStartParams` (`v2/TurnStartParams.ts:20-122`): `threadId`, `input: UserInput[]`,
  `clientUserMessageId?`, `cwd?`, `approvalPolicy?`, `approvalsReviewer?`, `sandboxPolicy?: SandboxPolicy`, `permissions?`,
  `model?`, `effort?`, `summary?`, `personality?`, `outputSchema?`, `collaborationMode?`, `additionalContext?`,
  `responsesapiClientMetadata?`. `UserInput` (`v2/UserInput.ts:7`): `{type:"text",text,text_elements:[]}` |
  `{type:"image",url}` | `{type:"localImage",path}` | `{type:"audio",url}` | `{type:"localAudio",path}` |
  `{type:"skill",name,path}` | `{type:"mention",name,path}` — **skills are invoked by sending a `skill` input part**, which
  is how a `/skill` slash command maps onto the protocol.
  Observed request/response:
  ```
  → {"id":3,"method":"turn/start","params":{"threadId":"…","input":[{"type":"text","text":"Reply with exactly the word pong.","text_elements":[]}],"effort":"low"}}
  ← {"id":3,"result":{"turn":{"id":"01a0735a-c1ba-…","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
  ```
- Related: `turn/interrupt {threadId, turnId}` → `{}`; `turn/steer {threadId, input, expectedTurnId}`; `thread/resume
  {threadId, cwd?, approvalPolicy?, sandbox?, excludeTurns?, initialTurnsPage?}` → `ThreadResumeResponse` with
  `thread.turns[]` plus `turnsBackwardsCursor`/`itemsBackwardsCursor` for `thread/turns/list` / `thread/items/list`
  (`v2/ThreadResumeParams.ts`, `v2/ThreadResumeResponse.ts`); `thread/fork`, `thread/compact/start {threadId}`,
  `thread/name/set`, `thread/list {limit, cursor, cwd?, sourceKinds?, archived?, useStateDbOnly?}` (observed: returns the
  spike threads with `gitInfo:{sha,branch,originUrl}`, `status:{type:"notLoaded"}`), `thread/unsubscribe {threadId}`.

### Notifications streamed during a turn (`ServerNotification.ts:89`; params files under `v2/`)
Observed order for one turn (`raw:appserver-c`, 0.153.4):
`thread/started{thread}` → `mcpServer/startupStatus/updated{threadId,name,status:"starting"|"failed",error,failureReason}`
→ `thread/settings/updated{threadId,threadSettings:{cwd,approvalPolicy,approvalsReviewer,sandboxPolicy,
activePermissionProfile,model,modelProvider,serviceTier,effort,summary,collaborationMode,multiAgentMode,personality}}`
→ `thread/status/changed{threadId,status:{type:"active",activeFlags:[]}}` → `turn/started{threadId,turn}` →
`item/started{item:{type:"userMessage",id,clientId,content:[…]},threadId,turnId,startedAtMs}` →
`item/completed{item,threadId,turnId,completedAtMs}` → … → `turn/completed{threadId,turn:{id,items,itemsView,status:
"completed"|"interrupted"|"failed"|"inProgress",error,startedAt,completedAt,durationMs}}`.
Streaming text/tool deltas (not reached because of the auth failure, shapes from the bindings):
`item/agentMessage/delta{threadId,turnId,itemId,delta}` (`v2/AgentMessageDeltaNotification.ts:5`),
`item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta{threadId,turnId,itemId,delta}`,
`item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `turn/plan/updated`,
`turn/diff/updated`, `thread/tokenUsage/updated{threadId,turnId,tokenUsage:{total,last,modelContextWindow}}` with
`TokenUsageBreakdown = {totalTokens,inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,reasoningOutputTokens}`
(`v2/ThreadTokenUsage.ts:6`, `v2/TokenUsageBreakdown.ts:5`), `thread/compacted`, `error{error:TurnError,willRetry,threadId,
turnId}`, `warning{threadId,message}`, `serverRequest/resolved{threadId,requestId}`, `thread/status/changed` with
`activeFlags:["waitingOnApproval"|"waitingOnUserInput"]` (`v2/ThreadActiveFlag.ts:5`).
`ThreadItem` (v2, `v2/ThreadItem.ts:33`) variants: `userMessage`, `hookPrompt`, `agentMessage{id,text,phase,memoryCitation,
delivery,questions}`, `functionCallOutput`, `plan{id,text}`, `reasoning{id,summary[],content[]}`, `commandExecution{id,
command,cwd,processId,source,status:"inProgress"|"completed"|"failed"|"declined",commandActions[],aggregatedOutput,exitCode,
durationMs,pluginId,scriptPath}`, `fileChange{id,changes[],status}`, `mcpToolCall{id,server,tool,status,arguments,result,
error,durationMs,…}`, `dynamicToolCall`, `collabAgentToolCall{senderThreadId,receiverThreadIds,prompt,model,…}`,
`subAgentActivity`, `webSearch`, `imageView`, `sleep`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`,
`contextCompaction`.

### Observed failure shape (auth): `raw:appserver-c`
```
← {"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"systemError"}}}
← {"method":"error","params":{"error":{"message":"Your access token could not be refreshed. Please log out and sign in again.","codexErrorInfo":"unauthorized","additionalDetails":null,"misalignment":null},"willRetry":false,"threadId":"…","turnId":"…"}}
← {"method":"turn/completed","params":{"threadId":"…","turn":{"id":"…","items":[],"itemsView":"notLoaded","status":"failed","error":{"message":"Your access token could not be refreshed. Please log out and sign in again.","codexErrorInfo":"unauthorized","additionalDetails":null,"misalignment":null},"startedAt":1788641722,"completedAt":1788641724,"durationMs":1787}}}
```
`TurnError = {message, codexErrorInfo, additionalDetails, misalignment}` (`v2/TurnError.ts:7`). capygen's "needs sign-in"
card should key on `codexErrorInfo === "unauthorized"`.

### Approval requests (server → client) — `ServerRequest.ts:20`
- `item/commandExecution/requestApproval` params `CommandExecutionRequestApprovalParams` (`v2/CommandExecutionRequestApprovalParams.ts:13-72`):
  `{kind:"command"|"writeStdin", threadId, turnId, itemId, startedAtMs, approvalId?, environmentId, reason?,
  networkApprovalContext?, command?, cwd?, commandActions?, additionalPermissions?, proposedExecpolicyAmendment?,
  proposedNetworkPolicyAmendments?, availableDecisions?}`.
  Response `{decision: CommandExecutionApprovalDecision}` where the decision is `"accept" | "acceptForSession" |
  {acceptWithExecpolicyAmendment:{execpolicy_amendment}} | {applyNetworkPolicyAmendment:{network_policy_amendment}} |
  "decline" | "cancel"` (`v2/CommandExecutionRequestApprovalResponse.ts:6`, `v2/CommandExecutionApprovalDecision.ts:7`).
  Wire: `← {"id":N,"method":"item/commandExecution/requestApproval","params":{…}}` / `→ {"id":N,"result":{"decision":"accept"}}`.
- `item/fileChange/requestApproval` `{threadId,turnId,itemId,startedAtMs,reason?,grantRoot?}` → `{decision:"accept"|
  "acceptForSession"|"decline"|"cancel"}` (`v2/FileChangeRequestApprovalParams.ts`, `v2/FileChangeApprovalDecision.ts:5`).
- `item/permissions/requestApproval` `{threadId,turnId,itemId,environmentId,startedAtMs,cwd,reason,permissions}` →
  `{permissions: GrantedPermissionProfile, scope: PermissionGrantScope, strictAutoReview?}`.
- `item/tool/requestUserInput` `{threadId,turnId,itemId,questions:[…],isBlocking}` → `{answers:{[questionId]:answer}}`
  (Codex's AskUserQuestion equivalent, `v2/ToolRequestUserInputParams.ts:9`).
- `mcpServer/elicitation/request`, `item/tool/call` (dynamic client tools), `account/chatgptAuthTokens/refresh`,
  `attestation/generate`, `currentTime/read`; legacy v1 `execCommandApproval{conversationId,callId,approvalId,command[],cwd,
  reason,parsedCmd}` → `{decision: ReviewDecision}` with `"approved"|"approved_for_session"|{denied:{rejection}}|"abort"|…`
  (`ExecCommandApprovalParams.ts:7`, `ReviewDecision.ts:10`) and `applyPatchApproval`.
- While a request is pending the thread status carries `activeFlags:["waitingOnApproval"]`; `serverRequest/resolved`
  fires when it is answered. Not exercised live (the turn never reached a tool call — auth), the spike answers all three
  approval methods with accept and the `--only d` attempts cover `untrusted`+`workspace-write`, a non-safelisted
  command, and `on-request`+`read-only` with a blocked write.

### Discovery — what a client can learn (all observed, 0.153.4 unless noted; `raw:appserver-e`)
| Method | Params used | Observed result |
| --- | --- | --- |
| `model/list` | `{}` (`cursor?,limit?,includeHidden?`) | `{data:[{id:"gpt-6-astra",model,displayName:"GPT-6-Astra",description,hidden,supportedReasoningEfforts:[{reasoningEffort:"low",description},…"ultra"],defaultReasoningEffort,inputModalities:["text","image"],supportsPersonality,multiAgentVersion:"v2",serviceTiers:[{id:"priority",name:"Fast",description}],defaultServiceTier,isDefault:true},…gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.2],nextCursor:null}` (static catalog — the online refresh 401'd). 0.139.0 lists gpt-5.5*,gpt-5.4,gpt-5.4-mini,gpt-5.3-codex,gpt-5.2. |
| `skills/list` | `{cwds:[repo]}` (`forceReload?`) | `{data:[{cwd,skills:[{name:"computer-use",description,path:"C:\\Users\\…\\.agents\\skills\\computer-use\\SKILL.md",scope:"user"|"system",enabled:true,pluginId:null,interface?,dependencies?}],errors:[{path,message}]}]}` — 54 skills; 0.139.0 flagged `embedded-captions` as `invalid description: exceeds maximum length of 1024 characters`. `skills/changed` notification exists. |
| `mcpServerStatus/list` | `{}` (`detail?:"full"|"toolsAndAuthOnly",threadId?`) | `{data:[{name:"codex_apps",runtimeStatus:null,pluginId:null,serverInfo:{name:"codex-connectors-mcp",version:"0.1.0",…},tools:{[toolName]:{name,title,description,inputSchema,…}},resources:[],resourceTemplates:[],authStatus:"bearerToken"}],nextCursor:null}` — user has no `[mcp_servers]`; `codex_apps` is the built-in connectors server (89 cached tools on 0.139.0, 0 on 0.153.4 because its startup 401'd). `mcpServer/tool/call`, `mcpServer/resource/read`, `config/mcpServer/reload`, `mcpServer/oauth/login` exist. |
| `hooks/list` | `{cwds:[repo]}` | `{data:[{cwd,hooks:[{key:"C:\\…\\.codex\\hooks.json:post_tool_use:0:0",eventName:"postToolUse",handlerType:"command",matcher:"Edit\|Write\|apply_patch",command,timeoutSec:5,statusMessage,sourcePath,source:"user",pluginId:null,displayOrder,enabled:true,isManaged:false,currentHash,trustStatus:"untrusted"}],warnings:[],errors:[]}]}` |
| `config/read` | `{includeLayers:true,cwd}` | `{config:{95 keys: model:"gpt-5.5",model_reasoning_effort:"high",approval_policy:null,sandbox_mode:null,approvals_reviewer:"auto_review",mcp_servers:{},features:{…},windows:{sandbox:"elevated",…},projects:{…trust_level},…},origins:{[dottedKey]:{name:{type:"user",file,profile},version:"sha256:…"}},layers:[{name:{type:"user",file:"C:\\Users\\…\\.codex\\config.toml"},version,config,disabledReason:null},{name:{type:"system",file:"C:\\ProgramData\\OpenAI\\Codex\\config.toml"},…}]}`. Writes: `config/value/write`, `config/batchWrite`, `configRequirements/read`. |
| `account/read` | `{refreshToken:true}` | `{account:null,requiresOpenaiAuth:true}` (would be `{type:"chatgpt",email,planType}` when signed in — `v2/Account.ts:6`). |
| `getAuthStatus` (v1) | `{includeToken:false,refreshToken:false}` | `{authMethod:"chatgpt",authToken:null,requiresOpenaiAuth:true}` — reports the auth *mode*, not validity. |
| `account/rateLimits/read` | none | error `-32603 failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401` (auth). Shape when it works: `{rateLimits:{primary,secondary,credits,planType,…},rateLimitsByLimitId,…}`; also pushed as `account/rateLimits/updated`. |
| `permissionProfile/list` | `{cwd}` | `{data:[{id:":read-only",description:null,allowed:true},{id:":workspace",…},{id:":danger-full-access",…}],nextCursor:null}` |
| `experimentalFeature/list` | `{}` | 135 features `{name,stage:"underDevelopment"|"beta"|"stable"|"deprecated"|"removed",displayName,description,announcement,enabled,defaultEnabled}` (the `/experimental` TUI command). |
| `collaborationMode/list` | `{}` | `{data:[{name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},{name:"Default",mode:"default",…}]}` |
| `windowsSandbox/readiness` | none | `{status:"ready"}` |
| `thread/list` | `{limit:3,useStateDbOnly:true}` | spike threads (see above). |
| `plugin/list` | `{cwds,forceRefetch:false}` | `{marketplaces:[{name,path,interface,plugins:[{id:"linear@openai-curated",name,source:{type:"local",path},installed,enabled,installPolicy,authPolicy,availability,interface:{displayName,shortDescription,…}}]}],marketplaceLoadErrors:[],featuredPluginIds:[]}` (180 curated on 0.139.0 from a local cache; none on 0.153.4). |
| `server/diagnostics` | `{}` (experimentalApi) | `{process:{id,residentMemoryBytes,physicalFootprintBytes},gauges:[{name:"app.requests.in_flight",value},{name:"app.requests.queued"},{name:"mcp.connections.live"}]}`; unknown on 0.139.0. |
| `app/list` | `{}` | error `-32603 … 403 Forbidden` (Cloudflare managed challenge on `chatgpt.com/backend-api/connectors/directory/list`). |

**Slash commands are not a protocol concept.** Nothing in the schema lists them (grep for "slash" hits only sandbox
path types). The TUI commands map to: `/skill` → `skills/list` + `UserInput{type:"skill"}`; `/review` → `review/start`;
`/compact` → `thread/compact/start`; `/model` → `model/list` + `turn/start.model`/`thread/settings/update`;
`/experimental` → `experimentalFeature/*`; `/mcp` → `mcpServerStatus/list`; `/plugins` → `plugin/*`; `/new` →
`thread/start`; `/resume` → `thread/list` + `thread/resume`. capygen's slash menu for Codex should be assembled from
these plus its own built-ins.

## 3. Sign-in state on this machine (blocker for every model call)

- `codex login status` (both binaries) prints `Logged in using ChatGPT` — it only checks that `~/.codex/auth.json` exists.
- Every request that needs the token fails: refresh → `401 {"error":{"message":"Could not validate your refresh token.
  Please try signing in again.","type":"invalid_request_error","code":"invalid_refresh_token"}}`; models →
  `GET https://chatgpt.com/backend-api/codex/models … 401 … code: unauthorized_unknown`; responses →
  `failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://chatgpt.com/backend-api/codex/responses`
  (`raw:*` stderr entries). The Codex log DB (`~/.codex/logs_2.sqlite`, read-only) shows the same refresh failures from
  six different Codex processes since 2026-09-03 18:00 and zero successful model responses in its window — the token was
  already dead before this spike; `auth.json` dates from 2026-06-10.
- Alternatives tried: the other binary (0.139.0 and 0.153.4 both fail identically) and a forced refresh
  (`account/read {refreshToken:true}` → `account:null`). No `OPENAI_API_KEY`/`CODEX_API_KEY` in the environment.
- Fix (user action, cannot be automated by the app): run `codex logout` then `codex login` in a visible console
  (browser OAuth). Then re-run `corepack pnpm --dir packages/engine exec tsx scripts/spike-codex.ts`.
- What the app should do: treat `turn.error.codexErrorInfo === "unauthorized"` / SDK `turn.failed` message containing
  "could not be refreshed" as the "needs sign-in" card (SPEC §Edge cases), and probe with
  `account/read {refreshToken:true}` (not `codex login status` / `getAuthStatus`) in the setup panel.

## 4. Usage accounting (where tokens are reported)
- SDK: `turn.completed.usage` per turn (`Usage`, `index.d.ts:120-131`); nothing per item.
- app-server: `thread/tokenUsage/updated` per turn with `tokenUsage.last` (this turn) and `tokenUsage.total` (thread)
  as `TokenUsageBreakdown`, plus `modelContextWindow`; `account/usage/read {threadId?}` → `{summary,dailyUsageBuckets,
  threadUsage?}` for account-level history; `account/rateLimits/read` + `account/rateLimits/updated` for the 5h/weekly
  windows. Observed tokens per call: none — every turn failed before the model was reached (`usage:null`).

## 5. Capability verdicts (this run)

| Capability | Status | Evidence |
| --- | --- | --- |
| codex-auth | FAIL | `account/read{refreshToken:true}` → `account:null`; stderr `invalid_refresh_token` |
| sdk-runStreamed-pong | FAIL | events `thread.started, turn.started, error, turn.failed` then exec exit 1 (auth) |
| sdk-resumeThread | not reached | depends on the first turn |
| sdk-command-approval | PARTIAL (by design) | no approval hook in `index.d.ts`; 0.153.4 exec rejects `approval_policy="untrusted"` |
| appserver-thread-turn-stream | FAIL | handshake, `thread/start`, `turn/start` OK; `turn/completed.status:"failed"`, `codexErrorInfo:"unauthorized"` |
| appserver-thread-resume | not reached | depends on the first turn |
| appserver-command-approval | FAIL | three attempts, all `turn.status:"failed"` (auth) before any tool call |
| appserver-discovery | PASS | 14/16 methods answered on 0.153.4 (13/16 on 0.139.0); failures are auth/Cloudflare |

Fallback if app-server ever proves insufficient: none needed for protocol reasons — every capability capygen needs
(stream, approvals, user-input, interrupt, resume, skills/MCP/model discovery, usage) exists in the v2 API. The only
ConPTY-style fallback would be for sign-in itself (`codex login` in a visible terminal), which is the plan anyway.
