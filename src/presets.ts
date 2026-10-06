export type InstrumentalMode = "off" | "light" | "hard";

export interface Settings {
  instrumentalMode: InstrumentalMode;
  pitchSemitones: number;
  speedFactor: number;
  sampleRate: number | null;
  eqNotchHz: number | null;
  reverbWetPct: number;
  silencePadSec: number;
  normalize: boolean;
  instrumental: boolean;
  autoDetectVocals: boolean;
  lyricBypass: boolean;
  mp3RoundTripBitrate: number | null;
  eqTiltMaxDb: number;
  eqTiltBands: number;
  mixJitterCents: number;
  mixJitterHz: number;
  midSideJitterCents: number;
  midSideJitterHz: number;
  peakSmearBands: number;
  peakSmearDepthDb: number;
  peakSmearHz: number;
  dcInjectSubHz: number;
  dcInjectGainDb: number;
  mp3UseVbr: boolean;
}

export type PresetId = "subtle" | "moderate" | "aggressive" | "instrumental" | "speedup";

export const SPEED_UP_PERCENTS = [110, 120, 125, 133, 150] as const;
export const SPEED_UP_DEFAULT = 125;

export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const WARN_FILE_BYTES = 80 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac", "webm"] as const;

export const DEFAULT_SETTINGS: Settings = {
  instrumentalMode: "off",
  pitchSemitones: 0,
  speedFactor: 1,
  sampleRate: null,
  eqNotchHz: null,
  reverbWetPct: 0,
  silencePadSec: 0,
  normalize: false,
  instrumental: false,
  autoDetectVocals: false,
  lyricBypass: false,
  mp3RoundTripBitrate: null,
  eqTiltMaxDb: 0,
  eqTiltBands: 0,
  mixJitterCents: 0,
  mixJitterHz: 0,
  midSideJitterCents: 0,
  midSideJitterHz: 0,
  peakSmearBands: 0,
  peakSmearDepthDb: 0,
  peakSmearHz: 0,
  dcInjectSubHz: 0,
  dcInjectGainDb: -60,
  mp3UseVbr: false,
};

const MODERATE: Partial<Settings> = {
  pitchSemitones: -2,
  speedFactor: 0.95,
  sampleRate: 48000,
  reverbWetPct: 15,
  silencePadSec: 0.5,
  normalize: true,
  autoDetectVocals: true,
  lyricBypass: true,
  mp3RoundTripBitrate: 128,
  eqTiltMaxDb: 1.5,
  eqTiltBands: 6,
  mixJitterCents: 10,
  mixJitterHz: 0.3,
  midSideJitterCents: 8,
  midSideJitterHz: 0.25,
};

const PRESET_PARTIALS: Record<Exclude<PresetId, "speedup">, Partial<Settings>> = {
  subtle: {
    pitchSemitones: -1,
    speedFactor: 1.01,
    normalize: true,
    mp3RoundTripBitrate: 192,
  },
  moderate: MODERATE,
  aggressive: {
    pitchSemitones: -4,
    speedFactor: 0.93,
    sampleRate: 48000,
    eqNotchHz: 300,
    reverbWetPct: 25,
    silencePadSec: 0.5,
    normalize: true,
    autoDetectVocals: true,
    lyricBypass: true,
    mp3RoundTripBitrate: 96,
    eqTiltMaxDb: 2.5,
    eqTiltBands: 7,
    mixJitterCents: 15,
    mixJitterHz: 0.4,
    midSideJitterCents: 12,
    midSideJitterHz: 0.35,
    peakSmearBands: 5,
    peakSmearDepthDb: 2.5,
    peakSmearHz: 0.15,
    dcInjectSubHz: 7,
    dcInjectGainDb: -55,
    mp3UseVbr: true,
  },
  instrumental: {
    instrumentalMode: "light",
    pitchSemitones: 2,
    speedFactor: 1.12,
    sampleRate: 44100,
    normalize: true,
    mp3RoundTripBitrate: 192,
  },
};

