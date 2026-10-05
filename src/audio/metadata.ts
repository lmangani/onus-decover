import { decodeAudio } from "./decode";
import { encodeWav } from "./wav";

export interface StripResult {
  bytes: ArrayBuffer;
  fileName: string;
  mime: string;
  removed: string[];
  rewritten: boolean;
}

interface ContainerStrip {
  bytes: Uint8Array;
  extension: string;
  mime: string;
  removed: string[];
}

const DROP_MP4 = new Set(["udta", "meta", "ilst"]);
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "moof", "traf", "mvex"]);

export async function stripMetadata(fileBytes: ArrayBuffer, fileName: string): Promise<StripResult> {
  const bytes = new Uint8Array(fileBytes);
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const direct = stripKnownContainer(bytes, extension);
  if (direct) {
    return {
      bytes: copyBuffer(direct.bytes),
      fileName: cleanedName(fileName, direct.extension),
      mime: direct.mime,
      removed: direct.removed,
      rewritten: false,
    };
  }
  const decoded = await decodeAudio(fileBytes, fileName);
  return {
    bytes: encodeWav(decoded.channels, decoded.sampleRate),
    fileName: cleanedName(fileName, "wav"),
    mime: "audio/wav",
    removed: ["Container tags were discarded by rewriting to a metadata-free WAV."],
    rewritten: true,
  };
}

export function stripKnownContainer(bytes: Uint8Array, extension: string): ContainerStrip | null {
  if (isWav(bytes)) return { ...stripWav(bytes), extension: "wav", mime: "audio/wav" };
  if (isFlac(bytes)) return { ...stripFlac(bytes), extension: "flac", mime: "audio/flac" };
  if (isMp4(bytes)) {
    const stripped = stripMp4(bytes);
    const ext = extension === "mp4" ? "mp4" : "m4a";
    return { ...stripped, extension: ext, mime: "audio/mp4" };
  }
  if (isMp3(bytes, extension)) return { ...stripMp3(bytes), extension: "mp3", mime: "audio/mpeg" };
  return null;
}

function stripMp3(bytes: Uint8Array): { bytes: Uint8Array; removed: string[] } {
  let start = 0;
  let end = bytes.length;
  const removed: string[] = [];
  const id3 = id3v2Length(bytes, 0);
  if (id3) {
    removed.push(...describeId3v2(bytes.subarray(0, id3)));
    start = id3;
  }
  if (hasId3v1(bytes, end)) {
    removed.push(...describeId3v1(bytes.subarray(end - 128, end)));
    end -= 128;
  }
  const ape = apeLength(bytes, start, end);
  if (ape) {
    removed.push("APEv2 tag");
    if (ape.fromStart) start += ape.length;
    else end -= ape.length;
  }
  return { bytes: bytes.slice(start, end), removed };
}

function stripWav(bytes: Uint8Array): { bytes: Uint8Array; removed: string[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [];
  const removed: string[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataEnd = offset + 8 + size;
    if (dataEnd > bytes.length) break;
    const paddedEnd = Math.min(bytes.length, dataEnd + (size & 1));
    if (id === "fmt " || id === "data") kept.push(bytes.slice(offset, paddedEnd));
    else removed.push(...describeWavChunk(bytes.subarray(offset + 8, dataEnd), id));
    offset = paddedEnd;
  }
  const payload = concat(kept);
  const out = new Uint8Array(12 + payload.length);
  const outView = new DataView(out.buffer);
  writeAscii(out, 0, "RIFF");
  outView.setUint32(4, 4 + payload.length, true);
  writeAscii(out, 8, "WAVE");
  out.set(payload, 12);
  return { bytes: out, removed };
}

function stripFlac(bytes: Uint8Array): { bytes: Uint8Array; removed: string[] } {
  const removed: string[] = [];
  const kept: Uint8Array[] = [];
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const blockEnd = offset + 4 + length;
    if (blockEnd > bytes.length) break;
    const block = bytes.slice(offset, blockEnd);
    if (type === 4) removed.push(...describeVorbisComment(bytes.subarray(offset + 4, blockEnd)));
    else if (type === 6) removed.push("FLAC picture");
    else if (type === 1) removed.push("FLAC padding");
    else kept.push(block);
    offset = blockEnd;
    if (isLast) break;
  }
  if (kept.length === 0) return { bytes: bytes.slice(), removed };
  for (let index = 0; index < kept.length; index += 1) {
    if (index === kept.length - 1) kept[index][0] |= 0x80;
    else kept[index][0] &= 0x7f;
  }
  return { bytes: concat([bytes.slice(0, 4), ...kept, bytes.slice(offset)]), removed };
}

