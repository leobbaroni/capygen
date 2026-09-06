/**
 * Settings ▸ Appearance (R19, R30): theme/palette/font-scale/reduced-motion,
 * applied live by `lib/theme.ts`'s `useApplyGlobalTheme` (mounted once in
 * `AppShell`) the moment this section's `settings.patch` resolves and
 * `settings.changed` broadcasts — nothing here touches the DOM directly.
 */
import { ConfigRow, SectionIntro, SectionError, SectionLoading, SettingSelect, SettingToggle } from "@/components/settings/primitives";
import { useGlobalSettings } from "@/components/settings/useGlobalSettings";

const THEME_OPTIONS = [
  { value: "system", label: "Match Windows" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The named palettes `themePalettes.generated.css` ships rules for. */
const PALETTE_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "dracula", label: "Dracula" },
  { value: "github", label: "GitHub" },
  { value: "catppuccin", label: "Catppuccin" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "nord", label: "Nord" },
  { value: "custom", label: "Custom" },
];

const FONT_SCALE_OPTIONS = [
  { value: "0.85", label: "Small (85%)" },
  { value: "1", label: "Default (100%)" },
  { value: "1.15", label: "Large (115%)" },
  { value: "1.3", label: "Extra large (130%)" },
];

export function AppearanceSection() {
  const { settings, error, patch } = useGlobalSettings();

  if (error) return <SectionError message={error} />;
  if (!settings) return <SectionLoading />;

  const { appearance } = settings;

  return (
    <div data-testid="settings-appearance">
      <SectionIntro title="Appearance" description="Theme, palette, text size and motion." />
      <ConfigRow label="Theme" description="Follows Windows' light/dark setting by default." testId="row-theme">
        <SettingSelect
          value={appearance.theme}
          onChange={(value) => void patch({ appearance: { theme: value as never } })}
          options={THEME_OPTIONS}
          data-testid="select-theme"
          aria-label="Theme"
        />
      </ConfigRow>
      <ConfigRow label="Palette" description="A named colour palette layered on top of light/dark." testId="row-palette">
        <SettingSelect
          value={appearance.palette}
          onChange={(value) => void patch({ appearance: { palette: value } })}
          options={PALETTE_OPTIONS}
          data-testid="select-palette"
          aria-label="Palette"
        />
      </ConfigRow>
      <ConfigRow label="Text size" testId="row-font-scale">
        <SettingSelect
          value={String(appearance.fontScale)}
          onChange={(value) => void patch({ appearance: { fontScale: Number(value) } })}
          options={FONT_SCALE_OPTIONS}
          data-testid="select-font-scale"
          aria-label="Text size"
        />
      </ConfigRow>
      <ConfigRow label="Reduce motion" description="Collapses animations and transitions app-wide." testId="row-reduced-motion">
        <SettingToggle
          checked={appearance.reducedMotion}
          onChange={(checked) => void patch({ appearance: { reducedMotion: checked } })}
          data-testid="toggle-reduced-motion"
          aria-label="Reduce motion"
        />
      </ConfigRow>
    </div>
  );
}