export const PRESET_COPY: Record<PresetId, string> = {
  subtle: "Pitch down 1 semitone, 1% faster, 192 kbps MP3 round-trip.",
  moderate:
    "Pitch down 2 semitones, 95% speed, 15% reverb, 48 kHz, slow pitch wobble, EQ tilt, and 128 kbps MP3 round-trip. Vocal detection and lyric bypass are enabled.",
  aggressive:
    "Pitch down 4 semitones, 93% speed, 25% reverb, a 300 Hz notch, stronger wobble and EQ tilt, and 96 kbps MP3 round-trip. Vocal detection and lyric bypass are enabled.",
  instrumental:
    "Light centre-channel cancel, pitch up 2 semitones, tempo 112%, 44.1 kHz, and a 192 kbps MP3 round-trip.",
  speedup: "Tempo only. Pitch stays put, and nothing else is applied.",
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNullable(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  return clampNumber(value, fallback, min, max);
}

export function clampSettings(input: Partial<Settings> = {}): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  const mode = merged.instrumentalMode;
  return {
    instrumentalMode: mode === "light" || mode === "hard" || mode === "off" ? mode : "off",
    pitchSemitones: clampNumber(merged.pitchSemitones, 0, -12, 12),
    speedFactor: clampNumber(merged.speedFactor, 1, 0.5, 2),
    sampleRate: clampNullable(merged.sampleRate, 48000, 8000, 96000),
    eqNotchHz: clampNullable(merged.eqNotchHz, 300, 50, 20000),
    reverbWetPct: clampNumber(merged.reverbWetPct, 0, 0, 100),
    silencePadSec: clampNumber(merged.silencePadSec, 0, 0, 10),
    normalize: Boolean(merged.normalize),
    instrumental: Boolean(merged.instrumental),
    autoDetectVocals: Boolean(merged.autoDetectVocals),
    lyricBypass: Boolean(merged.lyricBypass),
    mp3RoundTripBitrate: clampNullable(merged.mp3RoundTripBitrate, 128, 32, 320),
    eqTiltMaxDb: clampNumber(merged.eqTiltMaxDb, 0, 0, 6),
    eqTiltBands: clampNumber(merged.eqTiltBands, 0, 0, 12),
    mixJitterCents: clampNumber(merged.mixJitterCents, 0, 0, 50),
    mixJitterHz: clampNumber(merged.mixJitterHz, 0, 0, 5),
    midSideJitterCents: clampNumber(merged.midSideJitterCents, 0, 0, 50),
    midSideJitterHz: clampNumber(merged.midSideJitterHz, 0, 0, 5),
    peakSmearBands: clampNumber(merged.peakSmearBands, 0, 0, 12),
    peakSmearDepthDb: clampNumber(merged.peakSmearDepthDb, 0, 0, 6),
    peakSmearHz: clampNumber(merged.peakSmearHz, 0, 0, 2),
    dcInjectSubHz: clampNumber(merged.dcInjectSubHz, 0, 0, 20),
    dcInjectGainDb: clampNumber(merged.dcInjectGainDb, -60, -90, -30),
    mp3UseVbr: Boolean(merged.mp3UseVbr),
  };
}

export function presetSettings(id: PresetId, speedPercent = SPEED_UP_DEFAULT): Settings {
  if (id === "speedup") {
    return clampSettings({ speedFactor: speedPercent / 100 });
  }
  return clampSettings(PRESET_PARTIALS[id]);
}

export function nearestSpeedUpPercent(speedFactor: number): number {
  const percent = speedFactor * 100;
  return SPEED_UP_PERCENTS.reduce((best, candidate) =>
    Math.abs(candidate - percent) < Math.abs(best - percent) ? candidate : best,
  );
}

export type NumberKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

export type NullableNumberKey = {
  [K in keyof Settings]: null extends Settings[K] ? (Settings[K] extends number | null ? K : never) : never;
}[keyof Settings];

export interface NumberControl {
  kind: "number";
  key: NumberKey | NullableNumberKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
  nullable?: boolean;
  scale?: number;
  placeholder?: string;
}

export interface CheckboxControl {
  kind: "checkbox";
  key: "normalize" | "instrumental" | "autoDetectVocals" | "lyricBypass" | "mp3UseVbr";
  label: string;
  hint?: string;
}

export interface SegmentedControl {
  kind: "segmented";
  key: "instrumentalMode";
  label: string;
  hint: string;
  options: { value: InstrumentalMode; label: string }[];
}

export type Control = NumberControl | CheckboxControl | SegmentedControl;

export interface ControlGroup {
  id: string;
  title: string;
  controls: Control[];
}

