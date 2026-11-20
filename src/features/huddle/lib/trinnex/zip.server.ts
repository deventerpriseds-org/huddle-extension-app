// WHAT:       a minimal, read-only ZIP reader on node:zlib: list the entries of an Office file (docx/pptx/xlsx
//             are ZIP archives of XML) and inflate the ones the extractor asks for.
// WHY:        text extraction for docx/pptx/xlsx (AC-L9) needs only "read these XML parts". No unzip library is a
//             DECLARED dependency today (jszip is only present transitively), so this adds none: ~80 lines on a
//             Node built-in. Bounded against zip bombs (per-entry and total inflate caps).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/trinnex-library.test.ts (fixtures built with Python's zipfile, deflated and stored).
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(public code: "not_zip" | "corrupt" | "encrypted" | "too_big") {
    super(`zip: ${code}`);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Inflated output limits: a 25 MB upload never legitimately inflates past these. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

export function readZip(input: Uint8Array): { entries: ZipEntry[]; read: (name: string) => Buffer | null } {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isZip(buf)) throw new ZipError("not_zip");
  // End of central directory: last 22..(22+65535) bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("corrupt");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, flags, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let total = 0;
  const byName = new Map(entries.map((e) => [e.name, e]));
  function read(name: string): Buffer | null {
    const e = byName.get(name);
    if (!e) return null;
    if (e.flags & 0x1) throw new ZipError("encrypted");
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) throw new ZipError("corrupt");
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw new ZipError("corrupt");
    const raw = buf.subarray(start, end);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        if (err instanceof RangeError || /maxOutputLength|buffer/i.test(String((err as Error)?.message))) throw new ZipError("too_big");
        throw new ZipError("corrupt");
      }
    } else throw new ZipError("corrupt");
    total += out.length;
    if (total > MAX_TOTAL_BYTES) throw new ZipError("too_big");
    return out;
  }
  return { entries, read };
}
