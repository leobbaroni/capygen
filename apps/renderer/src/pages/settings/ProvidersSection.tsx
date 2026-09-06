/**
 * Settings ▸ API keys (SPEC item 5, part of R21/R30): one row per API
 * provider an `api`-backend agent can talk to directly (`ApiProviderSchema`
 * in `@capygen/shared`). A key is written through `secrets.set`
 * (Electron `safeStorage`, R21) and never read back — this page only ever
 * learns *whether* one is stored (`secrets.has`), never its value, so the
 * masked input really is write-only, not just visually masked.
 */
import { CheckCircle2Icon, CircleIcon, KeyIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiProvider } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

const PROVIDERS: { id: ApiProvider; label: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic", hint: "Claude models via the Messages API" },
  { id: "openai", label: "OpenAI", hint: "GPT models via the Responses API" },
  { id: "openrouter", label: "OpenRouter", hint: "Any OpenRouter-hosted model" },
];

/**
 * `stored` is a key in safeStorage; `environment` is the documented env var
 * (`ANTHROPIC_API_KEY` & co.), which `harness.list` counts as a key too. The
 * page used to probe only the store, so an env-supplied key rendered as
 * "Not set" here while the composer's picker happily offered that provider's
 * models — two surfaces disagreeing about the same fact.
 */
type KeySource = "stored" | "environment" | "none";
type HasState = "loading" | KeySource;

const ENV_VAR: Record<ApiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function ProvidersSection() {
  const [has, setHas] = useState<Record<ApiProvider, HasState>>({
    anthropic: "loading",
    openai: "loading",
    openrouter: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      PROVIDERS.map(async ({ id }) => {
        // A probe failing — no bridge, a main-process error, `ipc()` itself
        // throwing synchronously when the bridge is missing entirely — reads
        // as "no key stored" rather than leaving the row spinning forever.
        try {
          const result = await ipc().invoke("secrets.has", { provider: id });
          return [id, result.source] as const;
        } catch {
          return [id, "none"] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setHas(Object.fromEntries(entries) as Record<ApiProvider, HasState>);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh(provider: ApiProvider): Promise<void> {
    const result = await ipc().invoke("secrets.has", { provider });
    setHas((prev) => ({ ...prev, [provider]: result.source }));
  }

  return (
    <div className="flex max-w-xl flex-col gap-3" data-testid="providers-section">
      <p className="text-sm text-muted-foreground">
        Keys are stored with Windows DPAPI (Electron <code className="font-mono">safeStorage</code>)
        and never written to a settings file or a log — once set, a key cannot be shown again,
        only replaced or removed.
      </p>
      {PROVIDERS.map((provider) => (
        <ProviderRow key={provider.id} {...provider} state={has[provider.id]} onChanged={refresh} />
      ))}
    </div>
  );
}

function ProviderRow({
  id,
  label,
  hint,
  state,
  onChanged,
}: {
  id: ApiProvider;
  label: string;
  hint: string;
  state: HasState;
  onChanged: (provider: ApiProvider) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (value.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await ipc().invoke("secrets.set", { provider: id, value: value.trim() });
      setValue("");
      setEditing(false);
      await onChanged(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ipc().invoke("secrets.delete", { provider: id });
      await onChanged(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border-weak bg-card px-3.5 py-3"
      data-testid={`provider-row-${id}`}
    >
      <div className="flex items-center gap-2.5">
        <KeyIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <StatusBadge state={state} envVar={ENV_VAR[id]} />
      </div>

      {editing ? (
        <div className="flex items-center gap-1.5 pl-6">
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setEditing(false);
                setValue("");
              }
            }}
            placeholder={`${label} API key`}
            aria-label={`${label} API key`}
            data-testid={`provider-${id}-input`}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
          />
          <Button
            size="sm"
            disabled={busy || value.trim() === ""}
            data-testid={`provider-${id}-save`}
            onClick={() => void save()}
          >
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setValue("");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pl-6">
          <Button
            size="sm"
            variant="outline"
            data-testid={`provider-${id}-set`}
            onClick={() => setEditing(true)}
          >
            {state === "stored" ? "Replace key" : "Set key"}
          </Button>
          {state === "stored" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid={`provider-${id}-remove`}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="pl-6 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StatusBadge({ state, envVar }: { state: HasState; envVar: string }) {
  if (state === "loading") {
    return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (state === "environment") {
    return (
      <span
        data-testid="provider-status-env"
        className="flex shrink-0 items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-xs text-info"
        title="capygen reads this key from the environment; setting one here overrides it."
      >
        <CheckCircle2Icon className="size-3" />
        From {envVar}
      </span>
    );
  }
  return state === "stored" ? (
    <span
      data-testid="provider-status-set"
      className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success"
    >
      <CheckCircle2Icon className="size-3" />
      Key set
    </span>
  ) : (
    <span
      data-testid="provider-status-unset"
      className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
    >
      <CircleIcon className="size-3" />
      Not set
    </span>
  );
}
