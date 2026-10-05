import { demucsCapability } from "./capabilities";
import {
  ACCEPTED_EXTENSIONS,
  CONTROL_GROUPS,
  MAX_FILE_BYTES,
  PRESET_COPY,
  SPEED_UP_DEFAULT,
  SPEED_UP_PERCENTS,
  WARN_FILE_BYTES,
  presetSettings,
  type Control,
  type NumberControl,
  type PresetId,
  type Settings,
} from "./presets";
import { stripMetadata } from "./audio/metadata";
import { anonymize, type ProgressUpdate } from "./audio/pipeline";
import "./style.css";

const PRESETS: PresetId[] = ["subtle", "moderate", "aggressive", "instrumental", "speedup"];
const PRESET_LABELS: Record<PresetId, string> = {
  subtle: "Subtle",
  moderate: "Moderate",
  aggressive: "Aggressive",
  instrumental: "Instrumental",
  speedup: "Speed up",
};

interface CompleteMessage {
  id: number;
  type: "complete";
  name: string;
  wav: ArrayBuffer;
  notes: string[];
  log: string[];
}

interface ProgressMessage {
  id: number;
  type: "progress";
  progress: ProgressUpdate;
}

interface ErrorMessage {
  id: number;
  type: "error";
  error: { message: string };
}

interface AbortedMessage {
  id: number;
  type: "aborted";
}

interface FallbackMessage {
  id: number;
  type: "fallback-main";
}

type WorkerMessage = CompleteMessage | ProgressMessage | ErrorMessage | AbortedMessage | FallbackMessage;

const app = document.querySelector("#app");
if (!app) throw new Error("Missing app root.");

const capability = demucsCapability();
let selected: PresetId | "custom" = "moderate";
let speedPercent: number = SPEED_UP_DEFAULT;
let file: File | null = null;
let worker: Worker | null = null;
let mainAbort: AbortController | null = null;
let jobId = 0;
let lastPhase = "";
let objectUrl: string | null = null;
let stripFile: File | null = null;
let stripUrl: string | null = null;
const logLines: string[] = [];

app.innerHTML = `
  <header>
    <p class="eyebrow">In this browser</p>
    <h1>Audio Anonymizer</h1>
    <p class="lede">Adjust a track before you import it, or strip tags from audio you already have. The file never leaves this page.</p>
  </header>
  <div class="tabs" role="tablist" aria-label="Tools">
    <button type="button" role="tab" id="tab-anonymize" aria-controls="panel-anonymize" aria-selected="true">Anonymize</button>
    <button type="button" role="tab" id="tab-strip" aria-controls="panel-strip" aria-selected="false">Strip metadata</button>
  </div>
  <div id="panel-anonymize" role="tabpanel" aria-labelledby="tab-anonymize">
  <p class="lede">Adjust pitch, tempo, tone, and vocals on your machine, then download a 16-bit WAV with no metadata.</p>
  <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose an audio file">
    <div>
      <strong>Drop a file, or click to browse</strong>
      <p class="muted">MP3, WAV, OGG, FLAC, M4A, AAC, WebM · up to 250 MB</p>
    </div>
  </div>
  <input id="file" type="file" accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,.webm,audio/*" hidden />
  <p class="file-meta" id="file-meta"></p>
  <div class="presets" id="presets" role="radiogroup" aria-label="Preset"></div>
  <p class="copy" id="preset-copy"></p>
  <div class="panel" id="speed-panel" hidden>
    <div class="levels" id="levels" role="group" aria-label="Speed-up level"></div>
    <div class="bpm">
      <label>Original BPM
        <input id="bpm" type="number" min="1" max="400" step="0.01" placeholder="optional" />
      </label>
      <p class="hint" id="bpm-out"></p>
    </div>
  </div>
  <details id="advanced" open>
    <summary>Advanced settings</summary>
    <div id="groups"></div>
  </details>
  <div class="actions">
    <button class="primary" id="run" type="button" disabled>Anonymize it!</button>
    <button class="ghost" id="abort" type="button" hidden>Abort processing</button>
  </div>
  <div class="track" aria-hidden="true"><div id="bar"></div></div>
  <p class="status" id="status" aria-live="polite"></p>
  <pre class="log" id="log"></pre>
  <section class="result" id="result" hidden>
    <h2>Anonymization complete</h2>
    <p>Your anonymized track is ready!</p>
    <audio id="player" controls></audio>
    <p><a id="download" download>Download now</a></p>
    <ul class="notes" id="notes"></ul>
  </section>
  </div>
  <div id="panel-strip" role="tabpanel" aria-labelledby="tab-strip" hidden>
    <p class="lede">Remove title, artist, comment, lyrics, and cover art. MP3, WAV, FLAC, and M4A keep their audio frames. Other formats are saved as a metadata-free WAV.</p>
    <div class="drop" id="strip-drop" tabindex="0" role="button" aria-label="Choose an audio file to strip">
      <div>
        <strong>Drop a file, or click to browse</strong>
        <p class="muted">MP3, WAV, OGG, FLAC, M4A, AAC, WebM · up to 250 MB</p>
      </div>
    </div>
    <input id="strip-file" type="file" accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,.webm,audio/*" hidden />
    <p class="file-meta" id="strip-meta"></p>
    <div class="actions">
      <button class="primary" id="strip-run" type="button" disabled>Strip metadata</button>
    </div>
    <p class="status" id="strip-status" aria-live="polite"></p>
    <section class="result" id="strip-result" hidden>
      <h2>Metadata removed</h2>
      <p id="strip-summary"></p>
      <ul class="notes" id="strip-removed"></ul>
      <audio id="strip-player" controls></audio>
      <p><a id="strip-download" download>Download now</a></p>
    </section>
  </div>
`;

