import { downmixStereo } from "./dsp";
import { resampleOffline } from "./render";

export const DEMUCS_URL = "https://huggingface.co/MrCitron/demucs-v4-onnx/resolve/main/htdemucs.onnx";
export const DEMUCS_SHA256 = "7ed6e26883845a16a6d170069a4ff99b8410c2a64d0a2570ed0eb852eea234a2";
export const DEMUCS_BYTES = 302899058;
export const DEMUCS_RATE = 44100;
export const DEMUCS_CHUNK = 343980;
export const DEMUCS_OVERLAP = 44100;
const CACHE_NAME = "onus-demucs-v1";
const CACHE_KEY = `${DEMUCS_URL}?integrity=sha256-${DEMUCS_SHA256}`;

export interface SeparateProgress {
  onModelProgress?: (loaded: number, total: number) => void;
  onChunkProgress?: (index: number, count: number) => void;
  yieldFrame?: () => Promise<void>;
  signal?: AbortSignal;
  needsVocals?: boolean;
}

export interface SeparatedStems {
  sampleRate: number;
  instrumental: Float32Array[];
  vocals: Float32Array[] | null;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyModel(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (buffer.byteLength !== DEMUCS_BYTES) {
    throw new Error(`model_integrity_failed: expected ${DEMUCS_BYTES} bytes, received ${buffer.byteLength}`);
  }
  const hash = await sha256(buffer);
  if (hash !== DEMUCS_SHA256) throw new Error(`model_integrity_failed: SHA-256 mismatch; expected ${DEMUCS_SHA256}, received ${hash}`);
  return buffer;
}

async function readBody(response: Response, signal: AbortSignal | undefined, onProgress?: (loaded: number, total: number) => void) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    onProgress?.(buffer.byteLength, DEMUCS_BYTES);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress?.(0, DEMUCS_BYTES);
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, DEMUCS_BYTES);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

let memory: ArrayBuffer | null = null;
let loading: Promise<ArrayBuffer> | null = null;

async function downloadModel(signal?: AbortSignal, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const delays = [500, 1000];
  let last: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await fetch(DEMUCS_URL, { method: "GET", cache: "no-store", credentials: "omit", signal });
      if (!response.ok) {
        const error = new Error(`The model download was interrupted (HTTP ${response.status}).`);
        if (response.status === 408 || response.status === 429 || response.status >= 500) throw error;
        throw error;
      }
      const buffer = await readBody(response, signal, onProgress);
      return verifyModel(buffer);
    } catch (error) {
      throwIfAborted(signal);
      last = error;
      if (attempt === delays.length) break;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  const message = last instanceof Error ? last.message : String(last);
  if (message.startsWith("model_integrity_failed")) throw last;
  throw new Error(`The model download was interrupted. ${message}`);
}