function stripMp4(bytes: Uint8Array): { bytes: Uint8Array; removed: string[] } {
  const removed: string[] = [];
  const shifts: { oldStart: number; oldEnd: number; delta: number }[] = [];
  const parts: Uint8Array[] = [];
  let old = 0;
  let neu = 0;
  while (old + 8 <= bytes.length) {
    const atom = readAtom(bytes, old, bytes.length);
    if (!atom) break;
    if (DROP_MP4.has(atom.type)) {
      removed.push(...describeMp4(bytes, atom.start + atom.header, atom.start + atom.size, atom.type));
      old += atom.size;
      continue;
    }
    let chunk: Uint8Array;
    if (MP4_CONTAINERS.has(atom.type)) {
      const inner = rewriteMp4(bytes, atom.start + atom.header, atom.start + atom.size, removed);
      chunk = wrapAtom(atom.type, inner);
    } else {
      chunk = bytes.slice(atom.start, atom.start + atom.size);
    }
    shifts.push({ oldStart: old, oldEnd: old + atom.size, delta: neu - old });
    parts.push(chunk);
    neu += chunk.length;
    old += atom.size;
  }
  if (old < bytes.length) parts.push(bytes.slice(old));
  const out = concat(parts);
  patchChunkOffsets(out, shifts);
  return { bytes: out, removed };
}

function rewriteMp4(bytes: Uint8Array, start: number, end: number, removed: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const atom = readAtom(bytes, offset, end);
    if (!atom) break;
    if (DROP_MP4.has(atom.type)) {
      removed.push(...describeMp4(bytes, atom.start + atom.header, atom.start + atom.size, atom.type));
    } else if (MP4_CONTAINERS.has(atom.type)) {
      parts.push(wrapAtom(atom.type, rewriteMp4(bytes, atom.start + atom.header, atom.start + atom.size, removed)));
    } else {
      parts.push(bytes.slice(atom.start, atom.start + atom.size));
    }
    offset += atom.size;
  }
  if (offset < end) parts.push(bytes.slice(offset, end));
  return concat(parts);
}

function patchChunkOffsets(bytes: Uint8Array, shifts: { oldStart: number; oldEnd: number; delta: number }[]) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const visit = (start: number, end: number) => {
    let offset = start;
    while (offset + 8 <= end) {
      const atom = readAtom(bytes, offset, end);
      if (!atom) break;
      const content = atom.start + atom.header;
      if (atom.type === "stco" || atom.type === "co64") {
        if (content + 8 <= atom.start + atom.size) {
          const count = view.getUint32(content + 4);
          const wide = atom.type === "co64";
          for (let index = 0; index < count; index += 1) {
            const at = content + 8 + index * (wide ? 8 : 4);
            if (at + (wide ? 8 : 4) > atom.start + atom.size) break;
            const value = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
            const shifted = value + shiftFor(value, shifts);
            if (wide) view.setBigUint64(at, BigInt(shifted));
            else view.setUint32(at, shifted);
          }
        }
      } else if (MP4_CONTAINERS.has(atom.type) || atom.type === "moov") {
        visit(content, atom.start + atom.size);
      }
      offset += atom.size;
    }
  };
  visit(0, bytes.length);
}

function shiftFor(offset: number, shifts: { oldStart: number; oldEnd: number; delta: number }[]): number {
  for (const region of shifts) {
    if (offset >= region.oldStart && offset < region.oldEnd) return region.delta;
  }
  return 0;
}

interface Atom {
  start: number;
  size: number;
  header: number;
  type: string;
}

function readAtom(bytes: Uint8Array, offset: number, limit: number): Atom | null {
  if (offset + 8 > limit) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset);
  let header = 8;
  const type = ascii(bytes, offset + 4, 4);
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const wide = view.getBigUint64(offset + 8);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(wide);
    header = 16;
  } else if (size === 0) size = limit - offset;
  if (size < header || offset + size > limit) return null;
  return { start: offset, size, header, type };
}

