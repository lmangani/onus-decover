import { describe, expect, it } from "vitest";
import { stripKnownContainer } from "../src/audio/metadata";

describe("metadata stripping", () => {
  it("removes ID3v2 and ID3v1 without touching the MP3 frames", () => {
    const frame = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33, 0x44]);
    const title = textFrame("TIT2", "Hello");
    const tag = id3v2(title);
    const v1 = new Uint8Array(128);
    v1.set(ascii("TAGArtist"), 0);
    const file = concat([tag, frame, v1]);
    const stripped = stripKnownContainer(file, "mp3");
    expect(stripped).not.toBeNull();
    expect(Array.from(stripped!.bytes)).toEqual(Array.from(frame));
    expect(stripped!.removed.some((line) => line.includes("Hello"))).toBe(true);
    expect(stripped!.removed.some((line) => line.includes("Artist"))).toBe(true);
    expect(stripped!.extension).toBe("mp3");
  });

  it("drops WAV LIST metadata and keeps the sample bytes", () => {
    const fmt = wavChunk("fmt ", new Uint8Array(16));
    const info = ascii("INFO");
    const name = wavChunk("INAM", ascii("Suno title\0"));
    const list = wavChunk("LIST", concat([info, name]));
    const samples = Uint8Array.from([1, 2, 3, 4]);
    const data = wavChunk("data", samples);
    const payload = concat([fmt, list, data]);
    const file = new Uint8Array(12 + payload.length);
    file.set(ascii("RIFF"), 0);
    new DataView(file.buffer).setUint32(4, 4 + payload.length, true);
    file.set(ascii("WAVE"), 8);
    file.set(payload, 12);
    const stripped = stripKnownContainer(file, "wav")!;
    const text = new TextDecoder().decode(stripped.bytes);
    expect(text.includes("LIST")).toBe(false);
    expect(text.includes("Suno")).toBe(false);
    expect(Array.from(stripped.bytes.slice(-4))).toEqual([1, 2, 3, 4]);
    expect(stripped.removed.some((line) => line.includes("Suno title"))).toBe(true);
  });

  it("removes a FLAC comment and marks the last metadata block", () => {
    const stream = new Uint8Array(34);
    const commentBody = vorbisComment(["TITLE=Secret"]);
    const comment = flacBlock(4, commentBody, true);
    const info = flacBlock(0, stream, false);
    const file = concat([ascii("fLaC"), info, comment, Uint8Array.from([9, 9, 9])]);
    const stripped = stripKnownContainer(file, "flac")!;
    expect(new TextDecoder().decode(stripped.bytes).includes("Secret")).toBe(false);
    expect(stripped.bytes[4] & 0x80).toBe(0x80);
    expect(Array.from(stripped.bytes.slice(-3))).toEqual([9, 9, 9]);
    expect(stripped.removed.some((line) => line.includes("TITLE=Secret"))).toBe(true);
  });

  it("removes an M4A user-data atom and rewrites chunk offsets", () => {
    const ftyp = atom("ftyp", ascii("M4A \0\0\0\0M4A "));
    const udta = atom("udta", atom("©nam", dataText("Night")));
    const audio = ascii("AUDIO");
    const mdat = atom("mdat", audio);
    const moovSize = 8 + chunkOffsetAtom(0).length + udta.length;
    const payloadAt = ftyp.length + moovSize + 8;
    const file = concat([ftyp, atom("moov", concat([chunkOffsetAtom(payloadAt), udta])), mdat]);
    const stripped = stripKnownContainer(file, "m4a")!;
    expect(new TextDecoder("latin1").decode(stripped.bytes).includes("Night")).toBe(false);
    const offset = m4aChunkOffset(stripped.bytes);
    expect(new TextDecoder().decode(stripped.bytes.slice(offset, offset + 5))).toBe("AUDIO");
    expect(stripped.removed.some((line) => line.includes("Night"))).toBe(true);
  });
});

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function textFrame(id: string, value: string): Uint8Array {
  const body = concat([Uint8Array.of(0), ascii(value)]);
  const frame = new Uint8Array(10 + body.length);
  frame.set(ascii(id), 0);
  new DataView(frame.buffer).setUint32(4, body.length);
  frame.set(body, 10);
  return frame;
}

function id3v2(frames: Uint8Array): Uint8Array {
  const tag = new Uint8Array(10 + frames.length);
  tag.set(ascii("ID3"), 0);
  tag[3] = 3;
  const size = frames.length;
  tag[6] = (size >> 21) & 0x7f;
  tag[7] = (size >> 14) & 0x7f;
  tag[8] = (size >> 7) & 0x7f;
  tag[9] = size & 0x7f;
  tag.set(frames, 10);
  return tag;
}

function wavChunk(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(ascii(id), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function flacBlock(type: number, data: Uint8Array, last: boolean): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = type | (last ? 0x80 : 0);
  out[1] = (data.length >> 16) & 0xff;
  out[2] = (data.length >> 8) & 0xff;
  out[3] = data.length & 0xff;
  out.set(data, 4);
  return out;
}

function vorbisComment(lines: string[]): Uint8Array {
  const vendor = ascii("test");
  const parts = [u32(vendor.length), vendor, u32(lines.length)];
  for (const line of lines) {
    const bytes = ascii(line);
    parts.push(u32(bytes.length), bytes);
  }
  return concat(parts);
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function atom(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

function dataText(value: string): Uint8Array {
  const text = ascii(value);
  const payload = new Uint8Array(8 + text.length);
  new DataView(payload.buffer).setUint32(0, 1);
  payload.set(text, 8);
  return atom("data", payload);
}

function chunkOffsetAtom(offset: number): Uint8Array {
  const body = new Uint8Array(12);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1);
  view.setUint32(8, offset);
  return atom("stco", body);
}

function m4aChunkOffset(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  const at = text.indexOf("stco");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at + 12);
}
