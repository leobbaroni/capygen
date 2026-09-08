import { useCallback, useEffect, useRef, useState } from "react";
import { newId } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

export function useComposerDictation(onText: (text: string) => void) {
  const [state, setState] = useState<"idle" | "checking" | "listening">("idle");
  const [error, setError] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [language, setLanguage] = useState("");
  const [unavailable, setUnavailable] = useState<string | null>("Checking local speech…");
  const active = useRef<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const setListening = useAppStore(s => s.setListening);

  useEffect(() => {
    let closed = false;
    void (async () => {
      try {
        const status = await ipc().invoke("dictation.availability", {});
        if (closed) return;
        setLanguages(status.languages);
        setLanguage(status.available ? status.languages[0] ?? "" : "");
        setUnavailable(status.available ? null : status.message ?? "Local Windows Speech is unavailable.");
      } catch { if (!closed) setUnavailable("Local Windows Speech is unavailable."); }
    })();
    return () => { closed = true; };
  }, []);

  const cancel = useCallback(() => {
    const requestId = active.current;
    active.current = null;
    setState("idle");
    setListening(false);
    if (requestId) void ipc().invoke("dictation.cancel", { requestId }).catch(() => undefined);
  }, [setListening]);

  useEffect(() => () => {
    const requestId = active.current;
    active.current = null;
    setListening(false);
    if (requestId) void ipc().invoke("dictation.cancel", { requestId }).catch(() => undefined);
  }, [setListening]);

  const start = useCallback(async () => {
    if (active.current) return;
    if (!language || !languages.includes(language)) { setError("Choose an installed speech language."); return; }
    const requestId = newId("request");
    active.current = requestId;
    setError(null);
    setState("checking");
    try {
      setState("listening");
      setListening(true);
      const result = await ipc().invoke("dictation.recognize", { requestId, language });
      if (active.current !== requestId || result.cancelled) return;
      if (result.error) setError(result.error);
      else if (result.text) onTextRef.current(result.text);
    } catch {
      if (active.current === requestId) setError("Local dictation could not start. Check Windows speech and microphone settings.");
    } finally {
      if (active.current === requestId) {
        active.current = null;
        setState("idle");
        setListening(false);
      }
    }
  }, [setListening, language, languages]);

  return { state, active: state !== "idle", error, start, cancel, languages, language, setLanguage, unavailable };
}