function wrapAtom(type: string, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + content.length);
  new DataView(out.buffer).setUint32(0, out.length);
  writeAscii(out, 4, type);
  out.set(content, 8);
  return out;
}

function describeMp4(bytes: Uint8Array, start: number, end: number, type: string): string[] {
  const found = collectIlst(bytes, start, end);
  if (found.length > 0) return found;
  return [`MP4 ${type} atom`];
}

function collectIlst(bytes: Uint8Array, start: number, end: number): string[] {
  const labels: Record<string, string> = {
    "©nam": "title",
    "©ART": "artist",
    aART: "album artist",
    "©alb": "album",
    "©cmt": "comment",
    "©day": "year",
    "©gen": "genre",
    "©lyr": "lyrics",
    "©wrt": "writer",
    desc: "description",
    ldes: "description",
    cprt: "copyright",
    covr: "cover image",
  };
  const lines: string[] = [];
  const visit = (from: number, to: number) => {
    let offset = from;
    while (offset + 8 <= to) {
      const atom = readAtom(bytes, offset, to);
      if (!atom) break;
      const label = labels[atom.type];
      if (label) {
        const text = readMp4Text(bytes, atom);
        lines.push(text ? `MP4 ${label}: ${text}` : `MP4 ${label}`);
      } else if (atom.type !== "data" && atom.type !== "mdat") {
        visit(atom.start + atom.header, atom.start + atom.size);
      }
      offset += atom.size;
    }
  };
  visit(start, end);
  return lines;
}

function readMp4Text(bytes: Uint8Array, atom: Atom): string {
  if (atom.type === "covr") return "";
  let offset = atom.start + atom.header;
  const end = atom.start + atom.size;
  const data = readAtom(bytes, offset, end);
  const payload = data && data.type === "data" ? bytes.subarray(data.start + data.header, data.start + data.size) : bytes.subarray(offset, end);
  if (payload.length < 8) return "";
  const type = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
  if (type !== 1) return "";
  return utf8(payload.subarray(8)).trim();
}

function describeId3v2(tag: Uint8Array): string[] {
  if (tag.length < 10 || tag[3] === 2) return ["ID3v2 tag"];
  const version = tag[3];
  const view = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
  let offset = 10;
  const lines: string[] = [];
  const names: Record<string, string> = {
    TIT2: "title",
    TPE1: "artist",
    TPE2: "album artist",
    TALB: "album",
    TCON: "genre",
    TYER: "year",
    TDRC: "year",
    COMM: "comment",
    TXXX: "text",
    USLT: "lyrics",
    TPUB: "publisher",
    TCOP: "copyright",
    TCOM: "composer",
  };
  while (offset + 10 <= tag.length) {
    const id = ascii(tag, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version >= 4 ? syncsafe(tag, offset + 4) : view.getUint32(offset + 4);
    if (size == null || offset + 10 + size > tag.length) break;
    const body = tag.subarray(offset + 10, offset + 10 + size);
    const label = names[id];
    if (label) {
      const text = decodeId3Text(id, body);
      lines.push(text ? `ID3 ${label}: ${text}` : `ID3 ${label}`);
    }
    offset += 10 + size;
  }
  return lines.length > 0 ? lines : ["ID3v2 tag"];
}

function decodeId3Text(id: string, body: Uint8Array): string {
  if (body.length === 0) return "";
  const encoding = body[0];
  let text = body.subarray(1);
  if (id === "COMM" || id === "USLT" || id === "TXXX") {
    const language = id === "TXXX" ? 0 : 3;
    text = text.subarray(language);
    const zero = encoding === 1 || encoding === 2 ? indexOfDoubleZero(text) : text.indexOf(0);
    if (zero >= 0) text = text.subarray(zero + (encoding === 1 || encoding === 2 ? 2 : 1));
  }
  if (encoding === 1 || encoding === 2) return utf16(text, encoding === 1).replace(/\0/g, "").trim();
  return utf8(text).replace(/\0/g, "").trim();
}

function describeId3v1(tag: Uint8Array): string[] {
  const title = latin1(tag.subarray(3, 33));
  const artist = latin1(tag.subarray(33, 63));
  const album = latin1(tag.subarray(63, 93));
  const year = latin1(tag.subarray(93, 97));
  const comment = latin1(tag.subarray(97, 127));
  const lines = ["ID3v1 tag"];
  if (title) lines.push(`ID3 title: ${title}`);
  if (artist) lines.push(`ID3 artist: ${artist}`);
  if (album) lines.push(`ID3 album: ${album}`);
  if (year) lines.push(`ID3 year: ${year}`);
  if (comment) lines.push(`ID3 comment: ${comment}`);
  return lines;
}

function describeWavChunk(data: Uint8Array, id: string): string[] {
  if (id !== "LIST" || ascii(data, 0, 4) !== "INFO") return [`WAV ${id.trim() || id} chunk`];
  const lines = ["WAV LIST/INFO"];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 4;
  while (offset + 8 <= data.length) {
    const field = ascii(data, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > data.length) break;
    const text = latin1(data.subarray(offset + 8, end)).replace(/\0/g, "").trim();
    lines.push(text ? `WAV ${field.trim()}: ${text}` : `WAV ${field.trim()}`);
    offset = end + (size & 1);
  }
  return lines;
}

function describeVorbisComment(body: Uint8Array): string[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length < 8) return ["FLAC comment"];
  let offset = 4 + view.getUint32(0, true);
  if (offset + 4 > body.length) return ["FLAC comment"];
  const count = view.getUint32(offset, true);
  offset += 4;
  const lines = ["FLAC Vorbis comment"];
  for (let index = 0; index < count && offset + 4 <= body.length; index += 1) {
    const size = view.getUint32(offset, true);
    offset += 4;
    if (offset + size > body.length) break;
    const text = utf8(body.subarray(offset, offset + size)).trim();
    if (text) lines.push(`FLAC ${text}`);
    offset += size;
  }
  return lines;
}

