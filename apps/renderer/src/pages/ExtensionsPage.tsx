import { useState } from "react";
import { Link } from "react-router-dom";
import { ExtensionCapabilitySchema, type ExtensionCapability } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { extensionRoute, useExtensions } from "@/shell/ExtensionNavigation";

const inputClass = "w-full rounded-md border border-border-weak bg-background px-3 py-2 outline-none focus-visible:border-ring";
const descriptions: Record<ExtensionCapability, string> = {
  theme: "Read and follow the current appearance",
  navigation: "Open registered pages, conversations and permitted links",
  "storage.user": "Store extension preferences in its own namespace",
  "sessions.read": "Read conversation titles and local working-directory paths, without messages",
  "sessions.pullRequest": "Look up the pull request for a conversation branch",
  "projects.read": "Read project names and icons",
  "projects.create": "Ask you to choose a folder and create a project",
};
export function ExtensionsPage() {
  const { items, error: listingError } = useExtensions();
  const [root, setRoot] = useState(""); const [expectedId, setId] = useState(""); const [expectedVersion, setVersion] = useState("");
  const [localDevelopment, setDevelopment] = useState(false); const [grants, setGrants] = useState<ExtensionCapability[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function action(operation: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }
  return <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-12"><div className="mx-auto max-w-3xl space-y-6">
    <header className="flex items-start justify-between gap-4"><div><h1 className="text-3xl font-normal tracking-tight">Extensions</h1><p className="mt-2 text-sm text-muted-foreground">Register a local capygen extension package with a versioned JSON manifest and bundled assets. Python plugin packages are not supported.</p></div><Button variant="outline" disabled={busy} onClick={() => void action(async () => { await ipc().invoke("extensions.refresh", {}); })}>Refresh</Button></header>
    {(error || listingError) && <p role="alert" className="text-sm text-destructive">{error || listingError}</p>}{notice && <p role="status">{notice}</p>}
    <section aria-labelledby="registered-extensions" className="space-y-3"><h2 id="registered-extensions" className="font-medium">Registered packages</h2>{items.length === 0 && <p className="text-sm text-muted-foreground">No extensions registered.</p>}{items.map((item) => <article key={item.registrationId} className="space-y-2 rounded-lg border border-border p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-medium">{item.name || item.expectedId}</h3><p className="text-xs text-muted-foreground">{item.expectedId} · {item.expectedVersion}{item.localDevelopment ? " · Local development" : ""}</p></div><Button variant="ghost" disabled={busy} onClick={() => void action(async () => { const result = await ipc().invoke("extensions.unregister", { registrationId: item.registrationId }); if (result.ok) setNotice("Registration removed. Extension storage is retained."); })}>Remove {item.name || item.expectedId}</Button></div><p className="break-all text-xs text-muted-foreground">{item.root}</p><p className="text-sm">{item.available ? "Available" : item.reason || "Unavailable"}</p><p className="text-xs text-muted-foreground">Granted: {item.grants.join(", ") || "No capabilities"}</p>{item.available && <div className="flex flex-wrap gap-3">{item.pages.map((page) => <Link key={page.id} className="text-sm underline underline-offset-2" to={extensionRoute(item.expectedId, page.id)}>{page.title}</Link>)}</div>}</article>)}</section>
    <form className="space-y-4 border-t border-border pt-5" onSubmit={(event) => { event.preventDefault(); void action(async () => { const result = await ipc().invoke("extensions.register", { root, expectedId: expectedId.trim(), expectedVersion: expectedVersion.trim(), localDevelopment, grants }); if (result.ok) setNotice("Extension registration saved. Its verified pages are listed above."); }); }}>
      <h2 className="font-medium">Register a package</h2><div className="space-y-1"><label htmlFor="extension-root" className="text-sm">Package folder</label><div className="flex gap-2"><input id="extension-root" className={inputClass} value={root} readOnly required /><Button type="button" variant="outline" disabled={busy} onClick={() => void action(async () => { const selected = await ipc().invoke("extensions.pick", {}); if (selected) setRoot(selected); })}>Choose folder</Button></div></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm">Expected package ID<input className={inputClass} required maxLength={200} value={expectedId} onChange={(event) => setId(event.target.value)} /></label><label className="space-y-1 text-sm">Expected version<input className={inputClass} required maxLength={80} value={expectedVersion} onChange={(event) => setVersion(event.target.value)} /></label></div>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={localDevelopment} onChange={(event) => setDevelopment(event.target.checked)} /><span>Local development override<span className="block text-xs text-muted-foreground">Allow version differences while retaining package identity and asset checks.</span></span></label>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Capabilities to grant</legend>{ExtensionCapabilitySchema.options.map((capability) => <label key={capability} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={grants.includes(capability)} onChange={(event) => setGrants(event.target.checked ? [...grants, capability] : grants.filter((entry) => entry !== capability))} /><span>{descriptions[capability]}<span className="block text-xs text-muted-foreground">{capability}</span></span></label>)}</fieldset><p className="text-xs text-muted-foreground">Review the exact folder, identity and requested grants in the native confirmation. Grants must also be declared by the package. No download or installation runs here.</p><Button type="submit" disabled={busy || !root || !expectedId.trim() || !expectedVersion.trim()}>{busy ? "Working…" : "Review registration"}</Button>
    </form>
  </div></main>;
}
