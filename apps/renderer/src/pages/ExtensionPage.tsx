import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ipc } from "@/lib/ipc";

export function ExtensionPage() {
  const { extensionId, pageId } = useParams();
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => {
    const element = mount.current;
    if (!element || !extensionId || !pageId) return;
    let disposed = false; let instanceId: string | null = null; let frame = 0;
    setError(""); setLoading(true);
    function bounds() {
      const rect = element!.getBoundingClientRect();
      const x = Math.min(32000, Math.max(0, Math.round(rect.left))); const y = Math.min(32000, Math.max(0, Math.round(rect.top)));
      return { x, y, width: Math.min(16000, Math.max(1, Math.round(Math.min(rect.right, window.innerWidth) - x))), height: Math.min(16000, Math.max(1, Math.round(Math.min(rect.bottom, window.innerHeight) - y))) };
    }
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !instanceId) return;
        void ipc().invoke("extensions.bounds", { instanceId, bounds: bounds() }).catch((reason) => { if (!disposed) setError(String(reason)); });
      });
    }
    const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    void ipc().invoke("extensions.open", { extensionId, pageId, bounds: bounds() }).then((opened) => {
      if (disposed) { void ipc().invoke("extensions.close", { instanceId: opened.instanceId }).catch(() => {}); return; }
      instanceId = opened.instanceId; setLoading(false); update();
    }).catch((reason) => { if (!disposed) { setError(String(reason)); setLoading(false); } });
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true);
      if (instanceId) void ipc().invoke("extensions.close", { instanceId }).catch(() => {});
    };
  }, [extensionId, pageId]);
  return <main className="flex min-h-0 flex-1 flex-col pt-10"><header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3"><div><h1 className="text-sm font-medium">{pageId}</h1><p className="text-xs text-muted-foreground">Local extension · {extensionId}</p></div><Link to="/extensions" className="text-sm underline underline-offset-2">Close extension</Link></header>{error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">{error}</p>}<div ref={mount} data-testid="extension-native-view" className="relative min-h-0 flex-1">{loading && <p role="status" className="p-4 text-sm text-muted-foreground">Opening extension…</p>}</div></main>;
}
