/**
 * [C] The last piece of `agents.describe` (SPEC R13): turning a *running*
 * harness into the `AgentHarnessSnapshot` that `ipc/agentsDescribe.ts` asks
 * for.
 *
 * Three files each did their half of R13 and stopped at a seam:
 *
 *  - `packages/engine/src/{claude,api}/describe.ts` + `describe/codex.ts` map a
 *    backend snapshot to card text, and say in their headers that "wiring a
 *    getter that also remembers `tools`, `mcp_servers` and `permissionMode`" is
 *    the integration task;
 *  - `apps/desktop/src/ipc/agentsDescribe.ts` composes that with usage and the
 *    other agents, and says `snapshotFor` needs "the *running* harness for an
 *    agent — `Engine`/`SessionRunner.ts` state this file's scope does not
 *    include";
 *  - `ipc/handlers.ts` returned `capabilities: [], tools: []` in the meantime.
 *
 * This file is that seam, and it is deliberately duck-typed rather than a new
 * method on the `Harness` interface: only three of the harnesses have anything
 * to report, the shape each reports is its own backend's, and every test double
 * that implements `Harness` (there are several) would otherwise have to grow a
 * method it has no answer for. A harness without the getter simply has no
 * snapshot, which is the same answer as "this agent has not run a turn yet".
 */
import type { HarnessCapabilities } from "@capygen/engine";
import type { Agent } from "@capygen/shared";
import {
  apiConfigDefaults,
  codexConfigDefaults,
  type AgentHarnessSnapshot,
} from "../ipc/agentsDescribe.js";

/** Whatever a harness offers `describeSnapshot()`; narrowed per backend below. */
interface DescribeCapable {
  backend: string;
  capabilities(): HarnessCapabilities;
  describeSnapshot?(): unknown;
}

/**
 * Compose the running harness's own facts with the ones that live on the agent
 * row (Codex's sandbox/approval policy, the API loop's provider) into the
 * snapshot `describeAgent` consumes.
 *
 * Async because Codex has to *ask* its app-server for the MCP server list;
 * Claude and the API loop answer from memory and only look async here.
 * Everything is best-effort: an info card must never be the thing that throws.
 */
export async function harnessDescribeSnapshot(
  harness: DescribeCapable | undefined,
  agent: Agent,
): Promise<AgentHarnessSnapshot | undefined> {
  if (!harness?.describeSnapshot) return undefined;
  let raw: unknown;
  try {
    raw = await harness.describeSnapshot();
  } catch {
    return undefined;
  }
  if (raw === null || raw === undefined) return undefined;
  const capabilities = harness.capabilities();

  if (agent.backend === "claude") {
    return { capabilities, claude: raw as AgentHarnessSnapshot["claude"] };
  }
  if (agent.backend === "codex") {
    const live = raw as { mcpServers: never[]; skills: never[] };
    return {
      capabilities,
      codex: { ...codexConfigDefaults(agent), mcpServers: live.mcpServers, skills: live.skills },
    };
  }
  if (agent.backend === "api") {
    const live = raw as { tools: string[]; mcpServers: never[] };
    return {
      capabilities,
      api: { ...apiConfigDefaults(agent), tools: live.tools, mcpServers: live.mcpServers },
    };
  }
  return undefined;
}
