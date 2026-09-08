import { useCallback, useEffect, useRef, useState } from "react";
import { newId } from "@capygen/shared";
import { hasBridge, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

export function useComposerDictation(onText: (text: string) => void) {
  const [state, setState] = useState<"idle" | "checking" | "listening" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [language, setLanguage] = useState("");
  const [unavailable, setUnavailable] = useState<string | null>("Checking local speech…");
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const availabilityGeneration = useRef(0);
  const active = useRef<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const setListening = useAppStore(s => s.setListening);

  const refresh = useCallback(async () => {
    const generation = ++availabilityGeneration.current;
      try {
        const status = await ipc().invoke("dictation.availability", {});
        if (generation !== availabilityGeneration.current) return;
        setLanguages(status.languages);
        setLanguage(status.available ? status.languages[0] ?? "" : "");
        setSetupAvailable(status.setupAvailable === true);
        setUnavailable(status.available ? null : status.message ?? "Local Windows Speech is unavailable.");
      } catch { if (generation === availabilityGeneration.current) setUnavailable("Local speech is unavailable."); }
  }, []);
  useEffect(() => {
    void refresh();
    if (!hasBridge()) return () => { availabilityGeneration.current++; };
    const unsubscribe = ipc().on("dictation.progress", payload => {
      if (payload.state === "transcribing" && payload.requestId === active.current) {
        setState("transcribing");
        setListening(false);
      }
    });
    return () => { availabilityGeneration.current++; unsubscribe(); };
  }, [refresh, setListening]);

  const setup = useCallback(async () => {
    setSettingUp(true); setError(null);
    try { await ipc().invoke("dictation.setup", {}); }
    catch { setError("Could not open local speech setup. Try again."); }
    finally { setSettingUp(false); }
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

  return { state, active: state !== "idle", error, start, cancel, languages, language, setLanguage, unavailable, setupAvailable, settingUp, setup, refresh };
}
