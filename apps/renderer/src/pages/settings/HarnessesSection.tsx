/**
 * Settings ▸ Harnesses (Task B2 item 2): per-backend availability + reason
 * (`harness.list`, already fetched into `appStore.harnesses` at startup —
 * SessionRunner/the composer's picker read the same list) and a "Defaults"
 * card that edits `GlobalSettings.backends.<backend>` (R30's middle layer:
 * global default → per-agent override, which stays a link-only pointer here
 * since Settings has no session context to open a real agent's drawer from).
 */
import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import type { Backend } from "@capygen/shared";
import {
  ConfigRow,
  SectionError,
  SectionIntro,
  SectionLoading,
  SettingSelect,
  SettingsCard,
} from "@/components/settings/primitives";
import { useGlobalSettings } from "@/components/settings/useGlobalSettings";
import { useAppStore } from "@/store/appStore";
import { BACKEND_LABEL } from "@/lib/agentDisplay";

const BACKENDS: Backend[] = ["claude", "codex", "api"];

const SIGN_IN_GUIDANCE: Record<Backend, string> = {
  claude: "Signed in with claude.ai OAuth. Run `claude` in a terminal once if this shows unavailable.",
  codex: "Signed in with ChatGPT OAuth. Run `codex login` in a terminal if this shows unavailable.",
  api: "No sign-in — set a key under Providers & API keys instead.",
};

const PERMISSION_MODE_OPTIONS = [
  { value: "", label: "No override (use the global default)" },
  { value: "default", label: "Default — ask before risky tools" },
  { value: "acceptEdits", label: "Accept edits — auto-approve file edits" },
  { value: "bypassPermissions", label: "Bypass permissions — never ask" },
  { value: "plan", label: "Plan — read-only, no side effects" },
];

const APPROVAL_POLICY_OPTIONS = [
  { value: "", label: "No override" },
  { value: "untrusted", label: "Untrusted — approve every command" },
  { value: "on-request", label: "On request — Codex asks when unsure" },
  { value: "on-failure", label: "On failure — only after a command fails" },
  { value: "never", label: "Never — run everything unattended" },
];

const SANDBOX_OPTIONS = [
  { value: "", label: "No override" },
  { value: "read-only", label: "Read-only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Danger — full access" },
];

const PROVIDER_OPTIONS = [
  { value: "", label: "No override" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
];

export function HarnessesSection() {
  const harnesses = useAppStore((s) => s.harnesses);
  const { settings, error, patch } = useGlobalSettings();

  return (
    <div data-testid="settings-harnesses" className="flex flex-col gap-4">
      <SectionIntro
        title="Harnesses"
        description="Availability per backend, and the global defaults every new agent on it starts from."
      />
      {BACKENDS.map((backend) => {
        const info = harnesses.find((h) => h.backend === backend);
        return (
          <HarnessCard
            key={backend}
            backend={backend}
            info={info}
            settings={settings}
            settingsError={error}
            patch={patch}
          />
        );
      })}
    </div>
  );
}

function HarnessCard({
  backend,
  info,
  settings,
  settingsError,
  patch,
}: {
  backend: Backend;
  info: ReturnType<typeof useAppStore.getState>["harnesses"][number] | undefined;
  settings: ReturnType<typeof useGlobalSettings>["settings"];
  settingsError: string | null;
  patch: ReturnType<typeof useGlobalSettings>["patch"];
}) {
  const available = info?.available ?? false;
  return (
    <SettingsCard
      testId={`harness-card-${backend}`}
      title={BACKEND_LABEL[backend]}
      subtitle={SIGN_IN_GUIDANCE[backend]}
      action={
        info === undefined ? (
          <span className="text-xs text-muted-foreground" data-testid={`harness-status-${backend}`}>
            Checking…
          </span>
        ) : available ? (
          <span
            data-testid={`harness-status-${backend}`}
            className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success"
          >
            <CheckCircle2Icon className="size-3" />
            Available
          </span>
        ) : (
          <span
            data-testid={`harness-status-${backend}`}
            className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning"
            title={info.reason}
          >
            <CircleAlertIcon className="size-3" />
            {info.reason ?? "Unavailable"}
          </span>
        )
      }
    >
      <div className="mt-1">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Defaults</p>
        {settingsError ? (
          <SectionError message={settingsError} />
        ) : !settings ? (
          <SectionLoading />
        ) : (
          <BackendDefaults backend={backend} settings={settings} patch={patch} />
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          A per-agent override wins over this default — see that agent's info drawer in its
          session.
        </p>
      </div>
    </SettingsCard>
  );
}

function BackendDefaults({
  backend,
  settings,
  patch,
}: {
  backend: Backend;
  settings: NonNullable<ReturnType<typeof useGlobalSettings>["settings"]>;
  patch: ReturnType<typeof useGlobalSettings>["patch"];
}) {
  if (backend === "claude") {
    const d = settings.backends.claude;
    return (
      <>
        <ConfigRow label="Permission mode" testId={`row-claude-permission-mode`}>
          <SettingSelect
            value={d.permissionMode ?? ""}
            onChange={(value) =>
              void patch({ backends: { claude: { permissionMode: value === "" ? undefined : (value as never) } } })
            }
            options={PERMISSION_MODE_OPTIONS}
            data-testid="select-claude-permission-mode"
            aria-label="Claude permission mode default"
          />
        </ConfigRow>
      </>
    );
  }
  if (backend === "codex") {
    const d = settings.backends.codex;
    return (
      <>
        <ConfigRow label="Approval policy" testId="row-codex-approval-policy">
          <SettingSelect
            value={d.approvalPolicy ?? ""}
            onChange={(value) =>
              void patch({ backends: { codex: { approvalPolicy: value === "" ? undefined : (value as never) } } })
            }
            options={APPROVAL_POLICY_OPTIONS}
            data-testid="select-codex-approval-policy"
            aria-label="Codex approval policy default"
          />
        </ConfigRow>
        <ConfigRow label="Sandbox" testId="row-codex-sandbox">
          <SettingSelect
            value={d.sandbox ?? ""}
            onChange={(value) =>
              void patch({ backends: { codex: { sandbox: value === "" ? undefined : (value as never) } } })
            }
            options={SANDBOX_OPTIONS}
            data-testid="select-codex-sandbox"
            aria-label="Codex sandbox default"
          />
        </ConfigRow>
      </>
    );
  }
  const d = settings.backends.api;
  return (
    <ConfigRow label="Provider" testId="row-api-provider">
      <SettingSelect
        value={d.provider ?? ""}
        onChange={(value) =>
          void patch({ backends: { api: { provider: value === "" ? undefined : (value as never) } } })
        }
        options={PROVIDER_OPTIONS}
        data-testid="select-api-provider"
        aria-label="API provider default"
      />
    </ConfigRow>
  );
}
