import { demucsCapability, type DemucsCapability } from "../capabilities";
import { clampSettings, type Settings } from "../presets";
import { decodeAudio } from "./decode";
import { separate } from "./demucs";
import {
  cancelCenter,
  eqTilt,
  injectSub,
  mixJitter,
  normalizePeak,
  padSilence,
  peakSmear,
  pitchShift,
  sideJitter,
  timeStretch,
} from "./dsp";
import { mp3RoundTrip } from "./mp3";
import { renderTone } from "./render";
import { detectVocals, mangleVocals, remixStems } from "./vocals";
import { encodeWav, outputFileName } from "./wav";

export interface ProgressUpdate {
  phase: string;
  message: string;
  fraction: number;
  subProgress: number;
}

export interface AnonymizeRequest {
  fileName: string;
  bytes: ArrayBuffer;
  presetId: string;
  settings: Partial<Settings>;
  signal?: AbortSignal;
  onProgress?: (update: ProgressUpdate) => void;
  demucs?: DemucsCapability;
}

export interface AnonymizeResult {
  fileName: string;
  wav: ArrayBuffer;
  notes: string[];
  log: string[];
}

const PHASES: Record<string, string> = {
  decoding: "Decoding source audio",
  detecting: "Detecting vocal presence",
  loadingModel: "Loading and verifying separation model",
  separating: "Separating audio stems",
  manglingVocal: "Mangling vocal formants and phoneme cues",
  remixing: "Remixing processed stems",
  instrumentalizing: "Removing centered vocal content",
  pitching: "Shifting pitch",
  speed: "Adjusting tempo",
  mixJittering: "Applying full-mix jitter",
  msJittering: "Applying side-channel jitter",
  eqTilting: "Reshaping spectral balance",
  peakSmearing: "Moving spectral peaks",
  filtering: "Rendering EQ, reverb, and sample rate",
  padding: "Padding the opening",
  dcInjecting: "Applying sub-audio variation",
  roundtripping: "Encoding and decoding through local MP3",
  normalizing: "Normalizing peak level",
  encoding: "Writing metadata-free WAV",
};

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function anonymize(request: AnonymizeRequest): Promise<AnonymizeResult> {
  const settings = clampSettings(request.settings);
  const signal = request.signal;
  const notes: string[] = [];
  const log: string[] = [];
  let planned: string[] = ["decoding"];
  let index = 0;

  const emit = (phase: string, message: string, subProgress = 0, persist = false) => {
    signal?.throwIfAborted();
    const fraction = Math.min(1, (index + Math.max(0, Math.min(1, subProgress))) / Math.max(1, planned.length));
    if (persist) log.push(message);
    request.onProgress?.({ phase, message, fraction, subProgress });
  };

  const complete = async (phase: string, message = PHASES[phase] ?? phase) => {
    emit(phase, message, 1, true);
    index += 1;
    await yieldFrame();
    signal?.throwIfAborted();
  };

  emit("decoding", PHASES.decoding, 0, true);
  let audio = await decodeAudio(request.bytes, request.fileName);
  const seconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  log.push(`Decoded ${audio.channels.length} ch, ${audio.sampleRate} Hz, ${seconds.toFixed(2)} s`);
  index += 1;

  const capability = request.demucs ?? demucsCapability();
  let mode = settings.instrumentalMode;
  let lyricBypass = settings.lyricBypass && !settings.instrumental && mode === "off";
  if (!capability.allowed && (mode === "hard" || (settings.lyricBypass && !settings.instrumental))) {
    const reason = capability.reason ?? "Demucs is unavailable on this device.";
    notes.push(reason);
    log.push(reason);
    if (mode === "hard") {
      mode = "light";
      const fallback = "Instrumental only: Hard fell back to Light centre-channel cancellation.";
      notes.push(fallback);
      log.push(fallback);
    }
    lyricBypass = false;
  }

  let hasVocals = !settings.instrumental;
  const detect = settings.autoDetectVocals && !settings.instrumental && mode === "off";
  if (detect) {
    planned = ["decoding", "detecting"];
    const detection = detectVocals(audio.channels, audio.sampleRate);
    hasVocals = detection.hasVocals;
    const message = detection.hasVocals
      ? `Vocal detected (score ${detection.score.toFixed(2)})`
      : `No vocal detected (score ${detection.score.toFixed(2)}); lyric bypass skipped`;
    await complete("detecting", message);
    if (!hasVocals) lyricBypass = false;
  }

  planned = ["decoding"];
  if (detect) planned.push("detecting");
  if (mode === "hard") planned.push("loadingModel", "separating", "instrumentalizing");
  else if (mode === "light") planned.push("instrumentalizing");
  else if (lyricBypass && hasVocals) planned.push("loadingModel", "separating", "manglingVocal", "remixing");
  if (settings.pitchSemitones !== 0) planned.push("pitching");
  if (settings.speedFactor !== 1) planned.push("speed");
  if (settings.mixJitterCents > 0 && settings.mixJitterHz > 0) planned.push("mixJittering");
  if (settings.midSideJitterCents > 0 && settings.midSideJitterHz > 0) planned.push("msJittering");
  if (settings.eqTiltMaxDb > 0 && settings.eqTiltBands > 0) planned.push("eqTilting");
  if (settings.peakSmearBands > 0 && settings.peakSmearDepthDb > 0 && settings.peakSmearHz > 0) planned.push("peakSmearing");
  if (settings.sampleRate !== null || settings.eqNotchHz !== null || settings.reverbWetPct > 0) planned.push("filtering");
  if (settings.silencePadSec > 0) planned.push("padding");
  if (settings.dcInjectSubHz > 0) planned.push("dcInjecting");
  if (settings.mp3RoundTripBitrate !== null) planned.push("roundtripping");
  if (settings.normalize) planned.push("normalizing");
  planned.push("encoding");

  const separateWithProgress = (needsVocals: boolean) => {
    let chunksStarted = false;
    return separate(audio.channels, audio.sampleRate, {
      signal,
      yieldFrame,
      needsVocals,
      onModelProgress: (loaded, total) => {
        const sub = total > 0 ? loaded / total : 0;
        emit(
          "loadingModel",
          `Loading separation model · ${(loaded / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MiB`,
          sub,
          loaded === 0,
        );
      },
      onChunkProgress: (chunk, count) => {
        if (!chunksStarted) {
          index += 1;
          chunksStarted = true;
        }
        emit("separating", `Separating stems · chunk ${chunk}/${count}`, count > 0 ? chunk / count : 0, chunk === 1);
      },
    }).then((stems) => {
      if (!chunksStarted) index += 1;
      index += 1;
      return stems;
    });
  };

  if (mode === "hard") {
    emit("loadingModel", PHASES.loadingModel, 0, true);
    const stems = await separateWithProgress(false);
    audio = { channels: remixStems(stems.instrumental, null, signal), sampleRate: stems.sampleRate };
    await complete("instrumentalizing");
  } else if (mode === "light") {
    audio = { ...audio, channels: cancelCenter(audio.channels) };
    await complete("instrumentalizing");
  } else if (lyricBypass && hasVocals) {
    emit("loadingModel", PHASES.loadingModel, 0, true);
    const stems = await separateWithProgress(true);
    if (!stems.vocals) throw new Error("Demucs returned no vocal stem.");
    const mangled = mangleVocals(stems.vocals, stems.sampleRate);
    await complete("manglingVocal");
    audio = { channels: remixStems(stems.instrumental, mangled, signal), sampleRate: stems.sampleRate };
    await complete("remixing");
  }

  if (settings.pitchSemitones !== 0) {
    audio = { ...audio, channels: audio.channels.map((channel) => pitchShift(channel, settings.pitchSemitones)) };
    await complete("pitching");
  }
  if (settings.speedFactor !== 1) {
    const ratio = 1 / settings.speedFactor;
    audio = { ...audio, channels: audio.channels.map((channel) => timeStretch(channel, ratio)) };
    await complete("speed");
  }
  if (settings.mixJitterCents > 0 && settings.mixJitterHz > 0) {
    audio = {
      ...audio,
      channels: mixJitter(audio.channels, audio.sampleRate, settings.mixJitterCents, settings.mixJitterHz),
    };
    await complete("mixJittering");
  }
  if (settings.midSideJitterCents > 0 && settings.midSideJitterHz > 0) {
    audio = {
      ...audio,
      channels: sideJitter(audio.channels, audio.sampleRate, settings.midSideJitterCents, settings.midSideJitterHz),
    };
    await complete("msJittering");
  }
  if (settings.eqTiltMaxDb > 0 && settings.eqTiltBands > 0) {
    const seed = 659918 ^ Math.round(settings.eqTiltMaxDb * 1000);
    audio = {
      ...audio,
      channels: eqTilt(audio.channels, audio.sampleRate, settings.eqTiltBands, settings.eqTiltMaxDb, seed),
    };
    await complete("eqTilting");
  }
  if (settings.peakSmearBands > 0 && settings.peakSmearDepthDb > 0 && settings.peakSmearHz > 0) {
    audio = {
      ...audio,
      channels: peakSmear(
        audio.channels,
        audio.sampleRate,
        settings.peakSmearBands,
        settings.peakSmearDepthDb,
        settings.peakSmearHz,
      ),
    };
    await complete("peakSmearing");
  }
  if (settings.sampleRate !== null || settings.eqNotchHz !== null || settings.reverbWetPct > 0) {
    audio = await renderTone({
      channels: audio.channels,
      sourceSampleRate: audio.sampleRate,
      targetSampleRate: settings.sampleRate ?? audio.sampleRate,
      eqNotchHz: settings.eqNotchHz,
      reverbWetPct: settings.reverbWetPct,
    });
    await complete("filtering");
  }
  if (settings.silencePadSec > 0) {
    audio = { ...audio, channels: padSilence(audio.channels, audio.sampleRate, settings.silencePadSec) };
    await complete("padding");
  }
  if (settings.dcInjectSubHz > 0) {
    audio = {
      ...audio,
      channels: injectSub(audio.channels, audio.sampleRate, settings.dcInjectSubHz, settings.dcInjectGainDb),
    };
    await complete("dcInjecting");
  }
  if (settings.mp3RoundTripBitrate !== null && settings.mp3RoundTripBitrate > 0) {
    const rounded = await mp3RoundTrip(audio.channels, audio.sampleRate, {
      bitrateKbps: settings.mp3RoundTripBitrate,
      useVbr: settings.mp3UseVbr,
      signal,
      yieldFrame,
      onProgress: (fraction) => emit("roundtripping", `MP3 round-trip · ${settings.mp3RoundTripBitrate} kbps`, fraction),
    });
    if (rounded.skipped) {
      const message = "The MP3 step was skipped.";
      notes.push(message);
      log.push(message);
    }
    audio = { channels: rounded.channels, sampleRate: rounded.sampleRate };
    await complete("roundtripping");
  }
  if (settings.normalize) {
    audio = { ...audio, channels: normalizePeak(audio.channels) };
    await complete("normalizing");
  }
  const wav = encodeWav(audio.channels, audio.sampleRate);
  await complete("encoding");
  return {
    fileName: outputFileName(request.fileName, request.presetId),
    wav,
    notes,
    log,
  };
}