function id3v2Length(bytes: Uint8Array, offset: number): number | null {
  if (ascii(bytes, offset, 3) !== "ID3" || offset + 10 > bytes.length) return null;
  const size = syncsafe(bytes, offset + 6);
  if (size == null) return null;
  let total = 10 + size;
  if (bytes[offset + 5] & 0x10) total += 10;
  if (offset + total > bytes.length) return null;
  return total;
}

function hasId3v1(bytes: Uint8Array, end: number): boolean {
  return end >= 128 && ascii(bytes, end - 128, 3) === "TAG";
}

function apeLength(bytes: Uint8Array, start: number, end: number): { length: number; fromStart: boolean } | null {
  if (end - start >= 32 && ascii(bytes, end - 32, 8) === "APETAGEX") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(end - 20, true);
    const flags = view.getUint32(end - 12, true);
    const header = flags & 0x80000000 ? 32 : 0;
    const length = size + header;
    if (length > 0 && end - length >= start) return { length, fromStart: false };
  }
  if (end - start >= 32 && ascii(bytes, start, 8) === "APETAGEX") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(start + 12, true);
    const flags = view.getUint32(start + 20, true);
    const length = flags & 0x20000000 ? size + 32 : size;
    if (length > 0 && start + length <= end) return { length, fromStart: true };
  }
  return null;
}

function syncsafe(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  let size = 0;
  for (let index = 0; index < 4; index += 1) {
    if (bytes[offset + index] & 0x80) return null;
    size = (size << 7) | bytes[offset + index];
  }
  return size;
}

function isWav(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

function isFlac(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === "fLaC";
}

function isMp4(bytes: Uint8Array): boolean {
  return ascii(bytes, 4, 4) === "ftyp";
}

function isMp3(bytes: Uint8Array, extension: string): boolean {
  if (ascii(bytes, 0, 3) === "ID3") return true;
  if (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  return extension === "mp3";
}

function cleanedName(fileName: string, extension: string): string {
  const stem = fileName.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "") || "audio";
  return `${stem}_clean.${extension}`;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]);
  }
  return text;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text.trim();
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function utf16(bytes: Uint8Array, withBom: boolean): string {
  let offset = 0;
  let little = true;
  if (withBom && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) offset = 2;
  else if (withBom && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    little = false;
    offset = 2;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
  let text = "";
  for (let index = 0; index + 1 < view.byteLength; index += 2) {
    text += String.fromCharCode(view.getUint16(index, little));
  }
  return text;
}

function indexOfDoubleZero(bytes: Uint8Array): number {
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] === 0) return index;
  }
  return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
