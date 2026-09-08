import { useEffect, useRef, useState } from "react";
import { canonicalCustomModeJson, CustomModeDocumentSchema, parseCustomModeJsonText, validateCrewAvailability,
  CrewTaskKindSchema, CrewDifficultySchema, type CustomModeDocument, type CrewMember, type CrewRoutingRule, type HarnessInfo } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

const field = "w-full rounded-md border border-border-weak bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring";
function Field({ label, value, onChange, multiline = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean }) {
  return <label className="block space-y-1 text-xs text-muted-foreground"><span>{label}</span>{multiline
    ? <textarea aria-label={label} className={field} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
    : <input aria-label={label} className={field} value={value} onChange={(event) => onChange(event.target.value)} />}</label>;
}
function Pick({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="block space-y-1 text-xs text-muted-foreground"><span>{label}</span><select aria-label={label} className={field} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option>{[...new Set([...options, ...(value ? [value] : [])])].map((option) => <option key={option} value={option}>{option}{!options.includes(option) ? " (unavailable)" : ""}</option>)}</select></label>;
}
function Checks({ label, values, options, onChange }: { label: string; values: string[]; options: string[]; onChange: (value: string[]) => void }) {
  return <fieldset className="space-y-1"><legend className="text-xs text-muted-foreground">{label}</legend><div className="flex flex-wrap gap-3">{options.map((option) => <label key={option} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={values.includes(option)} onChange={(event) => onChange(event.target.checked ? [...values, option] : values.filter((value) => value !== option))} />{option}</label>)}</div></fieldset>;
}

export function CustomModeEditor({ sessionId, onApplied }: { sessionId: string; onApplied?: () => void }) {
  const [catalogue, setCatalogue] = useState<HarnessInfo[]>([]);
  const [document, setDocument] = useState<CustomModeDocument | null>(null);
  const [text, setText] = useState("");
  const [view, setView] = useState<"visual" | "json">("visual");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [preview, setPreview] = useState(false);
  const [oldRoster, setOldRoster] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [generator, setGenerator] = useState("");
  const [generating, setGenerating] = useState(false);
  const generation = useRef<string | null>(null);
  const generators = catalogue.filter((row) => row.available && row.backend !== "codex")
    .flatMap((row) => row.models.flatMap((model) => (model.efforts ?? []).flatMap((effort) =>
      (row.backend === "api" ? model.providers ?? [] : [undefined]).map((provider) => ({
        backend: row.backend, model: model.id, effort, ...(provider ? { provider } : {}),
      })))));
  useEffect(() => () => {
    const requestId = generation.current;
    generation.current = null;
    if (requestId) void ipc().invoke("customMode.cancel", { requestId }).catch(() => {});
  }, [sessionId]);
  async function generate() {
    const target = generators.find((candidate) => JSON.stringify(candidate) === generator) ?? generators[0];
    if (!target || !prompt.trim() || generation.current) return;
    const requestId = crypto.randomUUID();
    generation.current = requestId; setGenerating(true); setError("");
    try {
      const result = await ipc().invoke("customMode.generate", { requestId, sessionId, target, prompt });
      if (generation.current !== requestId) return;
      setText(result.draft); setView("json"); setPreview(false);
      const draft = parseCustomModeJsonText(result.draft);
      setDocument(draft.ok ? draft.document : null);
      setError(result.issues.map((issue) => issue.message).join("; "));
      setNotice("Draft returned for review. Usage is saved in a separate archived session.");
    } catch (reason) { if (generation.current === requestId) setError(String(reason)); }
    finally { if (generation.current === requestId) { generation.current = null; setGenerating(false); } }
  }
  const capabilities = catalogue.filter((row) => row.available).flatMap((row) => row.models.map((model) => ({ backend: row.backend, model: model.id, efforts: model.efforts, providers: model.providers })));
  const parsed = parseCustomModeJsonText(text);
  const issues = parsed.ok ? validateCrewAvailability(parsed.document, capabilities) : parsed.issues;
  function edit(next: CustomModeDocument) { setDocument(next); setText(JSON.stringify(next, null, 2)); setPreview(false); setNotice(""); }
  useEffect(() => {
    let disposed = false;
    setBusy(true); setGenerating(false); setError(""); setPreview(false); setDocument(null); setText("");
    void Promise.all([ipc().invoke("customMode.capabilities", {}), ipc().invoke("sessions.get", { sessionId })]).then(([rows, current]) => {
      if (disposed) return;
      if (!current) throw new Error("This session no longer exists.");
      setCatalogue(rows); setOldRoster(current.agents.map((agent) => `${agent.displayName} · ${agent.backend}/${agent.model}`));
      if (current.session.settings.crew) { edit(current.session.settings.crew); return; }
      const available = rows.filter((row) => row.available).flatMap((row) => row.models.filter((model) => model.efforts?.length && (row.backend !== "api" || model.providers?.length)).map((model) => ({ row, model })))[0];
      if (!available) { setView("json"); setError("No available model with effort information. Configure a harness, or compose a JSON draft and reopen when it is available."); return; }
      const target = { backend: available.row.backend, model: available.model.id, effort: available.model.efforts![0]!, ...(available.row.backend === "api" ? { provider: available.model.providers![0]! } : {}) };
      edit(CustomModeDocumentSchema.parse({ version: 1, title: "My crew", roster: [{ id: "lead", label: "Lead", role: "lead", target }, { id: "worker", label: "Worker", role: "worker", target }], defaultWorker: "worker" }));
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [sessionId]);
  function switchView(next: "visual" | "json") {
    if (next === "visual") {
      try { const shaped = CustomModeDocumentSchema.safeParse(JSON.parse(text)); if (!shaped.success) throw new Error("Fix the JSON field structure before opening the visual editor."); setDocument(shaped.data); }
      catch (reason) { setError(String(reason)); return; }
    }
    setError(""); setView(next);
  }
  function member(index: number, patch: Partial<CrewMember>) { if (document) edit({ ...document, roster: document.roster.map((entry, at) => at === index ? { ...entry, ...patch } : entry) }); }
  function rule(index: number, patch: Partial<CrewRoutingRule>) { if (document) edit({ ...document, routing: document.routing.map((entry, at) => at === index ? { ...entry, ...patch } : entry) }); }
  async function apply() {
    if (!parsed.ok || issues.length) return;
    setBusy(true); setError("");
    try { const result = await ipc().invoke("customMode.apply", { sessionId, crew: parsed.document });
      if (result.restartError) { setError(`Crew saved, but its runtime could not restart: ${result.restartError}. Apply again to retry.`); }
      else { setNotice("Crew applied."); setPreview(false); onApplied?.(); }
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  return <section aria-label="Custom mode editor" className="space-y-5 text-sm">
    <header><h2 className="text-lg font-medium">Custom crew</h2><p className="text-muted-foreground">Choose who leads, who does delegated work, and when members debate a decision.</p></header>
    <div className="space-y-3 rounded-lg border border-border p-3">
      <Field label="Describe your custom mode" value={prompt} multiline onChange={setPrompt} />
      <label className="block text-xs text-muted-foreground">Draft generator
        <select aria-label="Draft generator" className={field} disabled={generating || busy} value={generator || (generators[0] ? JSON.stringify(generators[0]) : "")} onChange={(event) => setGenerator(event.target.value)}>
          {!generators.length && <option value="">No supported generator available</option>}
          {generators.map((target) => <option key={JSON.stringify(target)} value={JSON.stringify(target)}>{target.backend} · {target.model} · {target.effort}{target.provider ? ` · ${target.provider}` : ""}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Generation creates a billed draft for review. Codex generation is unavailable until no-tool isolation is verified.</p>
      {generating ? <Button variant="outline" onClick={() => {
        const requestId = generation.current; generation.current = null; setGenerating(false);
        if (requestId) void ipc().invoke("customMode.cancel", { requestId }).catch(() => {});
      }}>Cancel generation</Button> : <Button disabled={busy || !prompt.trim() || prompt.length > 8192 || !generators.length} onClick={() => void generate()}>Generate draft</Button>}
    </div>
    <fieldset disabled={busy || generating} className="space-y-5">
    <div className="flex gap-2"><Button variant={view === "visual" ? "secondary" : "ghost"} onClick={() => switchView("visual")} disabled={busy}>Visual</Button><Button variant={view === "json" ? "secondary" : "ghost"} onClick={() => switchView("json")} disabled={busy}>JSON</Button></div>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
    {busy && !document ? <p role="status">Loading crew…</p> : view === "json" ? <Field label="Crew JSON" value={text} multiline onChange={(value) => { setText(value); setPreview(false); setNotice(""); }} /> : document && <div className="space-y-5">
      <Field label="Crew title" value={document.title} onChange={(title) => edit({ ...document, title })} /><Field label="Description" value={document.description} multiline onChange={(description) => edit({ ...document, description })} />
      <fieldset className="space-y-3"><legend className="mb-2 font-medium">Roster</legend>{document.roster.map((entry, index) => {
        const models = catalogue.find((row) => row.backend === entry.target.backend && row.available)?.models ?? [];
        const model = models.find((candidate) => candidate.id === entry.target.model);
        return <article key={index} className="space-y-3 rounded-lg border border-border p-3"><div className="flex items-center justify-between"><h3 className="font-medium">{entry.label || `Person ${index + 1}`}</h3><Button variant="ghost" onClick={() => edit({ ...document, roster: document.roster.filter((_, at) => at !== index) })}>Remove person {index + 1}</Button></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={`Person ${index + 1} ID`} value={entry.id} onChange={(id) => member(index, { id })} /><Field label={`Person ${index + 1} name`} value={entry.label} onChange={(label) => member(index, { label })} />
          <Pick label={`Person ${index + 1} role`} value={entry.role} options={["lead", "member", "worker"]} onChange={(role) => member(index, { role: role as CrewMember["role"] })} /><Field label={`Person ${index + 1} role label`} value={entry.roleLabel ?? ""} onChange={(roleLabel) => member(index, { roleLabel: roleLabel || undefined })} />
          <Pick label={`Person ${index + 1} backend`} value={entry.target.backend} options={catalogue.filter((row) => row.available).map((row) => row.backend)} onChange={(backend) => member(index, { target: { backend: backend as CrewMember["target"]["backend"], model: "", effort: "" } })} />
          <Pick label={`Person ${index + 1} model`} value={entry.target.model} options={models.map((model) => model.id)} onChange={(model) => member(index, { target: { ...entry.target, model, effort: "", provider: undefined } })} />
          <Pick label={`Person ${index + 1} effort`} value={entry.target.effort} options={model?.efforts ?? []} onChange={(effort) => member(index, { target: { ...entry.target, effort } })} />
          {entry.target.backend === "api" && <Pick label={`Person ${index + 1} provider`} value={entry.target.provider ?? ""} options={model?.providers ?? []} onChange={(provider) => member(index, { target: { ...entry.target, provider: provider as CrewMember["target"]["provider"] } })} />}
        </div><Field label={`Person ${index + 1} instructions`} value={entry.instructions} multiline onChange={(instructions) => member(index, { instructions })} /></article>;
      })}<Button variant="outline" disabled={document.roster.length >= 16} onClick={() => { const fallback = capabilities.find((candidate) => candidate.efforts?.length && (candidate.backend !== "api" || candidate.providers?.length)); const target = document.roster[0]?.target ?? (fallback ? { backend: fallback.backend, model: fallback.model, effort: fallback.efforts![0]!, ...(fallback.backend === "api" ? { provider: fallback.providers![0] } : {}) } : undefined); if (target) edit({ ...document, roster: [...document.roster, { id: `person-${Date.now()}`, label: "New person", role: "member", instructions: "", target: { ...target } }] }); }}>Add person</Button></fieldset>
      <fieldset className="space-y-3"><legend className="font-medium">Delegation rules</legend><p className="text-xs text-muted-foreground">First matching rule wins. An unchecked group matches any task or difficulty.</p>{document.routing.map((entry, index) => <article key={index} className="space-y-3 rounded-lg border border-border p-3"><div className="flex flex-wrap items-center gap-2"><span>Rule {index + 1}</span><Button variant="ghost" disabled={index === 0} onClick={() => { const routing = [...document.routing]; [routing[index - 1], routing[index]] = [routing[index]!, routing[index - 1]!]; edit({ ...document, routing }); }}>Move rule {index + 1} up</Button><Button variant="ghost" disabled={index === document.routing.length - 1} onClick={() => { const routing = [...document.routing]; [routing[index], routing[index + 1]] = [routing[index + 1]!, routing[index]!]; edit({ ...document, routing }); }}>Move rule {index + 1} down</Button><Button variant="ghost" onClick={() => edit({ ...document, routing: document.routing.filter((_, at) => at !== index) })}>Remove rule {index + 1}</Button></div>
        <Field label={`Rule ${index + 1} ID`} value={entry.id} onChange={(id) => rule(index, { id })} /><Checks label="Task kinds" options={CrewTaskKindSchema.options} values={entry.taskKinds ?? []} onChange={(values) => rule(index, { taskKinds: values.length ? values as CrewRoutingRule["taskKinds"] : undefined })} /><Checks label="Difficulties" options={CrewDifficultySchema.options} values={entry.difficulties ?? []} onChange={(values) => rule(index, { difficulties: values.length ? values as CrewRoutingRule["difficulties"] : undefined })} /><Pick label={`Rule ${index + 1} worker`} value={entry.target} options={document.roster.filter((person) => person.role === "worker").map((person) => person.id)} onChange={(target) => rule(index, { target })} />
      </article>)}<Button variant="outline" disabled={document.routing.length >= 64} onClick={() => edit({ ...document, routing: [...document.routing, { id: `rule-${Date.now()}`, target: document.defaultWorker }] })}>Add rule</Button><Pick label="Default worker" value={document.defaultWorker} options={document.roster.filter((person) => person.role === "worker").map((person) => person.id)} onChange={(defaultWorker) => edit({ ...document, defaultWorker })} /></fieldset>
      <fieldset className="space-y-3"><legend className="font-medium">Decision debate</legend><label className="flex items-center gap-2"><input type="checkbox" checked={document.debate.enabled} onChange={(event) => edit({ ...document, debate: { ...document.debate, enabled: event.target.checked } })} />Enable debate</label><Checks label="Decision triggers" options={["core", "major"]} values={document.debate.triggers} onChange={(triggers) => edit({ ...document, debate: { ...document.debate, triggers: triggers as CustomModeDocument["debate"]["triggers"] } })} /><Checks label="Debating members" options={document.roster.filter((person) => person.role === "member").map((person) => person.id)} values={document.debate.participants} onChange={(participants) => edit({ ...document, debate: { ...document.debate, participants } })} /><ol className="space-y-1">{document.debate.participants.map((id, index) => <li key={id} className="flex items-center gap-2"><span>{index + 1}. {id}</span><Button variant="ghost" disabled={index === 0} onClick={() => { const participants = [...document.debate.participants]; [participants[index - 1], participants[index]] = [participants[index]!, participants[index - 1]!]; edit({ ...document, debate: { ...document.debate, participants } }); }}>Move debater {index + 1} up</Button></li>)}</ol><p className="text-xs text-muted-foreground">Debaters speak in this order, then the lead decides. The session hop limit always applies.</p></fieldset>
    </div>}
    {text && issues.length > 0 && <ul aria-label="Crew validation errors" className="space-y-1 text-xs text-destructive">{issues.map((issue, index) => <li key={index}>{issue.path || "Document"}: {issue.message}</li>)}</ul>}
    <Button variant="outline" disabled={busy || !parsed.ok || issues.length > 0} onClick={() => setPreview(true)}>Review changes</Button>
    {preview && parsed.ok && <section aria-label="Crew apply preview" className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">Review before applying</h3><p>This replaces the current active roster and restarts its harnesses. Previous agents and conversation history remain saved. New agents receive no inherited permissions or native session identities.</p><p className="text-xs text-muted-foreground">Current roster: {oldRoster.join(", ") || "Empty"}. New chat roster: {parsed.document.roster.filter((person) => person.role !== "worker").map((person) => `${person.label} (${person.target.backend}/${person.target.model})`).join(", ")}. Workers run only when delegated.</p><pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{canonicalCustomModeJson(parsed.document)}</pre><Button disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply crew"}</Button></section>}
    </fieldset>
  </section>;
}
