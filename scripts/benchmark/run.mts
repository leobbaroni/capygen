/** Opt-in paid benchmark. Default invocation writes an unavailable/pre-registration report only. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { openStore } from "../../packages/db/src/index.js";
import { AsyncQueue } from "../../packages/engine/src/asyncQueue.js";
import { ClaudeHarness } from "../../packages/engine/src/claude/ClaudeHarness.js";
import { cleanEnv } from "../../packages/engine/src/env.js";
import { createDelegateMcpServer } from "../../packages/engine/src/routing/sdkMcp.js";
import { loadClaudeQuery, type ClaudeQueryFn, type ClaudeQuery, type SDKUserMessage } from "../../packages/engine/src/claude/sdk.js";
import { requireIsolatedHomes, TEST_CLAUDE_MODEL, TEST_EFFORT } from "../../packages/engine/scripts/test-policy.js";
import { createSessionRunner } from "../../apps/desktop/src/engine/SessionRunner.js";
import { PAIR_ORDERS, claudeSnapshot, difference, summarize, type Cohort, type Counters, type Lane, type LaneMeasurement } from "./report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const promptsBytes = fs.readFileSync(path.join(here, "prompts.json"));
const prompts: string[] = JSON.parse(promptsBytes.toString("utf8"));
if (prompts.length !== 20 || prompts.some(p => typeof p !== "string" || !p.trim())) throw new Error("Exactly twenty tracked prompts required");
const fixture = fs.readFileSync(path.join(here, "fixture", "INVENTORY.md"));
const settings = { model: TEST_CLAUDE_MODEL, effort: TEST_EFFORT, permissionMode: "plan" as const,
  settingSources: [] as [], strictMcpConfig: true, allowedTools: ["Read"] };
const nativeModelEnvironment = { ANTHROPIC_DEFAULT_HAIKU_MODEL: TEST_CLAUDE_MODEL, CLAUDE_CODE_EFFORT_LEVEL: TEST_EFFORT };
const log = { info() {}, warn() {}, error() {} };
const settingsHash = digest(JSON.stringify(settings));
function sourceHash(): string {
  const hash = createHash("sha256");
  function walk(directory: string): void {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|mts|tsx|json|md)$/.test(name)) { hash.update(path.relative(repo, full).replace(/\\/g,"/")); hash.update(fs.readFileSync(full)); }
    }
  }
  for (const directory of ["apps/desktop/src", "packages/engine/src", "packages/db/src", "packages/shared/src", "scripts/benchmark"]) walk(path.join(repo,directory));
  return hash.digest("hex");
}
const cohort: Cohort = { schemaVersion: 1, cohortId: `${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID()}`,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {cwd:repo,windowsHide:true,env:cleanEnv(process.env),encoding:"utf8"}).trim(),
  sourceHash: sourceHash(), fixtureHash: digest(fixture), promptsHash: digest(promptsBytes), createdAt: new Date().toISOString(), pairs: [] };
const reportDir = path.join(repo,"e2e-out","benchmarks",cohort.cohortId);
fs.mkdirSync(reportDir,{recursive:true});
function persist() {
  // Same cohort journal is updated during collection; older cohort directories are never reused.
  const report = { ...cohort, report: summarize(cohort), accounting: "Claude SDK modelUsage cumulative per conversation; input excludes cache read/write; reasoning is a subset of output. Unknown values invalidate the cohort.",
    laneImplementations: { baseline: "Direct streaming Agent SDK invoking its pinned native CLI", app: "Production createSessionRunner.dispatch solo path and ClaudeHarness; in-process persistence, no renderer" },
    requestedSettings: settings, nativeModelEnvironment, systemPromptPolicy: "Both use the explicit claude_code preset with snapshot:true; application delegation instructions remain measured app overhead.", localToolPolicy: "Read INVENTORY.md only; all other tools denied before native permission handling in both lanes", order: PAIR_ORDERS };
  const temporary = path.join(reportDir,"cohort.tmp");
  fs.writeFileSync(temporary,JSON.stringify(report,null,2)+"\n");
  fs.renameSync(temporary,path.join(reportDir,"cohort.json"));
}

let owned: string | null = null;
let stopped = false;
process.once("SIGINT",()=>{ stopped = true; });

async function main(): Promise<void> {
  persist(); // pre-register the fixed three-pair order before attempting any lane
  if (!process.argv.includes("--live")) { cohort.unavailableReason = "Live measurement not requested. No model call was made; invoke --live only with dedicated authenticated test homes."; return; }
  const claudeHome = process.env.CAPYGEN_TEST_CLAUDE_HOME?.trim();
  const codexHome = process.env.CAPYGEN_TEST_CODEX_HOME?.trim();
  if (!claudeHome || !codexHome) { cohort.unavailableReason = "Dedicated authenticated CAPYGEN_TEST_CLAUDE_HOME and CAPYGEN_TEST_CODEX_HOME are required. No model call was made."; return; }
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  try { requireIsolatedHomes("benchmark"); } catch { cohort.unavailableReason = "Test-home validation refused the supplied paths. No model call was made."; return; }
  if (![claudeHome,codexHome].every(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory())) { cohort.unavailableReason = "Dedicated test homes must already exist and be separately authenticated; no home or credentials are created/copied."; return; }
  if(process.platform !== "win32" || process.arch !== "x64") {cohort.unavailableReason="This pinned cohort requires the verified Windows x64 native CLI.";return;}
  const requireSdk = createRequire(path.join(repo,"packages","engine","package.json"));
  const sdkDir = path.dirname(requireSdk.resolve("@anthropic-ai/claude-agent-sdk"));
  const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkDir,"package.json"),"utf8")).version;
  const cliVersion = JSON.parse(fs.readFileSync(path.join(sdkDir,"manifest.json"),"utf8")).version;
  if (sdkVersion !== "0.3.261" || cliVersion !== "2.1.261") { cohort.unavailableReason = "Pinned SDK/native CLI version mismatch; benchmark not started."; return; }
  const nativePackage = createRequire(path.join(sdkDir,"package.json")).resolve("@anthropic-ai/claude-agent-sdk-win32-x64/package.json");
  const nativeBinary = path.join(path.dirname(nativePackage),"claude.exe");
  if(!fs.existsSync(nativeBinary)) {cohort.unavailableReason="Pinned native CLI is not already installed. No download/install was attempted.";return;}
  const env = cleanEnv(process.env);
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_CODE_OAUTH_TOKEN|CAPYGEN_CODEX_BIN)/.test(key)) delete env[key];
  env.CLAUDE_CONFIG_DIR = claudeHome; env.CODEX_HOME = codexHome;
  Object.assign(env, nativeModelEnvironment);
  const realQuery = await loadClaudeQuery();
  // Keep ancestor-based discovery outside the personal profile as well as
  // selecting dedicated backend homes. Empty settingSources alone is not
  // an isolation boundary for every native CLI discovery mechanism.
  owned = fs.mkdtempSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "Temp", "capygen-benchmark-"));
  const isolatedHome = path.join(owned, "home");
  const roaming = path.join(isolatedHome, "AppData", "Roaming");
  const local = path.join(isolatedHome, "AppData", "Local");
  fs.mkdirSync(roaming, { recursive: true }); fs.mkdirSync(local, { recursive: true });
  env.HOME = isolatedHome; env.USERPROFILE = isolatedHome; env.APPDATA = roaming; env.LOCALAPPDATA = local;
  const project = path.join(owned,"workspace");

  for (let pair = 0; pair < 3; pair++) {
    const order = PAIR_ORDERS[pair]!;
    const measurement = { pair:pair+1, order, lanes:[] as LaneMeasurement[] };
    cohort.pairs.push(measurement);
    for (const lane of order) {
      if (process.argv.includes("--inspect-app-first-turn") && lane !== "app") continue;
      if (stopped) { cohort.unavailableReason = "Cancelled; incomplete cohort retained."; return; }
      await fs.promises.rm(project,{recursive:true,force:true,maxRetries:10,retryDelay:300}); fs.mkdirSync(project);
      fs.writeFileSync(path.join(project,"INVENTORY.md"),fixture);
      const record: LaneMeasurement = { lane, settingsHash, effectiveHash:null, cliVersion:null, sdkVersion,
        model:TEST_CLAUDE_MODEL, effort:TEST_EFFORT, turns:[],error:null };
      measurement.lanes.push(record); persist();
      let snapshot: Counters | null = null;
      let prior: Counters | null = null;
      let captureError: string | null = null;
      let queryCount = 0;
      let query: ClaudeQuery | null = null;
      let results = 0;
      function observe(raw: unknown) {
        const message = raw as Record<string,unknown>;
        if (message.type === "system" && message.subtype === "init") {
          record.cliVersion = typeof message.claude_code_version === "string" ? message.claude_code_version : null;
          if (message.model !== TEST_CLAUDE_MODEL || record.cliVersion !== cliVersion) captureError = "Observed native model/version mismatch";
          if (!Array.isArray(message.tools) || !message.tools.every(t => typeof t === "string") || !Array.isArray(message.mcp_servers)) captureError = "Missing effective tool/MCP metadata";
          // Names and mode only; no backend configuration contents, filesystem paths, or secrets.
          record.effectiveHash = digest(JSON.stringify({ model:message.model, permissionMode:message.permissionMode,
            tools:Array.isArray(message.tools)?[...message.tools].sort():null,
            mcp:Array.isArray(message.mcp_servers)?message.mcp_servers.map((m:Record<string,unknown>)=>({name:m.name,status:m.status})).sort((a,b)=>String(a.name).localeCompare(String(b.name))):null }));
          if (process.argv.some(arg => arg.startsWith("--inspect-"))) console.log(JSON.stringify({ lane, model: message.model, permissionMode: message.permissionMode, tools: message.tools, mcpCount: Array.isArray(message.mcp_servers) ? message.mcp_servers.length : null }));
        }
        if (message.type === "result") {
          results++;
          const rawUsage = message.modelUsage;
          record.observedModelUsage = rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
            ? Object.entries(rawUsage).slice(0, 20).map(([model, value]) => ({
              model: /^claude-[a-zA-Z0-9._-]{1,100}$/.test(model) ? model : "unrecognized-model-id",
              counters: Object.fromEntries(["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "thinkingTokens", "costUSD"].map(key => {
                const number = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
                return [key, typeof number === "number" && Number.isFinite(number) ? number : null];
              })),
            })) : [];
          if (message.is_error || message.subtype !== "success") captureError = "Native turn failed (authentication/provider/permission/cancellation); no raw diagnostic retained";
          try { snapshot = claudeSnapshot(message.modelUsage); } catch { captureError = "Unknown, reset, or unexpected-model usage"; }
        }
      }
      const captured: ClaudeQueryFn = args => {
        queryCount++;
        if (queryCount !== 1 || args.options?.model !== TEST_CLAUDE_MODEL || args.options?.effort !== TEST_EFFORT) throw new Error("Query settings/reset mismatch");
        const options = args.options!;
        const system = options.systemPrompt;
        if (!system || typeof system !== "object" || Array.isArray(system) || system.type !== "preset" || system.preset !== "claude_code" || system.snapshot !== true) throw new Error("Native CLI system prompt policy mismatch");
        if (process.argv.some(arg => arg.startsWith("--inspect-"))) console.log(JSON.stringify({ lane, systemPrompt: typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? { type: options.systemPrompt.type, preset: "preset" in options.systemPrompt ? options.systemPrompt.preset : null, appendBytes: "append" in options.systemPrompt ? Buffer.byteLength(options.systemPrompt.append ?? "", "utf8") : 0 } : typeof options.systemPrompt }));
        if (options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL !== TEST_CLAUDE_MODEL) throw new Error("Native helper model policy mismatch");
        const observedSettings = { model: options.model, effort: options.effort, permissionMode: options.permissionMode,
          settingSources: options.settingSources, strictMcpConfig: options.strictMcpConfig, allowedTools: options.allowedTools };
        record.settingsHash = digest(JSON.stringify(observedSettings));
        if(record.settingsHash !== settingsHash) throw new Error("Actual SDK options differ from registered settings");
        // The app intentionally strips inherited CLAUDE_CODE_* session variables.
        // Reapply the cohort's explicit effort override at this final SDK seam,
        // identically for both lanes, after all environment cleaning.
        query = realQuery({...args,options:{...args.options,env:{...options.env,...nativeModelEnvironment},pathToClaudeCodeExecutable:nativeBinary}});
        return new Proxy(query,{get(target,prop) {
          if (prop === Symbol.asyncIterator) return async function*() { for await (const message of target) { observe(message); yield message; } };
          const value = Reflect.get(target,prop,target); return typeof value === "function" ? value.bind(target) : value;
        }});
      };
      function allowRead(name:string, input:unknown):boolean {
        if(name !== "Read" || !input || typeof input !== "object") return false;
        const file = (input as Record<string,unknown>).file_path;
        return typeof file === "string" && path.resolve(project,file).toLowerCase() === path.join(project,"INVENTORY.md").toLowerCase();
      }
      let close: () => Promise<void> = async () => {};
      try {
        let send: (text:string) => Promise<void>;
        if (lane === "baseline") {
          const input = new AsyncQueue<SDKUserMessage>();
          const servers = await createDelegateMcpServer({ log, run: async () => ({ ok: false, text: "Benchmark permits only Read" }) });
          if (!servers) throw new Error("Matching delegation schema unavailable");
          const q = captured({prompt:input,options:{...settings,cwd:project,env,includePartialMessages:true,systemPrompt:{type:"preset",preset:"claude_code",snapshot:true},mcpServers:servers as NonNullable<Parameters<ClaudeQueryFn>[0]["options"]>["mcpServers"],
            hooks:{PreToolUse:[{hooks:[async (input)=> input.hook_event_name === "PreToolUse" && allowRead(input.tool_name, input.tool_input) ? {} : {
              hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Benchmark permits only Read"},
            }]}]},
            canUseTool:async(toolName,input)=>allowRead(toolName,input) ? {behavior:"allow",updatedInput:input} : {behavior:"deny",message:"Benchmark permits only Read"},stderr:()=>{}}});
          let pumpError = false;
          const pump = (async()=>{try {for await(const message of q) void message;} catch {pumpError=true;}})();
          send = async text => {
            const before = results;
            input.push({type:"user",message:{role:"user",content:text},parent_tool_use_id:null,session_id:""});
            await waitUntil(()=>results>before || pumpError);
            if (pumpError) throw new Error("Native stream failed");
          };
          close = async()=>{input.close(); q.close(); await pump;};
        } else {
          const db = openStore(path.join(owned!,`pair-${pair+1}-app.sqlite`),{migrationsDir:path.join(repo,"packages/db/migrations")});
          const entry = db.projects.upsertByPath({path:project});
          const created = db.sessions.create({projectId:entry.id,mode:"solo",agents:[{name:"Benchmark",role:"lead",backend:"claude",model:TEST_CLAUDE_MODEL,config:{claude:settings}}]});
          const engine = createSessionRunner({store:db,log,broadcast:(event)=>{
            if (event === "permission.request" || event === "question.request") captureError = "Unexpected interaction invalidates benchmark";
          },makeHarness:(_agent,extras)=>new ClaudeHarness({...extras,env,log,query:captured,disableNativeSubagents:true,authorizeLocal:request=>({allowed:allowRead(request.toolName,request.input),approvedInput:request.input,message:"Benchmark permits only Read"})})});
          send = async text => {
            const turn = engine.dispatch({sessionId:created.session.id,text});
            await waitUntil(()=>{const status=db.turns.get(turn.agentTurnId)?.status;return !!status && status!=="streaming" && status!=="pending";});
            if(db.turns.get(turn.agentTurnId)?.status!=="done") throw new Error("App turn did not complete");
          };
          close = async()=>{await engine.dispose();db.db.close();};
        }
        for(let turn=0;turn<20;turn++) {
          const start=Date.now();
          await send(prompts[turn]!);
          if(captureError || !snapshot || stopped) throw new Error("Invalid observed turn");
          const usage=difference(prior,snapshot);
          prior=snapshot;
          record.turns.push({turn:turn+1,status:"done",usage,durationMs:Date.now()-start});
          persist();
          if (process.argv.includes("--inspect-pair-first-turn")) break;
          if (process.argv.includes("--inspect-first-turn") || process.argv.includes("--inspect-app-first-turn")) { cohort.unavailableReason = "Diagnostic first turn only; not an acceptance cohort."; return; }
        }
      } catch {
        record.error = captureError ?? "Lane failed, timed out, or was cancelled. Authentication and complete usage are required; no valid ratio is claimed.";
      } finally { await close().catch(()=>{record.error="Lane teardown failed";}); persist(); }
      if(record.error) {cohort.unavailableReason="A failed lane invalidated this pre-registered cohort; partial results retained without selective reruns.";return;}
    }
    if (process.argv.includes("--inspect-pair-first-turn")) { cohort.unavailableReason = "Diagnostic first pair turn only; not an acceptance cohort."; return; }
  }
}
async function waitUntil(done:()=>boolean):Promise<void> {
  const deadline=Date.now()+180000;
  while(!done()) {if(stopped||Date.now()>deadline)throw new Error("Turn cancelled/timed out");await new Promise(resolve=>setTimeout(resolve,25));}
}
try {await main();} catch {cohort.unavailableReason="Benchmark setup failed; no ratio claimed. Check dedicated test identity and build prerequisites.";}
finally {persist(); if(owned) { try { await fs.promises.rm(owned,{recursive:true,force:true,maxRetries:10,retryDelay:300}); } catch { console.warn("Owned temporary benchmark directory remains locked; report preserved."); } } }
console.log(JSON.stringify({report:path.relative(repo,path.join(reportDir,"cohort.json")),...summarize(cohort)},null,2));
process.exitCode=summarize(cohort).verdict==="pass"?0:1;
