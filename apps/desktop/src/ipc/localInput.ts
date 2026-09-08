import type { DictationService } from "../workspace/DictationService.js";
import type { TerminalService } from "../workspace/TerminalService.js";

/** Uses the existing workspace terminal registry so pane list/write/kill all share ownership. */
export function createLocalInputHandlers(deps: {
  dictation: Pick<DictationService, "availability" | "cancel" | "recognize"> & Partial<Pick<DictationService, "setup">>;
  terminals: Pick<TerminalService, "attach">;
  broadcast?: (event: "dictation.progress", payload: { requestId: string; state: "transcribing" }) => void;
}) {
  let recording: string | null = null;
  return {
    "dictation.availability": () => deps.dictation.availability(),
    "dictation.setup": () => deps.dictation.setup?.() ?? Promise.resolve({ ok: false }),
    "dictation.recognize": async ({ requestId, language }: { requestId: string; language: string }) => {
      if (recording !== null) return { text: "", error: "Dictation is already listening.", cancelled: false };
      recording = requestId;
      try { return await deps.dictation.recognize(language, () => deps.broadcast?.("dictation.progress", { requestId, state: "transcribing" })); }
      finally { if (recording === requestId) recording = null; }
    },
    "dictation.cancel": ({ requestId }: { requestId: string }) => {
      // An old composer unmount cannot cancel a newer composer's capture.
      return requestId === recording ? deps.dictation.cancel() : { ok: false };
    },
    "terminal.attach": (args: Parameters<TerminalService["attach"]>[0]) => deps.terminals.attach(args),
  };
}
