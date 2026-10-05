export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function hann(length: number): Float32Array {
  const window = new Float32Array(length);
  const denom = Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }
  return window;
}

/** Overlap-add stretch. `ratio` is output length divided by input length. */
export function timeStretch(input: Float32Array, ratio: number, windowSize = 2048, synthesisHop = 512): Float32Array {
  if (ratio === 1 || input.length < 32) return input.slice();
  const pow = 2 ** Math.floor(Math.log2(input.length / 4));
  const size = Math.max(32, Math.min(windowSize, pow || windowSize));
  const synthHop = Math.max(8, Math.min(synthesisHop, Math.floor(size / 4)));
  const analysisHop = Math.max(1, Math.round(synthHop / ratio));
  const window = hann(size);
  const target = Math.max(1, Math.round(input.length * ratio));
  const mixed = new Float32Array(target + size);
  const weight = new Float32Array(mixed.length);
  let read = 0;
  let write = 0;
  let last = 0;
  while (read + size <= input.length && write + size <= mixed.length) {
    for (let i = 0; i < size; i += 1) {
      const w = window[i];
      mixed[write + i] += input[read + i] * w;
      weight[write + i] += w;
    }
    last = write;
    read += analysisHop;
    write += synthHop;
  }
  const end = Math.min(mixed.length, last + size);
  const out = new Float32Array(Math.min(target, end));
  for (let i = 0; i < out.length; i += 1) out[i] = weight[i] > 1e-6 ? mixed[i] / weight[i] : 0;
  return out;
}

export function resampleLinear(input: Float32Array, ratio: number): Float32Array {
  if (ratio === 1) return input.slice();
  const length = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(length);
  const last = input.length - 1;
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const left = Math.min(Math.floor(position), last);
    const right = Math.min(left + 1, last);
    const frac = position - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

export function pitchShift(input: Float32Array, semitones: number): Float32Array {
  if (semitones === 0) return input.slice();
  const ratio = 2 ** (semitones / 12);
  const stretched = timeStretch(input, ratio);
  const restored = resampleLinear(stretched, 1 / ratio);
  const out = new Float32Array(input.length);
  out.set(restored.subarray(0, Math.min(out.length, restored.length)));
  return out;
}

export function normalizePeak(channels: Float32Array[]): Float32Array[] {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  if (peak <= 1e-8 || peak === 1) return channels;
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] / peak;
    return out;
  });
}

export function padSilence(channels: Float32Array[], sampleRate: number, seconds: number): Float32Array[] {
  if (seconds <= 0) return channels;
  const offset = Math.floor(sampleRate * seconds);
  return channels.map((channel) => {
    const out = new Float32Array(channel.length + offset);
    out.set(channel, offset);
    return out;
  });
}

export function cancelCenter(channels: Float32Array[]): Float32Array[] {
  if (channels.length < 2) return channels.map((channel) => channel.slice());
  const length = Math.min(channels[0].length, channels[1].length);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const side = (channels[0][i] - channels[1][i]) * 0.5;
    left[i] = side;
    right[i] = -side;
  }
  return [left, right];
}

export function peaking(sampleRate: number, frequency: number, q: number, gainDb: number): Biquad {
  const a = 10 ** (gainDb / 40);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const cos = Math.cos(omega);
  const a0 = 1 + alpha / a;
  return {
    b0: (1 + alpha * a) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * a) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / a) / a0,
  };
}