export const CONTROL_GROUPS: ControlGroup[] = [
  {
    id: "vocals",
    title: "Vocals",
    controls: [
      {
        kind: "segmented",
        key: "instrumentalMode",
        label: "Instrumental only",
        hint: "Light removes centered content locally. Hard separation needs Demucs.",
        options: [
          { value: "off", label: "Off" },
          { value: "light", label: "Light" },
          { value: "hard", label: "Hard" },
        ],
      },
      {
        kind: "checkbox",
        key: "instrumental",
        label: "This song is instrumental (no vocals)",
        hint: "Skips vocal detection and lyric bypass.",
      },
      {
        kind: "checkbox",
        key: "autoDetectVocals",
        label: "Auto-detect vocals before lyric bypass",
        hint: "Fast local heuristic. Skips the model when no vocal is detected.",
      },
      {
        kind: "checkbox",
        key: "lyricBypass",
        label: "Lyric-detection bypass (vocal stem mangle)",
        hint: "First use downloads and verifies the Demucs model, about 289 MiB.",
      },
    ],
  },
  {
    id: "time",
    title: "Pitch and time",
    controls: [
      {
        kind: "number",
        key: "pitchSemitones",
        label: "Pitch",
        min: -12,
        max: 12,
        step: 0.5,
        hint: "Semitones. Negative lowers the pitch.",
      },
      {
        kind: "number",
        key: "speedFactor",
        label: "Tempo",
        min: 50,
        max: 200,
        step: 1,
        scale: 100,
        hint: "Percent. 100 leaves the tempo unchanged.",
      },
      {
        kind: "number",
        key: "sampleRate",
        label: "Sample rate (Hz, blank = original)",
        min: 8000,
        max: 96000,
        step: 1000,
        nullable: true,
        placeholder: "original",
      },
      {
        kind: "number",
        key: "silencePadSec",
        label: "Silence pad (seconds)",
        min: 0,
        max: 10,
        step: 0.1,
      },
    ],
  },
  {
    id: "tone",
    title: "Tone",
    controls: [
      {
        kind: "number",
        key: "eqNotchHz",
        label: "EQ notch (Hz, blank = off)",
        min: 50,
        max: 20000,
        step: 10,
        nullable: true,
        placeholder: "off",
      },
      {
        kind: "number",
        key: "reverbWetPct",
        label: "Reverb wet (%)",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        kind: "number",
        key: "eqTiltMaxDb",
        label: "EQ tilt max ±dB (0 = off)",
        min: 0,
        max: 6,
        step: 0.5,
      },
      {
        kind: "number",
        key: "eqTiltBands",
        label: "EQ tilt bands (0 = off)",
        min: 0,
        max: 12,
        step: 1,
      },
      { kind: "checkbox", key: "normalize", label: "Normalize peak to 1.0" },
    ],
  },
  {
    id: "fingerprint",
    title: "Fingerprint",
    controls: [
      {
        kind: "number",
        key: "mp3RoundTripBitrate",
        label: "MP3 round-trip bitrate (kbps, blank = off)",
        min: 32,
        max: 320,
        step: 16,
        nullable: true,
        placeholder: "off",
        hint: "Local encode and decode through LameJS.",
      },
      {
        kind: "checkbox",
        key: "mp3UseVbr",
        label: "MP3 round-trip: VBR mode",
        hint: "Raises the bitrate target by 15% and snaps to the nearest standard rate.",
      },
      {
        kind: "number",
        key: "mixJitterCents",
        label: "Full-mix pitch jitter (cents)",
        min: 0,
        max: 50,
        step: 1,
      },
      { kind: "number", key: "mixJitterHz", label: "Jitter LFO (Hz)", min: 0, max: 5, step: 0.05 },
      {
        kind: "number",
        key: "midSideJitterCents",
        label: "Side-channel jitter (cents)",
        min: 0,
        max: 50,
        step: 1,
        hint: "Perturbs only the stereo difference channel.",
      },
      {
        kind: "number",
        key: "midSideJitterHz",
        label: "Side-channel jitter LFO (Hz)",
        min: 0,
        max: 5,
        step: 0.05,
      },
      {
        kind: "number",
        key: "peakSmearBands",
        label: "Peak smear bands (0 = off)",
        min: 0,
        max: 12,
        step: 1,
      },
      {
        kind: "number",
        key: "peakSmearDepthDb",
        label: "Peak smear depth (dB)",
        min: 0,
        max: 6,
        step: 0.5,
      },
      { kind: "number", key: "peakSmearHz", label: "Peak smear LFO (Hz)", min: 0, max: 2, step: 0.05 },
      { kind: "number", key: "dcInjectSubHz", label: "Sub-audio inject (Hz)", min: 0, max: 20, step: 1 },
      {
        kind: "number",
        key: "dcInjectGainDb",
        label: "Sub-audio inject gain (dB)",
        min: -90,
        max: -30,
        step: 1,
      },
    ],
  },
];
