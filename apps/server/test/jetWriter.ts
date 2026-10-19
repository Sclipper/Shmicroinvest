/**
 * Minimal Microsoft Jet (Access .mdb) writer for tests: Jet 3 (Access 97,
 * text in windows-1251) and Jet 4 (UCS-2 text). It writes what a reader
 * needs to list and read tables: the database definition page (with the RC4
 * header of an unencrypted file), MSysObjects, one table definition page per
 * table (no indexes), inline usage maps and data pages. No indexes, memo or
 * long-value pages; records stay small (Jet 3: under 256 bytes).
 *
 * Layout and offsets follow mdbtools' HACKING notes, as read by mdb-reader.
 * Self-contained (no workspace imports) so the e2e specs can use it too.
 */

export type JetType = 'boolean' | 'byte' | 'integer' | 'long' | 'currency' | 'double' | 'datetime' | 'text';
export interface JetColumn { name: string; type: JetType; size?: number }
export interface JetTable { name: string; columns: JetColumn[]; rows: Record<string, unknown>[] }

const TYPE_CODE: Record<JetType, number> = { boolean: 0x01, byte: 0x02, integer: 0x03, long: 0x04, currency: 0x05, double: 0x07, datetime: 0x08, text: 0x0a };
const FIXED_SIZE: Record<Exclude<JetType, 'text'>, number> = { boolean: 0, byte: 1, integer: 2, long: 4, currency: 8, double: 8, datetime: 8 };

const FORMATS = {
  3: {
    version: 0x00, pageSize: 2048, encryptedSize: 126, rco: 8, columnCountSize: 1,
    tdef: { rowCount: 12, varCols: 23, cols: 25, realIndexCount: 31, usageMap: 35, columnsStart: 43, entry: 18, index: 1, varIndex: 3, flags: 13, fixedIndex: 14, size: 16, nameLength: 1 },
  },
  4: {
    version: 0x01, pageSize: 4096, encryptedSize: 128, rco: 12, columnCountSize: 2,
    tdef: { rowCount: 16, varCols: 43, cols: 45, realIndexCount: 51, usageMap: 55, columnsStart: 63, entry: 25, index: 5, varIndex: 7, flags: 15, fixedIndex: 21, size: 23, nameLength: 2 },
  },
} as const;
type Format = (typeof FORMATS)[3 | 4];

function rc4(key: number[], data: Buffer) {
  const S = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i]! + key[i % key.length]!) & 0xff;
    [S[i], S[j]] = [S[j]!, S[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]!) & 0xff;
    [S[i], S[j]] = [S[j]!, S[i]!];
    out[n] = data[n]! ^ S[(S[i]! + S[j]!) & 0xff]!;
  }
  return out;
}

let cp1251: Map<string, number> | null = null;
/** windows-1251 bytes of a string (Jet 3 text of a Bulgarian Windows installation). */
export function encodeCp1251(s: string): Buffer {
  if (!cp1251) {
    cp1251 = new Map();
    const dec1251 = new TextDecoder('windows-1251');
    for (let b = 0; b < 256; b++) cp1251.set(dec1251.decode(new Uint8Array([b])), b);
  }
  return Buffer.from([...s].map((ch) => cp1251!.get(ch) ?? 0x3f));
}

const textBytes = (s: string, v: 3 | 4) => (v === 4 ? Buffer.from(s, 'ucs2') : encodeCp1251(s));

interface Layout { col: JetColumn; index: number; fixedIndex: number; varIndex: number; size: number }

function layout(t: JetTable, v: 3 | 4): Layout[] {
  let fixed = 0;
  let variable = 0;
  return t.columns.map((col, index) => {
    if (col.type === 'text') {
      const chars = col.size ?? 255;
      return { col, index, fixedIndex: 0, varIndex: variable++, size: v === 4 ? chars * 2 : chars };
    }
    const size = FIXED_SIZE[col.type];
    const l = { col, index, fixedIndex: fixed, varIndex: 0, size };
    fixed += size;
    return l;
  });
}

/** Currency is a 64-bit integer of 1/10000 units. */
function currencyUnits(value: unknown): bigint {
  const m = /^([-+])?(\d*)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!m) throw new Error(`Not a currency value: ${String(value)}`);
  const units = BigInt(`${m[2] || '0'}${(m[3] ?? '').padEnd(4, '0').slice(0, 4)}`);
  return m[1] === '-' ? -units : units;
}