export function notch(sampleRate: number, frequency: number, q: number): Biquad {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const cos = Math.cos(omega);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cos) / a0,
    b2: 1 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function designRbj(
  sampleRate: number,
  frequency: number,
  q: number,
  type: "highpass" | "lowpass" | "bandpass",
): Biquad {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  const a0 = 1 + alpha;
  if (type === "highpass") {
    return {
      b0: (1 + cos) / 2 / a0,
      b1: -(1 + cos) / a0,
      b2: (1 + cos) / 2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }
  if (type === "lowpass") {
    return {
      b0: (1 - cos) / 2 / a0,
      b1: (1 - cos) / a0,
      b2: (1 - cos) / 2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function applyBiquad(input: Float32Array, filter: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i];
    const y = filter.b0 * x + filter.b1 * x1 + filter.b2 * x2 - filter.a1 * y1 - filter.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

export function filterBand(
  input: Float32Array,
  sampleRate: number,
  frequency: number,
  q: number,
  type: "highpass" | "lowpass" | "bandpass",
): Float32Array {
  return applyBiquad(input, designRbj(sampleRate, frequency, q, type));
}

function signedNoise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967295) * 2 - 1;
  };
}

export function eqTilt(
  channels: Float32Array[],
  sampleRate: number,
  bands: number,
  maxDb: number,
  seed = 659918,
): Float32Array[] {
  if (bands <= 0 || maxDb <= 0) return channels;
  const maxHz = Math.min(10000, sampleRate / 2 - 100);
  const minHz = 120;
  if (maxHz <= minHz) return channels;
  const random = signedNoise(seed);
  const filters: Biquad[] = [];
  const logMin = Math.log(minHz);
  const logMax = Math.log(maxHz);
  for (let band = 0; band < bands; band += 1) {
    const position = (band + 0.5) / bands;
    const frequency = Math.exp(logMin + position * (logMax - logMin));
    filters.push(peaking(sampleRate, frequency, 1.4, random() * maxDb));
  }
  return channels.map((channel) => filters.reduce((audio, filter) => applyBiquad(audio, filter), channel));
}

function triangle(phase: number): number {
  const fraction = phase - Math.floor(phase);
  return fraction < 0.5 ? 4 * fraction - 1 : 3 - 4 * fraction;
}

export function pitchJitter(input: Float32Array, sampleRate: number, cents: number, lfoHz: number, wrap: boolean): Float32Array {
  if (cents <= 0 || lfoHz <= 0 || input.length < 2) return input.slice();
  const depth = 2 ** (cents / 1200);
  const out = new Float32Array(input.length);
  const last = input.length - 1;
  let read = 0;
  let phase = 0;
  for (let i = 0; i < input.length; i += 1) {
    const step = depth ** triangle(phase);
    const position = wrap ? Math.min(Math.floor(read), last) : Math.min(last, Math.max(0, read));
    const left = Math.floor(position);
    const right = Math.min(last, left + 1);
    const frac = position - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
    read += step;
    if (wrap) {
      if (read >= last) read -= last;
    } else {
      read = Math.min(last, read);
    }
    phase += lfoHz / sampleRate;
  }
  return out;
}

export function mixJitter(channels: Float32Array[], sampleRate: number, cents: number, lfoHz: number): Float32Array[] {
  if (cents <= 0 || lfoHz <= 0) return channels;
  return channels.map((channel) => pitchJitter(channel, sampleRate, cents, lfoHz, true));
}

export function sideJitter(channels: Float32Array[], sampleRate: number, cents: number, lfoHz: number): Float32Array[] {
  if (cents <= 0 || lfoHz <= 0 || channels.length < 2) return channels;
  const length = Math.min(channels[0].length, channels[1].length);
  const mid = new Float32Array(length);
  const side = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    mid[i] = (channels[0][i] + channels[1][i]) * 0.5;
    side[i] = (channels[0][i] - channels[1][i]) * 0.5;
  }
  const jittered = pitchJitter(side, sampleRate, cents, lfoHz, true);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    left[i] = mid[i] + jittered[i];
    right[i] = mid[i] - jittered[i];
  }
  return channels.length === 2 ? [left, right] : [left, right, ...channels.slice(2)];
}

