import type { ToolDefinition } from "../tools/types.js";

export const CREW_DEBATE_TOOL = "crew_debate";
export const CREW_DEBATE_DESCRIPTION = "Request the custom crew's configured debate after this turn, followed by your final decision in this chat. Use core or major to classify the decision. Finish your current turn after requesting.";
export type CrewDebateRequest = { trigger: unknown; topic: string };
export type CrewDebateResult = { ok: true } | { ok: false; reason: string };
export const CREW_DEBATE_SCHEMA = {
  type: "object" as const,
  properties: { trigger: { type: "string", enum: ["core", "major"] }, topic: { type: "string", minLength: 1, maxLength: 4000 } },
  required: ["trigger", "topic"], additionalProperties: false,
};
export function crewDebateTool(run: (request: CrewDebateRequest) => CrewDebateResult): ToolDefinition {
  return { name: CREW_DEBATE_TOOL, description: CREW_DEBATE_DESCRIPTION, parameters: CREW_DEBATE_SCHEMA,
    permissionClass: "execute", family: "task",
    async run(input) {
      const result = run({ trigger: input.trigger, topic: typeof input.topic === "string" ? input.topic : "" });
      return result.ok ? { content: "Debate queued after this turn. Finish your current response." } : { content: result.reason, isError: true };
    } };
}
