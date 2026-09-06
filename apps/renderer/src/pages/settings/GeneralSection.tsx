/**
 * Settings ▸ General (R19, R30): the top of `GlobalSettings` — default
 * backend/model for a brand-new session, composer behaviour, and the two
 * window-lifecycle flags that live at the object's root rather than in a
 * section (`closeToTray`, `startWithWindows`).
 */
import { ConfigRow, SectionError, SectionIntro, SectionLoading, SettingInput, SettingSelect, SettingToggle } from "@/components/settings/primitives";
import { useGlobalSettings } from "@/components/settings/useGlobalSettings";
import { BACKEND_LABEL } from "@/lib/agentDisplay";

const BACKEND_OPTIONS = (Object.keys(BACKEND_LABEL) as (keyof typeof BACKEND_LABEL)[]).map((id) => ({
  value: id,
  label: BACKEND_LABEL[id],
}));

export function GeneralSection() {
  const { settings, error, patch } = useGlobalSettings();

  if (error) return <SectionError message={error} />;
  if (!settings) return <SectionLoading />;

  const { general } = settings;

  return (
    <div data-testid="settings-general">
      <SectionIntro
        title="General"
        description="Defaults for a brand-new session and how the composer behaves."
      />
      <ConfigRow label="Default backend" description="Which harness a new session's lead agent starts on." testId="row-default-backend">
        <SettingSelect
          value={general.defaultBackend}
          onChange={(value) => void patch({ general: { defaultBackend: value as never } })}
          options={BACKEND_OPTIONS}
          data-testid="select-default-backend"
          aria-label="Default backend"
        />
      </ConfigRow>
      <ConfigRow label="Default model" description="Model id passed to that backend when none is chosen." testId="row-default-model">
        <SettingInput
          value={general.defaultModel}
          onChange={(value) => void patch({ general: { defaultModel: value } })}
          data-testid="input-default-model"
          aria-label="Default model"
        />
      </ConfigRow>
      <ConfigRow label="Submit with Ctrl+Enter" description="Otherwise Enter sends and Shift+Enter adds a line." testId="row-submit-ctrl-enter">
        <SettingToggle
          checked={general.submitWithCtrlEnter}
          onChange={(checked) => void patch({ general: { submitWithCtrlEnter: checked } })}
          data-testid="toggle-submit-ctrl-enter"
          aria-label="Submit with Ctrl+Enter"
        />
      </ConfigRow>
      <ConfigRow label="Always steer" description="A message typed while a turn is streaming interrupts it instead of queuing." testId="row-always-steer">
        <SettingToggle
          checked={general.alwaysSteer}
          onChange={(checked) => void patch({ general: { alwaysSteer: checked } })}
          data-testid="toggle-always-steer"
          aria-label="Always steer"
        />
      </ConfigRow>
      <ConfigRow label="Auto-title sessions" description="Name a session from its first message instead of leaving it untitled." testId="row-auto-title">
        <SettingToggle
          checked={general.autoTitleSessions}
          onChange={(checked) => void patch({ general: { autoTitleSessions: checked } })}
          data-testid="toggle-auto-title"
          aria-label="Auto-title sessions"
        />
      </ConfigRow>
      <ConfigRow label="Keep running in the tray" description="Closing the last window keeps capygen running (R2)." testId="row-close-to-tray">
        <SettingToggle
          checked={settings.closeToTray}
          onChange={(checked) => void patch({ closeToTray: checked })}
          data-testid="toggle-close-to-tray"
          aria-label="Keep running in the tray"
        />
      </ConfigRow>
      <ConfigRow label="Start with Windows" testId="row-start-with-windows">
        <SettingToggle
          checked={settings.startWithWindows}
          onChange={(checked) => void patch({ startWithWindows: checked })}
          data-testid="toggle-start-with-windows"
          aria-label="Start with Windows"
        />
      </ConfigRow>
    </div>
  );
}
