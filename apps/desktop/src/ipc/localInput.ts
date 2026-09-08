import type { DictationService } from "../workspace/DictationService.js";
import type { TerminalService } from "../workspace/TerminalService.js";

/** Uses the existing workspace terminal registry so pane list/write/kill all share ownership. */
export function createLocalInputHandlers(deps: {
  dictation: Pick<DictationService, "availability" | "recognize" | "cancel">;
  terminals: Pick<TerminalService, "attach">;
}) {
  let recording: string | null = null;
  return {
    "dictation.availability": () => deps.dictation.availability(),
    "dictation.recognize": async ({ requestId, language }: { requestId: string; language: string }) => {
      if (recording !== null) return { text: "", error: "Dictation is already listening.", cancelled: false };
      recording = requestId;
      try { return await deps.dictation.recognize(language); }
      finally { if (recording === requestId) recording = null; }
    },
    "dictation.cancel": ({ requestId }: { requestId: string }) => {
      // An old composer unmount cannot cancel a newer composer's capture.
      return requestId === recording ? deps.dictation.cancel() : { ok: false };
    },
    "terminal.attach": (args: Parameters<TerminalService["attach"]>[0]) => deps.terminals.attach(args),
  };
}