function fixedValue(type: Exclude<JetType, 'text' | 'boolean'>, value: unknown): Buffer {
  const b = Buffer.alloc(FIXED_SIZE[type]);
  switch (type) {
    case 'byte': b.writeUInt8(Number(value)); break;
    case 'integer': b.writeInt16LE(Number(value)); break;
    case 'long': b.writeInt32LE(Number(value)); break;
    case 'double': b.writeDoubleLE(Number(value)); break;
    case 'currency': b.writeBigInt64LE(currencyUnits(value)); break;
    case 'datetime': {
      const d = value instanceof Date ? value : new Date(String(value));
      b.writeDoubleLE(d.getTime() / 86400000 + 25569);
      break;
    }
  }
  return b;
}

function record(t: JetTable, cols: Layout[], row: Record<string, unknown>, f: Format, v: 3 | 4): Buffer {
  const fixedSize = cols.filter((c) => c.col.type !== 'text').reduce((a, c) => a + c.size, 0);
  const fixed = Buffer.alloc(fixedSize);
  const vars: Buffer[] = [];
  const mask = Buffer.alloc(Math.ceil(cols.length / 8));
  for (const c of cols) {
    const value = row[c.col.name];
    const present = c.col.type === 'boolean' ? !!value : value !== null && value !== undefined;
    if (present) mask[c.index >> 3]! |= 1 << (c.index & 7);
    if (c.col.type === 'text') vars[c.varIndex] = present ? textBytes(String(value), v) : Buffer.alloc(0);
    else if (c.col.type !== 'boolean' && present) fixedValue(c.col.type, value).copy(fixed, c.fixedIndex);
  }
  const head = Buffer.alloc(f.columnCountSize);
  head.writeUIntLE(cols.length, 0, f.columnCountSize);
  const varCount = vars.length;
  if (!varCount) return Buffer.concat([head, fixed, mask]);
  const offsets: number[] = [];
  let pos = f.columnCountSize + fixedSize;
  for (const b of vars) {
    offsets.push(pos);
    pos += b.length;
  }
  offsets.push(pos);
  const w = v === 4 ? 2 : 1;
  const table = Buffer.alloc(offsets.length * w);
  // Offset i sits i entries below the column count, so the table is written from the last entry down.
  offsets.slice().reverse().forEach((o, k) => table.writeUIntLE(o, k * w, w));
  const count = Buffer.alloc(w);
  count.writeUIntLE(varCount, 0, w);
  const rec = Buffer.concat([head, fixed, ...vars, table, count, mask]);
  if (v === 3 && rec.length > 256) throw new Error(`Jet 3 test record of ${t.name} longer than 256 bytes`);
  return rec;
}

