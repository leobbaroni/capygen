import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { InboxItem } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";

export function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => ipc().on("inbox.changed", () => { generation.current++; setRevision((value) => value + 1); }), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const requestGeneration = generation.current;
    void ipc().invoke("inbox.list", { unreadOnly: true, limit: 50 }).then((result) => {
      if (alive && requestGeneration === generation.current) { setItems(result.items); setHasMore(result.items.length === 50); setError(""); }
    }).catch((err: unknown) => { if (alive) setError(String(err)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; generation.current++; };
  }, [revision]);
  async function more() {
    const currentGeneration = generation.current;
    const last = items.at(-1);
    if (!last) return;
    try {
      const result = await ipc().invoke("inbox.list", { unreadOnly: true, limit: 50, before: { createdAt: last.createdAt, id: last.id } });
      if (currentGeneration !== generation.current) return;
      setItems((current) => [...current, ...result.items.filter((row) => !current.some((item) => item.id === row.id))]);
      setHasMore(result.items.length === 50);
    } catch (err) { setError(String(err)); }
  }
  async function read(item: InboxItem) {
    try { await ipc().invoke("inbox.markRead", { id: item.id, read: true }); generation.current++; setItems((current) => current.filter((row) => row.id !== item.id)); setRevision((value) => value + 1); }
    catch (err) { setError(String(err)); }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-12" data-testid="inbox-page"><div className="mx-auto max-w-4xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Inbox</h1><p className="mt-1 text-sm text-muted-foreground">Unread requests, completed turns, and errors.</p></div><Button variant="outline" onClick={async () => { try { await ipc().invoke("inbox.markAllRead", {}); generation.current++; setItems([]); setHasMore(false); setRevision((value) => value + 1); } catch (err) { setError(String(err)); } }}>Mark all read</Button></header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading inbox…</p> : items.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">You’re all caught up.</p> : <div className="divide-y divide-border rounded-lg border border-border">{items.map((item) => <article key={item.id} className="flex gap-3 p-4">
      <span className={`mt-2 size-2 shrink-0 rounded-full ${item.readAt === null ? "bg-primary" : "bg-transparent"}`} aria-label={item.readAt === null ? "Unread" : "Read"} />
      <div className="min-w-0 flex-1"><div className="flex flex-wrap justify-between gap-2"><h2 className="text-sm font-medium">{item.title}</h2><time className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</time></div><p className="mt-1 break-words text-sm text-muted-foreground">{item.body}</p>
      {item.requestId && <p className="mt-1 text-xs text-muted-foreground">{item.resolvedAt === null ? "Waiting for input" : "Request closed"}</p>}
      <Link className="mt-3 inline-block text-sm text-primary hover:underline" onClick={() => void read(item)} to={`/c/${item.sessionId}?turn=${encodeURIComponent(item.turnId)}${item.targetBlockId ? `&block=${encodeURIComponent(item.targetBlockId)}` : ""}`}>{item.requestId && item.resolvedAt === null ? "Review request" : "Open session"}</Link></div>
      {item.readAt === null && <Button variant="ghost" size="sm" onClick={() => void read(item)}>Mark read</Button>}
    </article>)}</div>}
    {hasMore && <Button variant="outline" onClick={() => void more()}>Load older items</Button>}
  </div></div>;
}
