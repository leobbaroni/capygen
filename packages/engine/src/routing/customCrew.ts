import {
  CrewDifficultySchema, CrewTaskKindSchema, CrewDebateTriggerSchema,
  validateCrewSemantics,
  type CustomModeDocument, type CrewMember, type CrewTaskKind, type CrewDifficulty,
} from "@capygen/shared";

export interface CrewRouteEvidence {
  ruleId: string | null;
  rosterId: string;
  taskKind: CrewTaskKind;
  difficulty: CrewDifficulty;
  target: CrewMember["target"];
}

type Refusal = { ok: false; reason: string };

/** Pure decisions only: availability and permission checks remain dispatch authorities. */
export function resolveCrewTask(
  crew: CustomModeDocument,
  request: { taskKind?: unknown; difficulty?: unknown },
): { ok: true; member: CrewMember; evidence: CrewRouteEvidence } | Refusal {
  const task = CrewTaskKindSchema.safeParse(request.taskKind);
  const difficulty = CrewDifficultySchema.safeParse(request.difficulty);
  if (!task.success || !difficulty.success) {
    return { ok: false, reason: "Custom delegation requires a valid task kind and difficulty." };
  }
  if (validateCrewSemantics(crew).length) {
    return { ok: false, reason: "The custom crew policy is invalid. Review the policy before delegating." };
  }
  const rule = crew.routing.find((rule) =>
    (!rule.taskKinds || rule.taskKinds.includes(task.data))
    && (!rule.difficulties || rule.difficulties.includes(difficulty.data)));
  const member = crew.roster.find((member) => member.id === (rule?.target ?? crew.defaultWorker));
  if (!member || member.role !== "worker") {
    return { ok: false, reason: "The custom route does not name a worker." };
  }
  return {
    ok: true, member,
    evidence: { ruleId: rule?.id ?? null, rosterId: member.id, taskKind: task.data, difficulty: difficulty.data, target: { ...member.target } },
  };
}

/** The caller queues these entries after the active turn, never as a new user turn. */
export function planCrewDebate(
  crew: CustomModeDocument, trigger: unknown, currentHop: number, hopCap: number,
): { ok: true; rosterIds: string[] } | Refusal {
  const parsed = CrewDebateTriggerSchema.safeParse(trigger);
  if (validateCrewSemantics(crew).length || !parsed.success || !crew.debate.enabled
    || !crew.debate.triggers.includes(parsed.data)) {
    return { ok: false, reason: "The custom policy does not enable this debate." };
  }
  const lead = crew.roster.find((member) => member.role === "lead")!;
  const rosterIds = [...crew.debate.participants, lead.id];
  if (!Number.isInteger(currentHop) || currentHop < 0 || !Number.isInteger(hopCap)
    || hopCap < 1 || hopCap > 20 || currentHop + rosterIds.length > hopCap) {
    return { ok: false, reason: "There are not enough remaining hops for the debate and lead decision." };
  }
  return { ok: true, rosterIds };
}