export async function loadDemucsModel(signal?: AbortSignal, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  if (memory) {
    onProgress?.(memory.byteLength, memory.byteLength);
    return memory;
  }
  if (!loading) {
    loading = (async () => {
      const cache = await openCache();
      if (cache) {
        const cached = await cache.match(CACHE_KEY);
        if (cached) {
          try {
            const buffer = await verifyModel(await cached.arrayBuffer());
            onProgress?.(buffer.byteLength, buffer.byteLength);
            memory = buffer;
            return buffer;
          } catch {
            await cache.delete(CACHE_KEY).catch(() => {});
          }
        }
      }
      const buffer = await downloadModel(signal, onProgress);
      memory = buffer;
      const store = await openCache();
      if (store) {
        try {
          await store.put(CACHE_KEY, new Response(buffer));
        } catch {
          /* The verified bytes are already in memory for this run. */
        }
      }
      return buffer;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

function threadCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  if (!crossOriginIsolated) return 1;
  return Math.min(8, Math.max(1, Math.ceil(cores / 2)));
}

async function loadOrt() {
  const ort = await import("onnxruntime-web");
  const base = new URL(import.meta.env.BASE_URL, location.origin);
  ort.env.wasm.wasmPaths = new URL("ort/", base).href;
  ort.env.wasm.numThreads = threadCount();
  return ort;
}

interface ParsedOutput {
  sources: Float32Array[][];
}

function parseOutput(data: Float32Array, dims: readonly number[]): ParsedOutput {
  let sources: number;
  let channels: number;
  let samples: number;
  if (dims.length === 4) {
    sources = dims[1];
    channels = dims[2];
    samples = dims[3];
  } else if (dims.length === 3) {
    const [a, b, c] = dims;
    if (a === 4 || a === 2) {
      sources = a;
      channels = b;
      samples = c;
    } else if (a === 1 && (b === 4 || b === 8)) {
      sources = b === 8 ? 4 : b;
      channels = b === 8 ? 2 : 1;
      samples = c;
    } else {
      throw new Error(`Unsupported Demucs output shape: [${dims.join(",")}]`);
    }
  } else {
    throw new Error(`Unsupported Demucs output rank: [${dims.join(",")}]`);
  }
  if (sources < 4 || channels < 1 || samples < 1) {
    throw new Error(`Unsupported Demucs output shape: [${dims.join(",")}]`);
  }
  const needed = sources * channels * samples;
  if (data.length < needed) throw new Error(`Demucs output was truncated: expected ${needed} values, received ${data.length}`);
  const parsed: Float32Array[][] = [];
  for (let source = 0; source < sources; source += 1) {
    const planes: Float32Array[] = [];
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = source * channels * samples + channel * samples;
      planes.push(data.subarray(offset, offset + samples).slice());
    }
    parsed.push(planes);
  }
  return { sources: parsed };
}

function packChunk(channels: Float32Array[], offset: number, length: number): Float32Array {
  const packed = new Float32Array(2 * length);
  for (let channel = 0; channel < 2; channel += 1) {
    const source = channels[channel];
    const count = Math.max(0, Math.min(length, source.length - offset));
    if (count > 0) packed.set(source.subarray(offset, offset + count), channel * length);
  }
  return packed;
}

function addCrossfade(
  dest: Float32Array[],
  source: Float32Array[],
  offset: number,
  count: number,
  fadeIn: number,
  fadeOut: number,
) {
  const channelCount = Math.min(dest.length, source.length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const target = dest[channel];
    const input = source[channel];
    const available = Math.max(0, Math.min(count, input.length, target.length - offset));
    for (let i = 0; i < available; i += 1) {
      let gain = 1;
      if (i < fadeIn) gain = i / Math.max(1, fadeIn - 1);
      else if (fadeOut > 0 && i >= available - fadeOut) {
        gain = 1 - (i - (available - fadeOut)) / Math.max(1, fadeOut - 1);
      }
      target[offset + i] += input[i] * gain;
    }
  }
}

function asStereo(planes: Float32Array[]): Float32Array[] {
  if (planes.length >= 2) return [planes[0], planes[1]];
  return [planes[0] ?? new Float32Array(), (planes[0] ?? new Float32Array()).slice()];
}

export async function separate(channels: Float32Array[], sampleRate: number, progress: SeparateProgress = {}): Promise<SeparatedStems> {
  const { onModelProgress, onChunkProgress, yieldFrame = async () => {}, signal, needsVocals = true } = progress;
  throwIfAborted(signal);
  const ort = await loadOrt();
  const model = await loadDemucsModel(signal, onModelProgress);
  throwIfAborted(signal);
  const providers: Array<"webgpu" | "wasm"> = [];
  if ("gpu" in navigator) providers.push("webgpu");
  providers.push("wasm");
  let session: import("onnxruntime-web").InferenceSession;
  try {
    session = await ort.InferenceSession.create(model, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
  } catch {
    session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }
  memory = null;
  try {
    const stereo = downmixStereo(channels);
    const resampled = await resampleOffline(stereo, sampleRate, DEMUCS_RATE);
    throwIfAborted(signal);
    const frames = resampled[0]?.length ?? 0;
    const stride = DEMUCS_CHUNK - DEMUCS_OVERLAP;
    if (stride <= 0) throw new RangeError("Demucs overlap must be smaller than its chunk.");
    const chunkCount = Math.max(1, Math.ceil((frames - DEMUCS_OVERLAP) / stride));
    const instrumental = [new Float32Array(frames), new Float32Array(frames)];
    const vocals = needsVocals ? [new Float32Array(frames), new Float32Array(frames)] : null;
    const inputName = session.inputNames?.[0] ?? "mix";
    for (let index = 0; index < chunkCount; index += 1) {
      throwIfAborted(signal);
      const offset = index * stride;
      const tensor = new ort.Tensor("float32", packChunk(resampled, offset, DEMUCS_CHUNK), [1, 2, DEMUCS_CHUNK]);
      let outputs: Record<string, import("onnxruntime-web").Tensor> | undefined;
      try {
        outputs = await session.run({ [inputName]: tensor });
        throwIfAborted(signal);
        const tensors = Object.values(outputs);
        const chosen = tensors.find((item) => (item.dims?.length ?? 0) >= 3) ?? tensors[0];
        if (!chosen) throw new Error("Demucs returned no outputs.");
        const raw = chosen.data instanceof Float32Array ? chosen.data : new Float32Array(chosen.data as ArrayLike<number>);
        const parsed = parseOutput(raw, chosen.dims);
        const fadeIn = index === 0 ? 0 : DEMUCS_OVERLAP;
        const fadeOut = index === chunkCount - 1 ? 0 : DEMUCS_OVERLAP;
        const count = Math.min(DEMUCS_CHUNK, frames - offset);
        if (parsed.sources[0]) addCrossfade(instrumental, asStereo(parsed.sources[0]), offset, count, fadeIn, fadeOut);
        if (parsed.sources[1]) addCrossfade(instrumental, asStereo(parsed.sources[1]), offset, count, fadeIn, fadeOut);
        if (parsed.sources[2]) addCrossfade(instrumental, asStereo(parsed.sources[2]), offset, count, fadeIn, fadeOut);
        if (vocals && parsed.sources[3]) addCrossfade(vocals, asStereo(parsed.sources[3]), offset, count, fadeIn, fadeOut);
      } finally {
        tensor.dispose();
        if (outputs) Object.values(outputs).forEach((item) => item.dispose());
      }
      onChunkProgress?.(index + 1, chunkCount);
      await yieldFrame();
      throwIfAborted(signal);
    }
    return { sampleRate: DEMUCS_RATE, instrumental, vocals };
  } finally {
    await session.release();
  }
}