const drop = byId("drop");
const fileInput = byId("file") as HTMLInputElement;
const fileMeta = byId("file-meta");
const presetRow = byId("presets");
const presetCopy = byId("preset-copy");
const speedPanel = byId("speed-panel");
const levelRow = byId("levels");
const bpmInput = byId("bpm") as HTMLInputElement;
const bpmOut = byId("bpm-out");
const groups = byId("groups");
const runButton = byId("run") as HTMLButtonElement;
const abortButton = byId("abort") as HTMLButtonElement;
const bar = byId("bar") as HTMLDivElement;
const status = byId("status");
const logNode = byId("log");
const result = byId("result");
const player = byId("player") as HTMLAudioElement;
const download = byId("download") as HTMLAnchorElement;
const notes = byId("notes");

for (const id of PRESETS) {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "radio";
  button.dataset.preset = id;
  button.textContent = PRESET_LABELS[id];
  button.addEventListener("click", () => applyPreset(id));
  presetRow.append(button);
}

for (const percent of SPEED_UP_PERCENTS) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.speed = String(percent);
  button.textContent = `${percent}%`;
  button.addEventListener("click", () => {
    speedPercent = percent;
    applyPreset("speedup");
  });
  levelRow.append(button);
}

for (const group of CONTROL_GROUPS) {
  const section = document.createElement("section");
  section.className = "group";
  const title = document.createElement("h2");
  title.textContent = group.title;
  section.append(title);
  for (const control of group.controls) section.append(renderControl(control));
  groups.append(section);
}

if (!capability.allowed && capability.reason) {
  const note = document.createElement("p");
  note.className = "hint warn";
  note.textContent = `${capability.reason} Lyric bypass is skipped, and Hard falls back to Light.`;
  groups.prepend(note);
  const hard = groups.querySelector<HTMLButtonElement>('[data-key="instrumentalMode"][data-value="hard"]');
  const lyric = groups.querySelector<HTMLInputElement>('[data-key="lyricBypass"]');
  if (hard) {
    hard.disabled = true;
    hard.title = capability.reason;
  }
  if (lyric) {
    lyric.disabled = true;
    lyric.title = capability.reason;
  }
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("hot");
});
drop.addEventListener("dragleave", () => drop.classList.remove("hot"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("hot");
  const next = event.dataTransfer?.files?.[0];
  if (next) chooseFile(next);
});
fileInput.addEventListener("change", () => {
  const next = fileInput.files?.[0];
  if (next) chooseFile(next);
});
bpmInput.addEventListener("input", updateBpm);
runButton.addEventListener("click", start);
abortButton.addEventListener("click", abort);
groups.addEventListener("input", () => {
  if (selected !== "custom") markCustom();
});
groups.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.key !== "instrumentalMode") return;
  for (const button of groups.querySelectorAll<HTMLButtonElement>('[data-key="instrumentalMode"]')) {
    button.setAttribute("aria-pressed", button === target ? "true" : "false");
  }
  markCustom();
});

