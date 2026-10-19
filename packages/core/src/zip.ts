/**
 * Minimal ZIP writer (stored entries, no compression). Used to hand the
 * browser the NAP export folder `MM.yyyy\` with its files in one download,
 * and for the password-protected backup download (ZipPassword, 06 3.2).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---- Traditional PKWARE encryption ("ZipCrypto", APPNOTE 6.1) ----------------
 * The local setting ZipPassword / IsZipPasswordEnabled (06 3.2) protects the
 * backup and export archives. ZipCrypto is what every unzip tool (Windows
 * Explorer included) opens; it is weak against a determined attacker. The
 * password is taken as UTF-8: ASCII passwords are portable between tools. */

const updateCrc = (crc: number, b: number) => (CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;

function zipCryptoKeys(password: string) {
  const k = [0x12345678, 0x23456789, 0x34567890];
  const update = (b: number) => {
    k[0] = updateCrc(k[0]!, b);
    k[1] = (Math.imul((k[1]! + (k[0]! & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k[2] = updateCrc(k[2]!, k[1]! >>> 24);
  };
  const stream = () => {
    const t = (k[2]! | 2) & 0xffff;
    return (Math.imul(t, t ^ 1) >>> 8) & 0xff;
  };
  for (const b of new TextEncoder().encode(password)) update(b);
  return { update, stream };
}

/** Encrypts one entry: 12-byte header (11 random bytes + the CRC check byte) and the data. */
export function zipCryptoEncrypt(data: Uint8Array, password: string, crc: number, random: (n: number) => Uint8Array = defaultRandom): Uint8Array {
  const keys = zipCryptoKeys(password);
  const head = random(12);
  head[11] = (crc >>> 24) & 0xff;
  const out = new Uint8Array(12 + data.length);
  const plain = [head, data];
  let o = 0;
  for (const part of plain) {
    for (const b of part) {
      out[o++] = b ^ keys.stream();
      keys.update(b);
    }
  }
  return out;
}

/** Thrown by the reader: no password given for an encrypted entry, or a wrong one. */
export class ZipPasswordError extends Error {
  reason: 'missing' | 'wrong';
  constructor(reason: 'missing' | 'wrong') {
    super(reason === 'missing' ? 'ZIP password required' : 'Wrong ZIP password');
    this.reason = reason;
  }
}

/** Decrypts one entry; the header's check byte (CRC high byte, or the DOS time high byte with a data descriptor) tells a wrong password. */
export function zipCryptoDecrypt(body: Uint8Array, password: string, check: number): Uint8Array {
  const keys = zipCryptoKeys(password);
  const plain = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const b = body[i]! ^ keys.stream();
    keys.update(b);
    plain[i] = b;
  }
  if (plain[11] !== check) throw new ZipPasswordError('wrong');
  return plain.subarray(12);
}

function defaultRandom(n: number) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** A ZIP local file header at the start (PK\x03\x04). */
export const isZip = (data: Uint8Array) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;

export function zipStore(files: { name: string; data: Uint8Array }[], date = new Date(Date.UTC(2026, 0, 1)), password?: string | null): Uint8Array {
  const enc = new TextEncoder();
  const dosTime = ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const flags = 0x0800 | (password ? 0x0001 : 0); // UTF-8 names; bit 0 = encrypted
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const body = password ? zipCryptoEncrypt(f.data, password, crc) : f.data;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
