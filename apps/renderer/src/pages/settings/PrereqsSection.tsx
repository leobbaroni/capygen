/**
 * Settings ▸ Prerequisites (Task B2 item 2, SPEC R3): renders the shared
 * `PrereqPanel` (`apps/renderer/src/components/prereqs/PrereqPanel.tsx`,
 * landed by the task that owns `prereqs.status`/`.run` on the desktop side)
 * — `prereqs.status`'s own re-detect-on-open behaviour, the confirm-dialog
 * and visible-console gate (R3), and the post-Run polling all live there.
 * This file only supplies the section chrome so it matches every other page
 * in the hub. (`PrereqPanel` did not exist yet when this task started —
 * Task B2's own instructions cover that case: "if absent yet, render a
 * placeholder the integrator replaces." It has since landed from the
 * parallel task that owns it, so this is that swap rather than a
 * placeholder.)
 */
import { PrereqPanel } from "@/components/prereqs/PrereqPanel";
import { SectionIntro } from "@/components/settings/primitives";

export function PrereqsSection() {
  return (
    <div data-testid="settings-prereqs">
      <SectionIntro title="Prerequisites" description="Re-checked every time this page opens (R3)." />
      <PrereqPanel />
    </div>
  );
}