applyPreset("moderate");
bindStrip();

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function renderControl(control: Control): HTMLElement {
  if (control.kind === "segmented") {
    const wrap = document.createElement("div");
    wrap.className = "control";
    const label = document.createElement("span");
    label.textContent = control.label;
    const row = document.createElement("div");
    row.className = "segmented";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", control.label);
    for (const option of control.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.key = control.key;
      button.dataset.value = option.value;
      button.textContent = option.label;
      button.setAttribute("aria-pressed", "false");
      row.append(button);
    }
    wrap.append(label, row, hint(control.hint));
    return wrap;
  }
  if (control.kind === "checkbox") {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.key = control.key;
    const text = document.createElement("span");
    text.textContent = control.label;
    label.append(input, text);
    const wrap = document.createElement("div");
    wrap.className = "control";
    wrap.append(label);
    if (control.hint) wrap.append(hint(control.hint));
    return wrap;
  }
  return renderNumber(control);
}

function renderNumber(control: NumberControl): HTMLElement {
  const label = document.createElement("label");
  label.className = "control";
  const text = document.createElement("span");
  text.textContent = control.label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(control.min);
  input.max = String(control.max);
  input.step = String(control.step);
  input.dataset.key = control.key;
  if (control.scale) input.dataset.scale = String(control.scale);
  if (control.nullable) input.dataset.nullable = "true";
  if (control.placeholder) input.placeholder = control.placeholder;
  label.append(text, input);
  if (control.hint) label.append(hint(control.hint));
  return label;
}

function hint(text: string | undefined): HTMLElement {
  const node = document.createElement("p");
  node.className = "hint";
  node.textContent = text ?? "";
  if (!text) node.hidden = true;
  return node;
}

function applyPreset(id: PresetId) {
  selected = id;
  if (id === "speedup") speedPercent = SPEED_UP_PERCENTS.includes(speedPercent as (typeof SPEED_UP_PERCENTS)[number]) ? speedPercent : SPEED_UP_DEFAULT;
  writeSettings(presetSettings(id, speedPercent));
  paintPresets();
  updateBpm();
}

function writeSettings(settings: Settings) {
  for (const input of groups.querySelectorAll<HTMLInputElement>("input[data-key]")) {
    const key = input.dataset.key as keyof Settings;
    const value = settings[key];
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
      continue;
    }
    const scale = Number(input.dataset.scale ?? 1);
    if (value == null) input.value = "";
    else input.value = formatNumber(Number(value), scale);
  }
  for (const button of groups.querySelectorAll<HTMLButtonElement>('[data-key="instrumentalMode"]')) {
    button.setAttribute("aria-pressed", button.dataset.value === settings.instrumentalMode ? "true" : "false");
  }
}

function formatNumber(value: number, scale: number): string {
  const shown = Math.round(value * scale * 1000) / 1000;
  return String(shown);
}

function readSettings(): Settings {
  const raw: Partial<Settings> = {};
  for (const input of groups.querySelectorAll<HTMLInputElement>("input[data-key]")) {
    const key = input.dataset.key as keyof Settings;
    if (input.type === "checkbox") {
      (raw as Record<string, boolean>)[key] = input.checked;
      continue;
    }
    const scale = Number(input.dataset.scale ?? 1);
    if (input.dataset.nullable === "true" && input.value.trim() === "") {
      (raw as Record<string, null>)[key] = null;
      continue;
    }
    (raw as Record<string, number>)[key] = Number(input.value) / scale;
  }
  const pressed = groups.querySelector<HTMLButtonElement>('[data-key="instrumentalMode"][aria-pressed="true"]');
  raw.instrumentalMode = (pressed?.dataset.value as Settings["instrumentalMode"]) ?? "off";
  return raw as Settings;
}

function paintPresets() {
  for (const button of presetRow.querySelectorAll<HTMLButtonElement>("button")) {
    const on = button.dataset.preset === selected;
    button.setAttribute("aria-checked", on ? "true" : "false");
  }
  for (const button of levelRow.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", Number(button.dataset.speed) === speedPercent && selected === "speedup" ? "true" : "false");
  }
  speedPanel.hidden = selected !== "speedup";
  presetCopy.textContent = selected === "custom" ? "Custom settings. Choosing a preset resets every control." : PRESET_COPY[selected];
}

function markCustom() {
  selected = "custom";
  paintPresets();
}

function updateBpm() {
  const bpm = Number(bpmInput.value);
  const speed = Number((groups.querySelector<HTMLInputElement>('[data-key="speedFactor"]')?.value ?? "100")) / 100;
  bpmOut.textContent = Number.isFinite(bpm) && bpm > 0 ? `After this speed-up the tempo is ${(bpm * speed).toFixed(2)} BPM. Set it back in Suno Studio.` : "";
}

