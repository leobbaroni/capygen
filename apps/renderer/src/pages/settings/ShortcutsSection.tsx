/**
 * Settings ▸ Keyboard shortcuts (R19, R30): `GlobalShortcuts.overrides`
 * (keybinding id → key combo), replaced whole on save — never merged
 * key-by-key — per `GlobalShortcutsPatchSchema`'s own doc comment ("there is
 * no way to express 'delete this override' inside a record that gets merged
 * key-by-key").
 *
 * capygen has no shipped keybinding registry yet (a later phase's concern);
 * this section still needs a stable list of ids to show a row per shortcut,
 * so `SHIPPED_SHORTCUTS` below names the ones the shell already implements
 * fixed key handling for (Composer.tsx, ChatPage's Escape-to-interrupt, …).
 */
import { useState } from "react";
import { SectionError, SectionIntro, SectionLoading } from "@/components/settings/primitives";
import { useGlobalSettings } from "@/components/settings/useGlobalSettings";

interface ShortcutMeta {
  id: string;
  label: string;
  defaultCombo: string;
}

export const SHIPPED_SHORTCUTS: ShortcutMeta[] = [
  { id: "composer.submit", label: "Send message", defaultCombo: "Enter" },
  { id: "composer.newline", label: "New line in composer", defaultCombo: "Shift+Enter" },
  { id: "chat.interrupt", label: "Interrupt the running turn", defaultCombo: "Escape" },
  { id: "session.new", label: "New session", defaultCombo: "Ctrl+N" },
  { id: "settings.open", label: "Open Settings", defaultCombo: "Ctrl+," },
  { id: "slashMenu.open", label: "Open the slash-command menu", defaultCombo: "/" },
];

export function ShortcutsSection() {
  const { settings, error, patch } = useGlobalSettings();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (error) return <SectionError message={error} />;
  if (!settings) return <SectionLoading />;

  const overrides = settings.shortcuts.overrides;

  function startEdit(id: string, current: string): void {
    setEditingId(id);
    setDraft(current);
  }

  async function save(id: string): Promise<void> {
    const next = { ...overrides };
    if (draft.trim() === "") delete next[id];
    else next[id] = draft.trim();
    await patch({ shortcuts: { overrides: next } });
    setEditingId(null);
  }

  async function resetOne(id: string): Promise<void> {
    const next = { ...overrides };
    delete next[id];
    await patch({ shortcuts: { overrides: next } });
  }

  return (
    <div data-testid="settings-shortcuts">
      <SectionIntro title="Keyboard shortcuts" description="Override any shipped combo; blank restores the default." />
      <div className="flex flex-col">
        {SHIPPED_SHORTCUTS.map((s) => {
          const active = overrides[s.id] ?? s.defaultCombo;
          const overridden = Boolean(overrides[s.id]);
          return (
            <div
              key={s.id}
              data-testid={`shortcut-row-${s.id}`}
              className="flex items-center justify-between gap-3 border-b border-border-weak py-2.5 last:border-b-0"
            >
              <span className="text-sm text-foreground">{s.label}</span>
              {editingId === s.id ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void save(s.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    data-testid={`shortcut-input-${s.id}`}
                    aria-label={`${s.label} key combo`}
                    className="w-40 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                  <button
                    type="button"
                    data-testid={`shortcut-save-${s.id}`}
                    onClick={() => void save(s.id)}
                    className="rounded-md border border-button-border px-2 py-1 text-xs hover:bg-accent"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid={`shortcut-combo-${s.id}`}
                  onClick={() => startEdit(s.id, active)}
                  className="flex items-center gap-2 rounded-md border border-border-weak bg-secondary px-2 py-1 font-mono text-xs text-secondary-foreground hover:bg-accent"
                >
                  {active}
                  {overridden ? (
                    <span
                      data-testid={`shortcut-reset-${s.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void resetOne(s.id);
                      }}
                      className="text-foreground-tertiary hover:text-foreground"
                      title="Reset to default"
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
