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
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, GitBranch } from "lucide-react";
import { DEFAULT_HEADING, type Project } from "@capygen/shared";
import { Composer, type AgentChoice } from "@/components/Composer";
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
  // SPEC item 5's harness picker: nothing chosen yet reads as "use the
  // default backend/model" (Settings ▸ General) — `startSession` only gets a
  // `leadAgent` override once the user has actually picked one.
  const [leadAgent, setLeadAgent] = useState<AgentChoice | null>(null);

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
    const session = await startSession(
      target.id,
      text.slice(0, 60),
      leadAgent ? { ...leadAgent, name: harnessName } : undefined,
    );
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
          {/* h-14 (56px) inside the reference's h-16 hero box:
              NewChatDialog.tsx `<BrandLogo variant="eyes" className="h-14 w-auto" />`. */}
          <Mascot state={mascotState} size={56} />
          <h1
            className="min-w-0 text-center text-[2.15em] font-normal tracking-[-0.05em] text-foreground"
            data-testid="landing-heading"
          >
            {DEFAULT_HEADING}
          </h1>
        </div>

        <Composer
          onSubmit={handleSubmit}
          disabled={!bridgeAvailable}
          testId="landing-composer"
          commands={commands}
          harnesses={harnesses}
          agent={leadAgent}
          onPickAgent={setLeadAgent}
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
            </>
          }
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