function chooseFile(next: File) {
  const problem = fileProblem(next);
  if (problem) {
    file = null;
    runButton.disabled = true;
    fileMeta.textContent = problem;
    fileMeta.className = "file-meta error";
    return;
  }
  file = next;
  runButton.disabled = false;
  fileMeta.textContent = fileLabel(next);
  fileMeta.className = next.size > WARN_FILE_BYTES ? "file-meta warn" : "file-meta";
}

function setBusy(busy: boolean) {
  runButton.disabled = busy || !file;
  abortButton.hidden = !busy;
  for (const node of groups.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
    const locked = !capability.allowed && (node.dataset.value === "hard" || node.dataset.key === "lyricBypass");
    node.disabled = busy || locked;
  }
  for (const button of presetRow.querySelectorAll("button")) (button as HTMLButtonElement).disabled = busy;
  for (const button of levelRow.querySelectorAll("button")) (button as HTMLButtonElement).disabled = busy;
}

function pushLog(line: string) {
  logLines.push(line);
  logNode.textContent = logLines.join("\n");
  logNode.scrollTop = logNode.scrollHeight;
}

function start() {
  if (!file) return;
  result.hidden = true;
  logLines.length = 0;
  lastPhase = "";
  logNode.textContent = "";
  notes.replaceChildren();
  bar.style.width = "0%";
  status.textContent = "Input";
  status.className = "status";
  setBusy(true);
  mainAbort = new AbortController();
  jobId += 1;
  const id = jobId;
  const current = file;
  void current.arrayBuffer().then((buffer) => {
    if (id !== jobId) return;
    worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => onWorker(event.data);
    const copy = buffer.slice(0);
    worker.postMessage(
      {
        id,
        task: "anonymize",
        fileName: current.name,
        fileBuffer: copy,
        presetId: selected,
        settings: readSettings(),
      },
      [copy],
    );
  });
}

function abort() {
  mainAbort?.abort();
  worker?.postMessage({ id: jobId, command: "abort" });
  jobId += 1;
  setBusy(false);
  status.textContent = "Processing aborted.";
  pushLog("Processing aborted.");
}

function applyProgress(progress: ProgressUpdate) {
  bar.style.width = `${Math.round(progress.fraction * 100)}%`;
  status.textContent = progress.message;
  if (progress.phase !== lastPhase) {
    lastPhase = progress.phase;
    pushLog(progress.message);
  }
}

