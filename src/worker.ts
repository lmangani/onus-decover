import { anonymize, type ProgressUpdate } from "./audio/pipeline";
import { demucsCapability } from "./capabilities";
import type { Settings } from "./presets";

const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<StartMessage | AbortMessage>) => void): void;
};

interface StartMessage {
  id: number;
  task: "anonymize";
  fileName: string;
  fileBuffer: ArrayBuffer;
  presetId: string;
  settings: Record<string, unknown>;
}

interface AbortMessage {
  id: number;
  command: "abort";
}

let activeId = 0;
let controller: AbortController | null = null;
const workerCanRender = typeof OfflineAudioContext === "function";

function post(message: unknown, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

scope.addEventListener("message", (event) => {
  const data = event.data;
  if ("command" in data && data.command === "abort") {
    if (data.id === activeId) controller?.abort();
    post({ id: data.id, type: "aborted" });
    return;
  }
  if (!("task" in data) || data.task !== "anonymize") {
    post({ id: data.id, type: "error", error: { message: "Unknown task.", name: "Error" } });
    return;
  }
  if (!workerCanRender) {
    post({ id: data.id, type: "fallback-main" });
    return;
  }
  activeId = data.id;
  controller = new AbortController();
  const signal = controller.signal;
  void anonymize({
    fileName: data.fileName,
    bytes: data.fileBuffer,
    presetId: data.presetId,
    settings: data.settings as Partial<Settings>,
    signal,
    demucs: demucsCapability(),
    onProgress: (progress: ProgressUpdate) => {
      post({ id: data.id, type: "progress", progress });
    },
  })
    .then((result) => {
      if (signal.aborted) return;
      const wav = result.wav;
      post(
        {
          id: data.id,
          type: "complete",
          name: result.fileName,
          wav,
          notes: result.notes,
          log: result.log,
        },
        [wav],
      );
    })
    .catch((error: unknown) => {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        post({ id: data.id, type: "aborted" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : "Error";
      post({ id: data.id, type: "error", error: { message, name } });
    })
    .finally(() => {
      if (activeId === data.id) {
        activeId = 0;
        controller = null;
      }
    });
});
