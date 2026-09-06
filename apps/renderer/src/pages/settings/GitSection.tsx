/**
 * Settings ▸ Git (R19, R30): `GlobalGitSchema`'s two fields. `autoCommitMessages`
 * is the one field in the whole `GlobalSettings` tree that stays genuinely
 * optional in its *full* shape (that schema's own doc comment) — unset means
 * "ask each time" rather than a fixed policy, so the control is three-valued.
 */
import { ConfigRow, SectionIntro, SectionError, SectionLoading, SettingSelect, SettingToggle } from "@/components/settings/primitives";
import { useGlobalSettings } from "@/components/settings/useGlobalSettings";

const AUTO_COMMIT_OPTIONS = [
  { value: "ask", label: "Ask each time" },
  { value: "always", label: "Always generate" },
  { value: "never", label: "Never generate" },
];

function autoCommitValue(v: boolean | undefined): string {
  if (v === undefined) return "ask";
  return v ? "always" : "never";
}

export function GitSection() {
  const { settings, error, patch } = useGlobalSettings();

  if (error) return <SectionError message={error} />;
  if (!settings) return <SectionLoading />;

  const { git } = settings;

  return (
    <div data-testid="settings-git">
      <SectionIntro title="Git" description="How agents commit on your behalf." />
      <ConfigRow
        label="Auto-generate commit messages"
        description="When an agent commits, write the message from the diff instead of asking."
        testId="row-auto-commit-messages"
      >
        <SettingSelect
          value={autoCommitValue(git.autoCommitMessages)}
          onChange={(value) =>
            void patch({ git: { autoCommitMessages: value === "ask" ? undefined : value === "always" } })
          }
          options={AUTO_COMMIT_OPTIONS}
          data-testid="select-auto-commit-messages"
          aria-label="Auto-generate commit messages"
        />
      </ConfigRow>
      <ConfigRow
        label="New sessions run in a worktree"
        description="Isolates each session's changes from the main working tree by default (P8)."
        testId="row-worktree-default"
      >
        <SettingToggle
          checked={git.worktreeDefault}
          onChange={(checked) => void patch({ git: { worktreeDefault: checked } })}
          data-testid="toggle-worktree-default"
          aria-label="New sessions run in a worktree"
        />
      </ConfigRow>
    </div>
  );
}
