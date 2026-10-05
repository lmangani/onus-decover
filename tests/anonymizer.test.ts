import { describe, expect, it } from "vitest";
import { demucsCapability } from "../src/capabilities";
import { cancelCenter, pitchShift, timeStretch } from "../src/audio/dsp";
import { detectVocals } from "../src/audio/vocals";
import { encodeWav, outputFileName } from "../src/audio/wav";
import { clampSettings, presetSettings } from "../src/presets";

describe("presets", () => {
  it("clamps out-of-range settings back into the control limits", () => {
    const settings = clampSettings({
      instrumentalMode: "nope" as "off",
      pitchSemitones: 99,
      speedFactor: 9,
      mp3RoundTripBitrate: 10,
      sampleRate: null,
      eqNotchHz: "" as unknown as null,
    });
    expect(settings.instrumentalMode).toBe("off");
    expect(settings.pitchSemitones).toBe(12);
    expect(settings.speedFactor).toBe(2);
    expect(settings.mp3RoundTripBitrate).toBe(32);
    expect(settings.sampleRate).toBeNull();
    expect(settings.eqNotchHz).toBeNull();
  });

  it("matches the published preset starting points", () => {
    expect(presetSettings("subtle")).toMatchObject({
      pitchSemitones: -1,
      speedFactor: 1.01,
      normalize: true,
      mp3RoundTripBitrate: 192,
      lyricBypass: false,
    });
    expect(presetSettings("moderate")).toMatchObject({
      pitchSemitones: -2,
      speedFactor: 0.95,
      sampleRate: 48000,
      reverbWetPct: 15,
      silencePadSec: 0.5,
      autoDetectVocals: true,
      lyricBypass: true,
      mp3RoundTripBitrate: 128,
      eqTiltMaxDb: 1.5,
      eqTiltBands: 6,
      mixJitterCents: 10,
      mixJitterHz: 0.3,
      midSideJitterCents: 8,
      midSideJitterHz: 0.25,
    });
    expect(presetSettings("aggressive")).toMatchObject({
      pitchSemitones: -4,
      speedFactor: 0.93,
      eqNotchHz: 300,
      reverbWetPct: 25,
      mp3RoundTripBitrate: 96,
      mp3UseVbr: true,
      peakSmearBands: 5,
      peakSmearDepthDb: 2.5,
      peakSmearHz: 0.15,
      dcInjectSubHz: 7,
      dcInjectGainDb: -55,
    });
    expect(presetSettings("instrumental")).toMatchObject({
      instrumentalMode: "light",
      pitchSemitones: 2,
      speedFactor: 1.12,
      sampleRate: 44100,
      mp3RoundTripBitrate: 192,
    });
    expect(presetSettings("speedup", 125)).toMatchObject({
      pitchSemitones: 0,
      speedFactor: 1.25,
      reverbWetPct: 0,
      mp3RoundTripBitrate: null,
      lyricBypass: false,
      normalize: false,
    });
  });
});

describe("dsp", () => {
  it("keeps pitch-shifted audio the same length", () => {
    const input = new Float32Array(4000);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 12);
    expect(pitchShift(input, -1)).toHaveLength(input.length);
    expect(pitchShift(input, 0)).toEqual(input);
  });

  it("cancels the center of a stereo pair", () => {
    const left = Float32Array.from([1, 0.5, -1]);
    const right = Float32Array.from([0, 0.5, 1]);
    const [outLeft, outRight] = cancelCenter([left, right]);
    expect(Array.from(outLeft)).toEqual([0.5, 0, -1]);
    expect(Array.from(outRight)).toEqual([-0.5, -0, 1]);
  });

  it("leaves time stretch unchanged at ratio 1", () => {
    const input = Float32Array.from([0.1, -0.2, 0.3, 0.4]);
    expect(Array.from(timeStretch(input, 1))).toEqual(Array.from(input));
  });
});

describe("vocals", () => {
  it("scores a centered mid tone as vocal and silence as not", () => {
    const sampleRate = 16000;
    const tone = new Float32Array(sampleRate);
    for (let i = 0; i < tone.length; i += 1) tone[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.5;
    const detected = detectVocals([tone, tone.slice()], sampleRate);
    expect(detected.score).toBeGreaterThanOrEqual(0.32);
    expect(detected.hasVocals).toBe(true);

    const silent = detectVocals([new Float32Array(sampleRate), new Float32Array(sampleRate)], sampleRate);
    expect(silent.score).toBeLessThan(0.32);
    expect(silent.hasVocals).toBe(false);
  });
});

describe("wav", () => {
  it("writes a metadata-free PCM header", () => {
    const channel = Float32Array.from([0.5, -0.5]);
    const buffer = encodeWav([channel], 8000);
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder().decode(bytes.slice(0, 44));
    expect(text.slice(0, 4)).toBe("RIFF");
    expect(text.slice(8, 12)).toBe("WAVE");
    expect(text.slice(12, 16)).toBe("fmt ");
    expect(text.slice(36, 40)).toBe("data");
    expect(text.includes("LIST")).toBe(false);
    expect(text.includes("INFO")).toBe(false);
    expect(buffer.byteLength).toBe(44 + 4);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(16384);
    expect(view.getInt16(46, true)).toBe(-16384);
  });

  it("names the download from the preset", () => {
    expect(outputFileName("My Song.mp3", "moderate")).toBe("my_song_moderate.wav");
    expect(outputFileName("track.wav", "custom")).toBe("track_custom.wav");
  });
});

describe("demucs capability", () => {
  it("allows a desktop with at least 4 GB and skips phones and low memory", () => {
    expect(demucsCapability({ userAgent: "Mozilla/5.0 Macintosh", deviceMemory: 8, maxTouchPoints: 0 }).allowed).toBe(true);
    expect(demucsCapability({ userAgent: "Mozilla/5.0 Macintosh", maxTouchPoints: 0 }).allowed).toBe(true);
    expect(demucsCapability({ userAgent: "Mozilla/5.0 iPhone", deviceMemory: 8, maxTouchPoints: 5 }).allowed).toBe(false);
    expect(demucsCapability({ userAgent: "Mozilla/5.0 Macintosh", deviceMemory: 2, maxTouchPoints: 0 }).reason).toMatch(/4 GB/);
  });
});
