export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const blockAlign = channelCount * 2;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  let offset = 0;
  const writeText = (text: string) => {
    for (const char of text) {
      view.setUint8(offset, char.charCodeAt(0));
      offset += 1;
    }
  };
  const writeU32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const writeU16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  writeText("RIFF");
  writeU32(36 + dataBytes);
  writeText("WAVE");
  writeText("fmt ");
  writeU32(16);
  writeU16(1);
  writeU16(channelCount);
  writeU32(sampleRate);
  writeU32(sampleRate * blockAlign);
  writeU16(blockAlign);
  writeU16(16);
  writeText("data");
  writeU32(dataBytes);
  let cursor = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0));
      view.setInt16(cursor, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
      cursor += 2;
    }
  }
  return buffer;
}

export function outputFileName(sourceName: string, presetId: string): string {
  const stem =
    sourceName
      .replace(/\.[^/.]+$/, "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[-_.\s]+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase() || "processed_audio";
  const preset = ["subtle", "moderate", "aggressive", "instrumental", "speedup"].includes(presetId)
    ? presetId
    : "custom";
  return `${stem}_${preset}.wav`;
}

export function sniffContainer(bytes: Uint8Array): string {
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)));
  if (text(0, 4) === "RIFF") return "WAV";
  if (text(0, 4) === "fLaC") return "FLAC";
  if (text(0, 4) === "OggS") return "Ogg";
  if (text(0, 4) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "MP3";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "WebM";
  if (text(4, 4) === "ftyp") return "M4A";
  return "unknown";
}

export function headerHex(bytes: Uint8Array, count = 8): string {
  return Array.from(bytes.subarray(0, Math.min(count, bytes.length)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
