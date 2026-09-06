/**
 * New Session landing (P1, skeleton).
 *
 * Layout copied from Omnigent's
 * reference/omnigent/web/src/shell/NewChatDialog.tsx `NewChatLandingScreen`:
 * a centred column capped at 840px, the hero mark above a large heading, the
 * composer under it, chips in the tray. Omnigent's star mark is replaced by the
 * capybara (SPEC §Design Reference), and the heading keeps Omnigent's copy,
 * "What should we build?".
 *
 * Submitting creates the session and navigates to it, then sends the text —
 * SPEC R5: submitting the composer creates a session and starts the first turn.
 *
 * Round-table mode (SPEC R10, item B2.1): a `ModePicker` next to the harness
 * picker chooses Solo orchestrator vs. Round-table; in round-table mode an
 * "Agents" chip opens `AddAgentDialog` (`mode="draft"`) to build the roster
 * before the session exists — each add appends an `AgentDraft` to
 * `draftAgents`, shown as removable pills next to the chip. Submitting
 * prefers that roster whole over the harness picker's single `leadAgent`
 * choice when it is non-empty (`sessions.create`'s own `AgentDraftSchema`
 * already carries every field the dialog collects); switching back to solo
 * clears it, since a solo session has exactly one agent anyway (ADR-0002).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CrownIcon, Folder, GitBranch, UsersIcon, XIcon } from "lucide-react";
import { DEFAULT_HEADING, type AgentDraft, type Project, type SessionMode } from "@capygen/shared";
import { AddAgentDialog } from "@/components/AddAgentDialog";
import { Composer, type AgentChoice } from "@/components/Composer";
import { ModePicker } from "@/components/ModePicker";
import { SetupBanner } from "@/components/SetupBanner";
import { Mascot } from "@/brand/Mascot";
import { Wordmark } from "@/brand/Wordmark";
import { useMascotState } from "@/hooks/useMascotState";
import { useAppStore } from "@/store/appStore";

export function LandingPage() {
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const pickProject = useAppStore((s) => s.pickProject);
  const startSession = useAppStore((s) => s.startSession);
  const send = useAppStore((s) => s.send);
  const commands = useAppStore((s) => s.commands);
  const harnesses = useAppStore((s) => s.harnesses);
  const bridgeAvailable = useAppStore((s) => s.bridgeAvailable);
  const error = useAppStore((s) => s.error);
  const mascotState = useMascotState();

  const [selected, setSelected] = useState<Project | null>(null);
  const project = selected ?? projects[0] ?? null;
  // SPEC item 5's harness picker. Seeded from the first *available* backend as
  // soon as `harness.list` answers, and not touched again once the user picks.
  //
  // Leaving it null was a lie the picker told: the button labelled itself with
  // the first available harness, but a session created without opening the
  // picker sent `agents: []`, and `sessions.create`'s fallback is hardcoded to
  // `claude`. On a machine where Codex is signed in and Claude is not, the
  // button said "Codex" and the turn ran — and failed — on Claude.
  const [leadAgent, setLeadAgent] = useState<AgentChoice | null>(null);
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked) return;
    const first = harnesses.find((h) => h.available);
    if (!first || !first.defaultModel) return;
    setLeadAgent({ backend: first.backend, model: first.defaultModel });
  }, [harnesses, picked]);

  function chooseAgent(choice: AgentChoice): void {
    setPicked(true);
    setLeadAgent(choice);
  }

  // SPEC R10/item B2.1: mode picker next to the harness picker. Switching
  // back to solo clears any drafted roster — a solo session has exactly one
  // agent (ADR-0002), so a leftover multi-agent draft would just be ignored
  // by `handleSubmit` anyway; clearing it keeps the "N agents" chip honest.
  const [mode, setMode] = useState<SessionMode>("solo");
  const [draftAgents, setDraftAgents] = useState<AgentDraft[]>([]);
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  function changeMode(next: SessionMode): void {
    setMode(next);
    if (next === "solo") setDraftAgents([]);
  }

  /** Appends a drafted agent; a fresh "make lead" demotes any earlier draft
   *  that had also claimed it, so `sessions.create` never sees two. */
  function addDraftAgent(draft: AgentDraft): void {
    setDraftAgents((prev) => {
      const next = draft.role === "lead" ? prev.map((a) => ({ ...a, role: "member" as const })) : prev;
      return [...next, draft];
    });
  }

  function removeDraftAgent(index: number): void {
    setDraftAgents((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(text: string): Promise<void> {
    // No project yet: ask for one first. The picker is the shell's native
    // dialog, so nothing is created until the user actually chooses a folder.
    let target = project;
    if (!target) {
      target = await pickProject();
      if (!target) return;
      setSelected(target);
    }
    const harnessName = harnesses.find((h) => h.backend === leadAgent?.backend)?.label ?? "Agent";
    // The drafted round-table roster wins whole over the harness picker's
    // single choice — `sessions.create`'s `AgentDraftSchema` already carries
    // every field `AddAgentDialog` collects (description, sub-agent routing,
    // colour), so there is nothing left for `leadAgent` to add on top of it.
    const agentsForSession: AgentDraft[] =
      draftAgents.length > 0
        ? draftAgents
        : leadAgent
          ? [{ name: harnessName, backend: leadAgent.backend, model: leadAgent.model, role: "lead", config: null }]
          : [];
    const session = await startSession(target.id, text.slice(0, 60), mode, agentsForSession);
    navigate(`/c/${session.id}`);
    await send(text);
  }

  return (
    <div
      className="relative flex flex-1 items-center justify-center"
      data-testid="landing"
    >
      {/* Padding lives inside the 840px cap, so the composer renders at
          840 − 80 = 760px max. */}
      <div className="flex w-full max-w-[840px] flex-col items-center gap-6 px-10 pt-8 pb-16 select-none">
        <div className="flex w-full flex-col items-center justify-center gap-3.5">
          {/* The 72px pixel drawing at an exact 2x scale, per the mascot brief. */}
          <Mascot state={mascotState} size={144} />
          <h1
            className="min-w-0 text-center text-[2.15em] font-normal tracking-[-0.05em] text-foreground"
            data-testid="landing-heading"
          >
            {DEFAULT_HEADING}
          </h1>
        </div>

        {/* SPEC R3: nothing to type to until at least one backend is set up.
            SetupBanner renders nothing once Claude Code or Codex is
            available, so this costs the common case one always-empty slot. */}
        <SetupBanner />

        <Composer
          onSubmit={handleSubmit}
          disabled={!bridgeAvailable}
          testId="landing-composer"
          commands={commands}
          harnesses={harnesses}
          agent={leadAgent}
          onPickAgent={chooseAgent}
          tray={
            <>
              {/* Host chip: capygen is local-only (no host/sandbox picker per
                  SPEC's Out of Scope), so this always names this machine —
                  the green dot is the reference's "online" indicator. */}
              <span
                data-testid="host-chip"
                className="flex h-6 cursor-default items-center gap-1 rounded-full px-2.5 text-sm font-normal text-muted-foreground"
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
                <span className="max-w-32 truncate">This machine</span>
              </span>
              <button
                type="button"
                onClick={() => void pickProject().then((p) => p && setSelected(p))}
                data-testid="project-chip"
                className="flex h-6 cursor-pointer items-center gap-1 rounded-full px-2.5 text-sm font-normal text-muted-foreground transition-colors hover:text-foreground"
              >
                <Folder className="ui-icon" />
                <span className="max-w-40 truncate">
                  {project ? project.name : "Choose a folder"}
                </span>
              </button>
              {/* Worktree chip: placeholder per the task brief — worktree
                  creation (git ops, branch picker) lands in Phase 7 (P8). */}
              <span
                data-testid="worktree-chip"
                title="Worktrees arrive in a later phase"
                className="flex h-6 cursor-not-allowed items-center gap-1 rounded-full px-2.5 text-sm font-normal text-muted-foreground/60"
              >
                <GitBranch className="ui-icon" />
                <span className="max-w-32 truncate">main</span>
              </span>

              <ModePicker mode={mode} onChange={changeMode} testId="landing-mode-picker" />

              {mode === "round-table" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setAddAgentOpen(true)}
                    data-testid="landing-agents-chip"
                    className="flex h-6 cursor-pointer items-center gap-1 rounded-full px-2.5 text-sm font-normal text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <UsersIcon className="ui-icon" />
                    <span className="max-w-32 truncate">
                      {draftAgents.length === 0
                        ? "Add agents"
                        : `${draftAgents.length} agent${draftAgents.length > 1 ? "s" : ""}`}
                    </span>
                  </button>
                  {draftAgents.map((draft, i) => (
                    <span
                      key={`${draft.mentionName ?? draft.displayName ?? draft.name}-${i}`}
                      data-testid="landing-draft-agent"
                      className="flex h-6 items-center gap-1 rounded-full bg-muted px-2.5 text-sm font-normal text-muted-foreground"
                    >
                      {draft.role === "lead" ? (
                        <CrownIcon className="size-3 shrink-0 text-warning" aria-label="Lead agent" />
                      ) : null}
                      <span className="max-w-28 truncate">{draft.displayName ?? draft.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${draft.displayName ?? draft.name}`}
                        onClick={() => removeDraftAgent(i)}
                        className="rounded-full hover:text-foreground"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  ))}
                </>
              ) : null}
            </>
          }
        />

        <AddAgentDialog
          mode="draft"
          open={addAgentOpen}
          onOpenChange={setAddAgentOpen}
          harnesses={harnesses}
          existingMentionNames={draftAgents
            .map((a) => a.mentionName?.toLowerCase())
            .filter((name): name is string => Boolean(name))}
          defaultLead={draftAgents.length === 0}
          onAdd={addDraftAgent}
        />

        {error ? (
          <p className="text-sm text-destructive" data-testid="landing-error">
            {error}
          </p>
        ) : null}

        <Wordmark className="text-sm text-foreground-tertiary" />
      </div>
    </div>
  );
}
