import mpegMode from "lamejs/src/js/MPEGMode.js";
import lameCore from "lamejs/src/js/Lame.js";
import bitStream from "lamejs/src/js/BitStream.js";
import { downmixStereo, floatToInt16, snapBitrate, snapSampleRate } from "./dsp";
import { resampleOffline } from "./render";

const lameGlobals = globalThis as unknown as Record<string, unknown>;
lameGlobals.MPEGMode = mpegMode;
lameGlobals.Lame = lameCore;
lameGlobals.BitStream = bitStream;

export interface Mp3Options {
  bitrateKbps: number;
  useVbr?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  yieldFrame?: () => Promise<void>;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

async function decodeMp3(bytes: Uint8Array, sampleRate: number): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const context = new OfflineAudioContext(2, Math.max(1, bytes.byteLength + sampleRate), sampleRate);
  const decoded = await context.decodeAudioData(copy);
  return {
    channels: Array.from({ length: decoded.numberOfChannels }, (_, index) => new Float32Array(decoded.getChannelData(index))),
    sampleRate: decoded.sampleRate,
  };
}

export async function mp3RoundTrip(
  channels: Float32Array[],
  sampleRate: number,
  options: Mp3Options,
): Promise<{ channels: Float32Array[]; sampleRate: number; skipped: boolean }> {
  const { bitrateKbps, useVbr = false, signal, onProgress = () => {}, yieldFrame = async () => {} } = options;
  signal?.throwIfAborted();
  if (channels.length === 0 || (channels[0]?.length ?? 0) === 0) {
    return { channels, sampleRate, skipped: false };
  }
  let Encoder: typeof import("lamejs").Mp3Encoder;
  try {
    const imported = (await import("lamejs")) as typeof import("lamejs") & {
      default?: { Mp3Encoder?: typeof import("lamejs").Mp3Encoder };
    };
    const resolved = imported.Mp3Encoder ?? imported.default?.Mp3Encoder;
    if (!resolved) return { channels, sampleRate, skipped: true };
    Encoder = resolved;
  } catch {
    return { channels, sampleRate, skipped: true };
  }
  signal?.throwIfAborted();
  const mono = channels.length === 1;
  const stereo = mono ? [channels[0].slice()] : downmixStereo(channels);
  const rate = snapSampleRate(sampleRate);
  const resampled = await resampleOffline(stereo, sampleRate, rate);
  signal?.throwIfAborted();
  const target = useVbr ? Math.min(320, Math.round(bitrateKbps * 1.15)) : bitrateKbps;
  const bitrate = snapBitrate(target);
  const channelCount = mono ? 1 : 2;
  const left = floatToInt16(resampled[0]);
  const right = channelCount === 2 ? floatToInt16(resampled[1]) : null;
  let encoder: import("lamejs").Mp3Encoder;
  try {
    encoder = new Encoder(channelCount, rate, bitrate);
  } catch {
    return { channels, sampleRate, skipped: true };
  }
  const frames: Uint8Array[] = [];
  const hop = 1152;
  for (let offset = 0; offset < left.length; offset += hop) {
    signal?.throwIfAborted();
    const end = Math.min(left.length, offset + hop);
    const encoded =
      channelCount === 2 && right
        ? encoder.encodeBuffer(left.subarray(offset, end), right.subarray(offset, end))
        : encoder.encodeBuffer(left.subarray(offset, end));
    if (encoded.byteLength > 0) frames.push(viewBytes(encoded).slice());
    if ((Math.floor(offset / hop) + 1) % 32 === 0) {
      onProgress(offset / left.length);
      await yieldFrame();
      signal?.throwIfAborted();
    }
  }
  const tail = encoder.flush();
  if (tail.byteLength > 0) frames.push(viewBytes(tail).slice());
  onProgress(1);
  signal?.throwIfAborted();
  const decoded = await decodeMp3(concat(frames), sampleRate);
  signal?.throwIfAborted();
  if (mono && decoded.channels.length > 1) {
    return { channels: [decoded.channels[0]], sampleRate: decoded.sampleRate, skipped: false };
  }
  return { channels: decoded.channels, sampleRate: decoded.sampleRate, skipped: false };
}
