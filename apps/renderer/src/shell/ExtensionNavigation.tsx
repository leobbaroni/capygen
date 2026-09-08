import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { hasBridge, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";
import { cn } from "@/lib/utils";

export interface ExtensionListItem {
  registrationId: string; root: string; expectedId: string; expectedVersion: string;
  localDevelopment: boolean; grants: string[]; available: boolean; reason: string | null;
  name: string; pages: { id: string; title: string }[]; navigation: { id: string; pageId: string; label: string }[];
}
export function extensionRoute(extensionId: string, pageId: string) { return `/extensions/page/${encodeURIComponent(extensionId)}/${encodeURIComponent(pageId)}`; }
export function useExtensions() {
  const [items, setItems] = useState<ExtensionListItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!hasBridge()) return;
    let disposed = false; let generation = 0;
    async function refresh() {
      const own = ++generation;
      try {
        const result: ExtensionListItem[] = []; const seen = new Set<number>(); let offset = 0;
        for (let page = 0; page < 64; page++) {
          if (seen.has(offset)) throw new Error("Extension listing repeated a page."); seen.add(offset);
          const batch = await ipc().invoke("extensions.list", { offset });
          result.push(...batch.items);
          if (result.length > 64) throw new Error("Extension listing exceeded its limit.");
          if (batch.nextOffset === null) break;
          if (page === 63) throw new Error("Extension listing did not finish.");
          offset = batch.nextOffset;
        }
        if (!disposed && own === generation) { setItems(result); setError(""); }
      } catch (reason) { if (!disposed && own === generation) { setError(String(reason)); setItems([]); } }
    }
    const off = ipc().on("extensions.changed", () => { void refresh(); });
    void refresh(); return () => { disposed = true; off(); };
  }, []);
  return { items, error };
}
export function ExtensionNavigation() {
  const { items, error } = useExtensions();
  return <nav aria-label="Extensions" className="space-y-1"><NavLink to="/extensions" className={({ isActive }) => cn("block rounded-md px-2 py-1.5 text-xs hover:bg-muted", isActive ? "bg-muted text-foreground" : "text-muted-foreground")}>Extensions</NavLink>{items.filter((item) => item.available).flatMap((item) => item.navigation.map((entry) => <NavLink key={entry.id} to={extensionRoute(item.expectedId, entry.pageId)} className={({ isActive }) => cn("block truncate rounded-md px-2 py-1.5 text-xs hover:bg-muted", isActive ? "bg-muted text-foreground" : "text-muted-foreground")}>{entry.label}</NavLink>))}{error && <p className="px-2 text-xs text-muted-foreground">Extension navigation is unavailable.</p>}</nav>;
}
/** Main emits only app routes; extension messages never reach this listener directly. */
export function ExtensionNavigationEvents() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!hasBridge()) return;
    let disposed = false;
    async function refreshProjects() {
      const projects = await ipc().invoke("projects.list", {});
      if (!disposed) useAppStore.setState({ projects });
      return projects;
    }
    const offChange = ipc().on("extensions.changed", () => { void refreshProjects().catch(() => {}); });
    const offNavigation = ipc().on("extensions.navigate", ({ route }) => {
      if (route.startsWith("/?")) {
        const url = new URL(route, "https://capygen.invalid");
        if (url.pathname !== "/" || url.hash || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has("projectId")) return;
        const projectId = url.searchParams.get("projectId")!;
        void (async () => {
          const projects = useAppStore.getState().projects.some((project) => project.id === projectId)
            ? useAppStore.getState().projects : await refreshProjects();
          if (!disposed && projects.some((project) => project.id === projectId)) { useAppStore.getState().selectProject(projectId); navigate("/"); }
        })().catch(() => {});
      } else if (route === "/" || /^\/c\/[^/?#]+$/.test(route) || /^\/extensions\/page\/[^/?#]+\/[^/?#]+(?:\?[^#]*)?$/.test(route)) navigate(route);
    });
    return () => { disposed = true; offChange(); offNavigation(); };
  }, [navigate]);
  useEffect(() => {
    if (!hasBridge()) return;
    const names = ["background", "foreground", "card", "card-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "border", "input", "ring", "destructive"];
    let disposed = false; let frame = 0;
    function publish() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const root = document.documentElement; const style = getComputedStyle(root);
        const tokens = Object.fromEntries(names.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]));
        tokens.mode = root.classList.contains("dark") || root.getAttribute("data-theme") === "dark" ? "dark" : "light";
        void ipc().invoke("extensions.theme", { tokens }).catch(() => {});
      });
    }
    const observer = new MutationObserver(publish);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    publish(); return () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return null;
}
