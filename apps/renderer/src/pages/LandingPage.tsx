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
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CrownIcon, Folder, UsersIcon, XIcon } from "lucide-react";
import { builtinSlashCommandsFor, DEFAULT_HEADING, type AgentDraft, type InputImageAttachment, type SessionMode } from "@capygen/shared";
import { loadRoundTableRoster, saveRoundTableRoster, loadRoundTableSettings } from "@/lib/sessionPreferences";
import { withAgentEffort } from "@/lib/agentDisplay";
import { ipc } from "@/lib/ipc";
import { CustomModeEditor } from "@/components/CustomModeEditor";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AddAgentDialog } from "@/components/AddAgentDialog";
import { Composer, type AgentChoice } from "@/components/Composer";
import { ModePicker } from "@/components/ModePicker";
import { SetupBanner } from "@/components/SetupBanner";
import { WorktreeChip } from "@/components/WorktreeChip";
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

  // 7-P0: the selected project is **window** state, not page state — the
  // settings page this window navigates to next scopes its integrations calls
  // to the same project. `init` seeds it from recency once; picking a folder
  // here sets it.
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const project = projects.find((p) => p.id === selectedProjectId) ?? null;
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
  const [draftAgents, setDraftAgents] = useState<AgentDraft[]>(loadRoundTableRoster);
  useEffect(() => { saveRoundTableRoster(draftAgents); }, [draftAgents]);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [customSessionId, setCustomSessionId] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customReady, setCustomReady] = useState(false);
  const creatingCustom = useRef(false);
  const [setupError, setSetupError] = useState("");

  async function ensureProject() {
    if (project) return project;
    // A click may beat bootstrap's project list after a restart. Resolve the
    // existing registry before treating an empty renderer snapshot as no folder.
    const known = await ipc().invoke("projects.list", {});
    const selected = useAppStore.getState().selectedProjectId;
    const target = known.find((item) => item.id === selected) ?? known[0]
      ?? await ipc().invoke("projects.default", {});
    useAppStore.setState((state) => ({ projects: [target, ...known.filter((item) => item.id !== target.id), ...state.projects.filter((item) => item.id !== target.id && !known.some((entry) => entry.id === item.id))], selectedProjectId: target.id }));
    return target;
  }

  async function configureCustom() {
    if (creatingCustom.current) return;
    if (customSessionId) { setCustomOpen(true); return; }
    creatingCustom.current = true;
    setSetupError("");
    try {
      const target = await ensureProject();
      const session = await startSession(target.id, "Custom crew", "solo", leadAgent ? [{ name: "Lead", backend: leadAgent.backend, model: leadAgent.model, role: "lead", config: withAgentEffort(null, leadAgent.backend, leadAgent.effort ?? "") }] : []);
      setCustomSessionId(session.id);
      setCustomOpen(true);
    } catch (reason) { setSetupError(String(reason)); }
    finally { creatingCustom.current = false; }
  }

  function changeMode(next: SessionMode): void {
    setMode(next);
    if (next === "custom") void configureCustom();
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

  async function handleSubmit(text: string, images: InputImageAttachment[] = []): Promise<void> {
    // Resolve the selected/recent project, then the optional home default.
    if (mode === "custom") {
      if (!customReady || !customSessionId) { await configureCustom(); throw new Error("Review and apply your custom crew before sending."); }
      await useAppStore.getState().openSession(customSessionId);
      navigate(`/c/${customSessionId}`);
      await send(text, images);
      return;
    }
    const target = await ensureProject();
    const harnessName = harnesses.find((h) => h.backend === leadAgent?.backend)?.label ?? "Agent";
    // The drafted round-table roster wins whole over the harness picker's
    // single choice — `sessions.create`'s `AgentDraftSchema` already carries
    // every field `AddAgentDialog` collects (description, sub-agent routing,
    // colour), so there is nothing left for `leadAgent` to add on top of it.
    const agentsForSession: AgentDraft[] =
      mode === "round-table" && draftAgents.length > 0
        ? draftAgents
        : leadAgent
          ? [{ name: harnessName, backend: leadAgent.backend, model: leadAgent.model, role: "lead", config: withAgentEffort(null, leadAgent.backend, leadAgent.effort ?? "") }]
          : [];
    const session = await startSession(target.id, text.slice(0, 60), mode, agentsForSession);
    const defaults = mode === "round-table" ? loadRoundTableSettings() : null;
    if (defaults) await useAppStore.getState().updateSessionSettings(session.id, defaults);
    navigate(`/c/${session.id}`);
    await send(text, images);
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-y-auto"
      data-testid="landing"
    >
      {/* Padding lives inside the 840px cap, so the composer renders at
          840 − 80 = 760px max. */}
      <div className="m-auto flex w-full max-w-[840px] flex-col items-center gap-4 px-5 pt-12 pb-8">
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
          commands={leadAgent && mode !== "custom" ? commands.filter((command) => command.source === "builtin" && builtinSlashCommandsFor(leadAgent.backend).some((allowed) => allowed.name === command.name)) : []}
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
                onClick={() => void pickProject()}
                data-testid="project-chip"
                className="flex h-6 cursor-pointer items-center gap-1 rounded-full px-2.5 text-sm font-normal text-muted-foreground transition-colors hover:text-foreground"
              >
                <Folder className="ui-icon" />
                <span className="max-w-40 truncate">
                  {project ? project.name : "Home folder"}
                </span>
              </button>
              <WorktreeChip projectId={project?.id ?? null} onSelect={(next) => useAppStore.setState((state) => ({
                projects: [next, ...state.projects.filter((item) => item.id !== next.id)],
                selectedProjectId: next.id,
              }))} />

              <ModePicker mode={mode} onChange={changeMode} allowCustom testId="landing-mode-picker" />
              {mode === "custom" && <button type="button" className="rounded-full px-2 py-1 text-sm text-primary" onClick={() => void configureCustom()}>{customReady ? "Edit crew" : "Configure crew"}</button>}

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

        <Dialog open={customOpen} onOpenChange={setCustomOpen}>
          <DialogContent aria-label="Custom mode" className="max-w-3xl overflow-y-auto">
            <div className="flex items-center justify-between"><DialogTitle>Custom mode</DialogTitle><button type="button" onClick={() => setCustomOpen(false)} aria-label="Close custom mode">×</button></div>
            {customSessionId && <CustomModeEditor sessionId={customSessionId} onApplied={() => { setCustomReady(true); setCustomOpen(false); }} />}
          </DialogContent>
        </Dialog>
        {setupError && <p role="alert" className="text-sm text-destructive">{setupError}</p>}
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