/** Packs records into data pages of one table. */
function dataPages(records: Buffer[], f: Format): Buffer[][] {
  const pages: Buffer[][] = [];
  let cur: Buffer[] = [];
  let used = 0;
  for (const r of records) {
    const header = f.rco + 2 + 2 * (cur.length + 1);
    if (cur.length && header + used + r.length > f.pageSize) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(r);
    used += r.length;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function dataPage(records: Buffer[], tdefPage: number, f: Format): Buffer {
  const p = Buffer.alloc(f.pageSize);
  p[0] = 0x01;
  p[1] = 0x01;
  p.writeUInt32LE(tdefPage, 4);
  p.writeUInt16LE(records.length, f.rco);
  let end: number = f.pageSize;
  records.forEach((r, i) => {
    const start = end - r.length;
    r.copy(p, start);
    p.writeUInt16LE(start, f.rco + 2 + i * 2);
    end = start;
  });
  p.writeUInt16LE(end - (f.rco + 2 + records.length * 2), 2);
  return p;
}

function tdefPage(t: JetTable, cols: Layout[], rowCount: number, usageMapRow: number, f: Format, v: 3 | 4): Buffer {
  const p = Buffer.alloc(f.pageSize);
  const d = f.tdef;
  p[0] = 0x02;
  p[1] = 0x01;
  p.writeUInt32LE(0, 4); // no next definition page
  p.writeUInt32LE(rowCount, d.rowCount);
  p.writeUInt16LE(cols.filter((c) => c.col.type === 'text').length, d.varCols);
  p.writeUInt16LE(cols.length, d.cols);
  p.writeInt32LE(0, d.realIndexCount);
  p.writeUInt32LE((1 << 8) | usageMapRow, d.usageMap);
  let pos = d.columnsStart;
  for (const c of cols) {
    p[pos] = TYPE_CODE[c.col.type];
    p.writeUInt8(c.index, pos + d.index);
    p.writeUInt8(c.varIndex, pos + d.varIndex);
    p.writeUInt8((c.col.type === 'text' ? 0 : 0x01) | 0x02, pos + d.flags);
    p.writeUInt16LE(c.fixedIndex, pos + d.fixedIndex);
    p.writeUInt16LE(c.size, pos + d.size);
    pos += d.entry;
  }
  for (const c of cols) {
    const name = v === 4 ? Buffer.from(c.col.name, 'ucs2') : Buffer.from(c.col.name, 'latin1');
    p.writeUIntLE(name.length, pos, d.nameLength);
    pos += d.nameLength;
    name.copy(p, pos);
    pos += name.length;
  }
  if (pos > f.pageSize) throw new Error(`Table definition of ${t.name} does not fit one page`);
  return p;
}

const MSYS_OBJECTS: JetColumn[] = [
  { name: 'Id', type: 'long' }, { name: 'Name', type: 'text', size: 128 }, { name: 'Type', type: 'integer' }, { name: 'Flags', type: 'long' },
];

/** Builds an .mdb file with the given user tables. */
export function writeJet(tables: JetTable[], opts: { version?: 3 | 4 } = {}): Uint8Array {
  const v = opts.version ?? 4;
  const f = FORMATS[v];
  // Records and data pages of every user table (they do not depend on page numbers).
  const user = tables.map((t) => {
    const cols = layout(t, v);
    return { t, cols, pages: dataPages(t.rows.map((r) => record(t, cols, r, f, v)), f) };
  });
  // Pages: 0 header, 1 usage maps, 2 MSysObjects definition, 3 its data, then per table its definition and data.
  let next = 4;
  const placed = user.map((u) => {
    const tdef = next++;
    const data = u.pages.map(() => next++);
    return { ...u, tdef, data };
  });
  const sysTable: JetTable = {
    name: 'MSysObjects', columns: MSYS_OBJECTS,
    rows: [{ Id: 2, Name: 'MSysObjects', Type: 1, Flags: 0x80000002 | 0 }, ...placed.map((p) => ({ Id: p.tdef, Name: p.t.name, Type: 1, Flags: 0 }))],
  };
  const sysCols = layout(sysTable, v);
  const sysPages = dataPages(sysTable.rows.map((r) => record(sysTable, sysCols, r, f, v)), f);
  if (sysPages.length > 1) throw new Error('Too many tables for the test writer');
  const total = next;
  const bitmapBytes = Math.ceil(total / 8);
  const usage = (pages: number[]) => {
    const r = Buffer.alloc(5 + bitmapBytes);
    r[0] = 0x00;
    r.writeUInt32LE(0, 1);
    for (const pg of pages) r[5 + (pg >> 3)]! |= 1 << (pg & 7);
    return r;
  };

  const out = Buffer.alloc(total * f.pageSize);
  // Database definition page: "Standard Jet DB", version, RC4-masked header of a file without encryption key.
  const header = out.subarray(0, f.pageSize);
  header[0] = 0x00;
  header[1] = 0x01;
  header.write('Standard Jet DB', 4, 'latin1');
  header[0x14] = f.version;
  rc4([0xc7, 0xda, 0x39, 0x6b], Buffer.alloc(f.encryptedSize)).copy(header, 0x18);

  dataPage([usage([3]), ...placed.map((p) => usage(p.data))], 0, f).copy(out, 1 * f.pageSize);
  tdefPage(sysTable, sysCols, sysTable.rows.length, 0, f, v).copy(out, 2 * f.pageSize);
  dataPage(sysPages[0] ?? [], 2, f).copy(out, 3 * f.pageSize);
  placed.forEach((p, i) => {
    tdefPage(p.t, p.cols, p.t.rows.length, i + 1, f, v).copy(out, p.tdef * f.pageSize);
    p.pages.forEach((recs, k) => dataPage(recs, p.tdef, f).copy(out, p.data[k]! * f.pageSize));
  });
  return new Uint8Array(out);
}