async function runLocally(id: number) {
  if (!file || id !== jobId) return;
  const signal = mainAbort?.signal;
  const current = file;
  try {
    const bytes = await current.arrayBuffer();
    if (id !== jobId || signal?.aborted) return;
    const result = await anonymize({
      fileName: current.name,
      bytes,
      presetId: selected,
      settings: readSettings(),
      signal,
      demucs: capability,
      onProgress: (progress) => {
        if (id === jobId) applyProgress(progress);
      },
    });
    if (id !== jobId || signal?.aborted) return;
    showReady({
      name: result.fileName,
      wav: result.wav,
      notes: result.notes,
      log: result.log,
    });
  } catch (error) {
    if (id !== jobId || signal?.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    setBusy(false);
    status.textContent = message;
    status.className = "status error";
    pushLog(message);
  }
}

function showReady(message: { name: string; wav: ArrayBuffer; notes: string[]; log: string[] }) {
  setBusy(false);
  bar.style.width = "100%";
  status.textContent = "Anonymization complete";
  for (const line of message.log) {
    if (!logLines.includes(line)) pushLog(line);
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const blob = new Blob([message.wav], { type: "audio/wav" });
  objectUrl = URL.createObjectURL(blob);
  player.src = objectUrl;
  download.href = objectUrl;
  download.download = message.name;
  download.textContent = `Download now · ${message.name}`;
  notes.replaceChildren();
  for (const note of message.notes) {
    const item = document.createElement("li");
    item.textContent = note;
    notes.append(item);
  }
  result.hidden = false;
  void player.play().catch(() => {});
}

function bindStrip() {
  const tabAnonymize = byId("tab-anonymize");
  const tabStrip = byId("tab-strip");
  const panelAnonymize = byId("panel-anonymize");
  const panelStrip = byId("panel-strip");
  const stripDrop = byId("strip-drop");
  const stripInput = byId("strip-file") as HTMLInputElement;
  const stripMeta = byId("strip-meta");
  const stripButton = byId("strip-run") as HTMLButtonElement;
  const stripStatus = byId("strip-status");
  const stripResult = byId("strip-result");
  const stripSummary = byId("strip-summary");
  const stripRemoved = byId("strip-removed");
  const stripPlayer = byId("strip-player") as HTMLAudioElement;
  const stripDownload = byId("strip-download") as HTMLAnchorElement;

  const showTab = (name: "anonymize" | "strip") => {
    const anonymize = name === "anonymize";
    panelAnonymize.hidden = !anonymize;
    panelStrip.hidden = anonymize;
    tabAnonymize.setAttribute("aria-selected", anonymize ? "true" : "false");
    tabStrip.setAttribute("aria-selected", anonymize ? "false" : "true");
  };
  tabAnonymize.addEventListener("click", () => showTab("anonymize"));
  tabStrip.addEventListener("click", () => showTab("strip"));

  const choose = (next: File) => {
    const problem = fileProblem(next);
    if (problem) {
      stripFile = null;
      stripButton.disabled = true;
      stripMeta.textContent = problem;
      stripMeta.className = "file-meta error";
      return;
    }
    stripFile = next;
    stripButton.disabled = false;
    stripMeta.textContent = fileLabel(next);
    stripMeta.className = next.size > WARN_FILE_BYTES ? "file-meta warn" : "file-meta";
  };

  stripDrop.addEventListener("click", () => stripInput.click());
  stripDrop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      stripInput.click();
    }
  });
  stripDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    stripDrop.classList.add("hot");
  });
  stripDrop.addEventListener("dragleave", () => stripDrop.classList.remove("hot"));
  stripDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    stripDrop.classList.remove("hot");
    const next = event.dataTransfer?.files?.[0];
    if (next) choose(next);
  });
  stripInput.addEventListener("change", () => {
    const next = stripInput.files?.[0];
    if (next) choose(next);
  });

  stripButton.addEventListener("click", () => {
    if (!stripFile) return;
    const current = stripFile;
    stripButton.disabled = true;
    stripResult.hidden = true;
    stripStatus.className = "status";
    stripStatus.textContent = "Removing tags…";
    void current.arrayBuffer().then(async (buffer) => {
      try {
        const cleaned = await stripMetadata(buffer, current.name);
        if (stripUrl) URL.revokeObjectURL(stripUrl);
        stripUrl = URL.createObjectURL(new Blob([cleaned.bytes], { type: cleaned.mime }));
        stripPlayer.src = stripUrl;
        stripDownload.href = stripUrl;
        stripDownload.download = cleaned.fileName;
        stripDownload.textContent = `Download now · ${cleaned.fileName}`;
        stripSummary.textContent = stripSummaryText(cleaned.removed.length, cleaned.rewritten);
        stripRemoved.replaceChildren();
        for (const line of cleaned.removed) {
          const item = document.createElement("li");
          item.textContent = line;
          stripRemoved.append(item);
        }
        stripResult.hidden = false;
        stripStatus.textContent = "Metadata removed.";
        void stripPlayer.play().catch(() => {});
      } catch (error) {
        stripResult.hidden = true;
        stripStatus.className = "status error";
        stripStatus.textContent = error instanceof Error ? error.message : "Could not strip this file.";
      } finally {
        stripButton.disabled = !stripFile;
      }
    });
  });
}

function fileProblem(next: File): string | null {
  const extension = next.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return `This page accepts ${ACCEPTED_EXTENSIONS.join(", ")}.`;
  }
  if (next.size > MAX_FILE_BYTES) return "File too large. Files above 250 MB are refused.";
  return null;
}

function fileLabel(next: File): string {
  const size = (next.size / (1024 * 1024)).toFixed(1);
  const warning = next.size > WARN_FILE_BYTES ? " Above 80 MB, processing may be slow or run out of memory." : "";
  return `${next.name} · ${size} MB.${warning}`;
}

function stripSummaryText(removed: number, rewritten: boolean): string {
  if (removed === 0) return "No metadata tags were found. You can still download the file.";
  if (rewritten) return "Tags could not be cut in place, so the audio was rewritten as a metadata-free WAV.";
  return "These tags were removed. The audio frames were left in place.";
}

function onWorker(message: WorkerMessage) {
  if (message.id !== jobId) return;
  if (message.type === "fallback-main") {
    void runLocally(message.id);
    return;
  }
  if (message.type === "progress") {
    applyProgress(message.progress);
    return;
  }
  if (message.type === "aborted") {
    setBusy(false);
    status.textContent = "Processing aborted.";
    return;
  }
  if (message.type === "error") {
    setBusy(false);
    status.textContent = message.error.message;
    status.className = "status error";
    pushLog(message.error.message);
    return;
  }
  showReady(message);
}
