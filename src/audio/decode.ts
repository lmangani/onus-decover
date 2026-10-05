import { headerHex, sniffContainer } from "./wav";

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

export async function decodeAudio(bytes: ArrayBuffer, fileName: string): Promise<DecodedAudio> {
  const copy = bytes.slice(0);
  try {
    const context = new OfflineAudioContext(1, 1, 44100);
    const decoded = await context.decodeAudioData(copy);
    if (decoded.length === 0 || decoded.numberOfChannels === 0) {
      throw new Error("The decoded source contains no audio frames.");
    }
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => new Float32Array(decoded.getChannelData(index)));
    const frames = channels[0].length;
    if (channels.some((channel) => channel.length !== frames)) {
      throw new Error("Every decoded audio channel must have the same length.");
    }
    if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0) {
      throw new Error("The decoded audio sample rate is invalid.");
    }
    return { channels, sampleRate: decoded.sampleRate };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const header = new Uint8Array(bytes.slice(0, 16));
    const container = sniffContainer(header);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not decode this audio (${container}, header ${headerHex(header)}). ${fileName}. ${detail}`);
  }
}
