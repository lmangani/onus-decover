import {
  applyBiquad,
  clamp01,
  energy,
  filterBand,
  notch,
  pitchJitter,
  pitchShift,
  resampleLinear,
  rmsEnvelope,
  timeStretch,
} from "./dsp";

export interface VocalDetection {
  hasVocals: boolean;
  confidence: number;
  score: number;
  features: { bandFraction: number; modIndex: number; centerScore: number };
}

const EMPTY: VocalDetection = {
  hasVocals: true,
  confidence: 0,
  score: 0,
  features: { bandFraction: 0, modIndex: 0, centerScore: 0.5 },
};

export function detectVocals(channels: Float32Array[], sampleRate: number): VocalDetection {
  const frames = channels[0]?.length ?? 0;
  if (channels.length === 0 || frames === 0) return EMPTY;
  if (frames < Math.floor(0.5 * sampleRate)) {
    return { hasVocals: true, confidence: 0, score: 1, features: { bandFraction: 0, modIndex: 0, centerScore: 0.5 } };
  }
  const length = Math.min(frames, Math.floor(60 * sampleRate));
  const start = Math.floor((frames - length) / 2);
  const left = channels[0].subarray(start, start + length);
  const right = (channels[1] ?? channels[0]).subarray(start, start + length);
  const mid = new Float32Array(length);
  const side = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    mid[i] = 0.5 * (left[i] + right[i]);
    side[i] = 0.5 * (left[i] - right[i]);
  }
  const midBand = filterBand(filterBand(mid, sampleRate, 300, 0.707, "highpass"), sampleRate, 3400, 0.707, "lowpass");
  const sideBand = filterBand(filterBand(side, sampleRate, 300, 0.707, "highpass"), sampleRate, 3400, 0.707, "lowpass");
  const bandEnergy = energy(midBand);
  const bandFraction = clamp01(bandEnergy / (energy(mid) + 1e-9));
  const centerScore = channels.length > 1 ? clamp01(bandEnergy / (bandEnergy + energy(sideBand) + 1e-9)) : 0.5;
  const window = Math.max(1, Math.round(0.023 * sampleRate));
  const hop = Math.max(1, Math.round(0.0116 * sampleRate));
  const envelope = rmsEnvelope(midBand, window, hop);
  let mean = 0;
  for (const frame of envelope) mean += frame;
  mean = mean / envelope.length + 1e-9;
  const envelopeRate = sampleRate / hop;
  const shaped =
    envelope.length > 8 && envelopeRate > 12 ? filterBand(envelope, envelopeRate, 4, 0.7, "bandpass") : envelope;
  const modIndex = clamp01(Math.sqrt(energy(shaped) / shaped.length) / mean);
  const score = clamp01(0.45 * clamp01(modIndex / 0.6) + 0.35 * clamp01(bandFraction / 0.5) + 0.2 * clamp01((centerScore - 0.5) / 0.4));
  return {
    hasVocals: score >= 0.32,
    confidence: clamp01(Math.abs(score - 0.32) / 0.32),
    score,
    features: { bandFraction, modIndex, centerScore },
  };
}

function formantShift(input: Float32Array, semitones: number): Float32Array {
  if (semitones === 0) return input.slice();
  const ratio = 2 ** (semitones / 12);
  const resampled = resampleLinear(input, 1 / ratio);
  const stretched = timeStretch(resampled, ratio);
  const corrected = pitchShift(stretched, -semitones);
  const out = new Float32Array(input.length);
  out.set(corrected.subarray(0, Math.min(out.length, corrected.length)));
  return out;
}

function velvetNoise(length: number, seed: number): Float32Array {
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967295) * 2 - 1;
  };
  const bank = new Float32Array(16);
  const out = new Float32Array(length);
  let accumulator = 0;
  let counter = 1;
  for (let i = 0; i < length; i += 1) {
    const slot = Math.min(bank.length - 1, Math.floor(Math.log2(counter & -counter)));
    const value = random();
    accumulator += value - bank[slot];
    bank[slot] = value;
    out[i] = (accumulator + random() * 0.5) / (bank.length * 0.5);
    counter += 1;
  }
  return out;
}

function noiseBed(vocal: Float32Array, seed: number): Float32Array {
  const gain = 10 ** (-30 / 20);
  const noise = velvetNoise(vocal.length, seed);
  const reversed = new Float32Array(vocal.length);
  for (let i = 0; i < vocal.length; i += 1) reversed[i] = vocal[vocal.length - 1 - i];
  const shifted = pitchShift(reversed, -4);
  const out = new Float32Array(vocal.length);
  for (let i = 0; i < out.length; i += 1) out[i] = noise[i] * gain + (shifted[i] ?? 0) * gain * 0.7;
  return out;
}

export function mangleVocals(channels: Float32Array[], sampleRate: number): Float32Array[] {
  return channels.map((channel, index) => {
    const shifted = formantShift(channel, 2);
    const notched = [2500, 3500].reduce((audio, frequency) => applyBiquad(audio, notch(sampleRate, frequency, 20)), shifted);
    const wobbled = pitchJitter(notched, sampleRate, 20, 6, false);
    const bed = noiseBed(wobbled, 12648430 + index * 1009);
    const out = new Float32Array(wobbled.length);
    for (let i = 0; i < out.length; i += 1) out[i] = wobbled[i] + bed[i];
    return out;
  });
}

export function limitPeak(channels: Float32Array[], db = -1): Float32Array[] {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  const ceiling = 10 ** (db / 20);
  if (peak <= ceiling) return channels;
  const gain = ceiling / peak;
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] * gain;
    return out;
  });
}

export function remixStems(
  instrumental: Float32Array[],
  vocals: Float32Array[] | null,
  signal?: AbortSignal,
): Float32Array[] {
  if (!vocals) return limitPeak(instrumental);
  const channelCount = Math.min(instrumental.length, vocals.length);
  const frames = instrumental[0]?.length ?? 0;
  const mixed: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    signal?.throwIfAborted();
    const out = new Float32Array(frames);
    const voice = vocals[channel];
    const bed = instrumental[channel];
    for (let i = 0; i < frames; i += 1) out[i] = bed[i] + (voice[i] ?? 0);
    mixed.push(out);
  }
  return limitPeak(mixed);
}