export function peakSmear(
  channels: Float32Array[],
  sampleRate: number,
  bands: number,
  depthDb: number,
  lfoHz: number,
): Float32Array[] {
  if (bands <= 0 || depthDb <= 0 || lfoHz <= 0) return channels;
  const maxHz = Math.min(8000, sampleRate / 2 - 100);
  const minHz = 500;
  if (maxHz <= minHz) return channels;
  const block = Math.max(256, Math.round(sampleRate * 0.046));
  const logMin = Math.log(minHz);
  const logSpan = Math.log(maxHz) - logMin;
  const phases = Array.from({ length: bands }, (_, band) => (band / bands) * Math.PI * 2);
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    const state = new Float64Array(bands * 4);
    let filters: Biquad[] = [];
    const update = (sampleIndex: number) => {
      const time = sampleIndex / sampleRate;
      filters = Array.from({ length: bands }, (_, band) => {
        const center = (band + 0.5) / bands;
        const lfo = Math.sin(2 * Math.PI * lfoHz * time + phases[band]);
        const weight = Math.min(1, Math.max(0, center + lfo * (0.25 / bands)));
        const frequency = Math.exp(logMin + weight * logSpan);
        const gain = (band % 2 === 0 ? -1 : 1) * depthDb;
        return peaking(sampleRate, frequency, 8, gain);
      });
    };
    update(0);
    for (let i = 0; i < channel.length; i += 1) {
      if (i > 0 && i % block === 0) update(i);
      let sample = channel[i];
      for (let band = 0; band < bands; band += 1) {
        const filter = filters[band];
        const base = band * 4;
        const y =
          filter.b0 * sample +
          filter.b1 * state[base] +
          filter.b2 * state[base + 1] -
          filter.a1 * state[base + 2] -
          filter.a2 * state[base + 3];
        state[base + 1] = state[base];
        state[base] = sample;
        state[base + 3] = state[base + 2];
        state[base + 2] = y;
        sample = y;
      }
      out[i] = sample;
    }
    return out;
  });
}

export function injectSub(channels: Float32Array[], sampleRate: number, hz: number, gainDb: number): Float32Array[] {
  if (hz <= 0 || !Number.isFinite(gainDb)) return channels;
  const amplitude = 10 ** (gainDb / 20);
  const offset = amplitude * 0.25;
  const omega = (2 * Math.PI * hz) / sampleRate;
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] + amplitude * Math.sin(omega * i) + offset;
    return out;
  });
}

export function downmixStereo(channels: Float32Array[]): Float32Array[] {
  if (channels.length === 0) return [new Float32Array(), new Float32Array()];
  if (channels.length === 1) return [channels[0].slice(), channels[0].slice()];
  if (channels.length === 2) return [channels[0], channels[1]];
  const length = channels[0].length;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const scale = Math.SQRT1_2;
  const add = (target: Float32Array, source: Float32Array, gain: number) => {
    const count = Math.min(target.length, source.length);
    for (let i = 0; i < count; i += 1) target[i] += source[i] * gain;
  };
  add(left, channels[0], 1);
  add(right, channels[1], 1);
  if (channels.length === 3) {
    add(left, channels[2], scale);
    add(right, channels[2], scale);
  } else if (channels.length === 4) {
    add(left, channels[2], scale);
    add(right, channels[3], scale);
  } else {
    add(left, channels[2], scale);
    add(right, channels[2], scale);
  }
  return [left, right];
}

export function energy(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return sum;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function rmsEnvelope(samples: Float32Array, window: number, hop: number): Float32Array {
  const frames = Math.max(1, Math.floor((samples.length - window) / hop) + 1);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * hop;
    let sum = 0;
    for (let i = 0; i < window; i += 1) {
      const sample = samples[start + i] ?? 0;
      sum += sample * sample;
    }
    out[frame] = Math.sqrt(sum / window);
  }
  return out;
}

const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const LAME_BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320];

export function nearestValue(value: number, choices: readonly number[]): number {
  return choices.reduce((best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best));
}

export function snapSampleRate(sampleRate: number): number {
  return nearestValue(sampleRate, LAME_RATES);
}

export function snapBitrate(bitrate: number): number {
  return nearestValue(bitrate, LAME_BITRATES);
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
  }
  return out;
}
