/**
 * TrueType reader for the PDF export of the reports (05 11.1): the metrics a
 * PDF needs to embed a font (units per em, ascent, descent, bounding box),
 * the Unicode -> glyph mapping of the `cmap` table (formats 4 and 12) and the
 * glyph advances of `hmtx`. Only `glyf` (TrueType outline) fonts are
 * supported: they go into the PDF unchanged as a FontFile2.
 */

export interface TtfFont {
  data: Uint8Array;
  postscriptName: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  fixedPitch: boolean;
  numGlyphs: number;
  /** Glyph of a code point; 0 (.notdef) when the font has none. */
  glyph(cp: number): number;
  /** Advance width of a glyph in font units. */
  advance(gid: number): number;
}

export function parseTtf(data: Uint8Array): TtfFont {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (p: number) => String.fromCharCode(data[p]!, data[p + 1]!, data[p + 2]!, data[p + 3]!);
  const version = v.getUint32(0);
  if (version !== 0x00010000 && tag(0) !== 'true') throw new Error('Неподдържан формат на шрифта (нужен е TrueType).');
  const tables = new Map<string, { offset: number; length: number }>();
  const numTables = v.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tables.set(tag(p), { offset: v.getUint32(p + 8), length: v.getUint32(p + 12) });
  }
  const table = (name: string) => {
    const t = tables.get(name);
    if (!t) throw new Error(`Шрифтът няма таблица ${name}.`);
    return t.offset;
  };
  if (!tables.has('glyf')) throw new Error('Неподдържан формат на шрифта (нужен е TrueType).');

  const head = table('head');
  const unitsPerEm = v.getUint16(head + 18);
  const bbox: [number, number, number, number] = [v.getInt16(head + 36), v.getInt16(head + 38), v.getInt16(head + 40), v.getInt16(head + 42)];
  const hhea = table('hhea');
  let ascent = v.getInt16(hhea + 4);
  let descent = v.getInt16(hhea + 6);
  const numberOfHMetrics = v.getUint16(hhea + 34);
  const numGlyphs = v.getUint16(table('maxp') + 4);
  let capHeight = ascent;
  if (tables.has('OS/2')) {
    const os2 = table('OS/2');
    const osVersion = v.getUint16(os2);
    if (osVersion >= 2 && tables.get('OS/2')!.length >= 90) capHeight = v.getInt16(os2 + 88);
    ascent = v.getInt16(os2 + 68) || ascent;
    descent = v.getInt16(os2 + 70) || descent;
  }
  let italicAngle = 0;
  let fixedPitch = false;
  if (tables.has('post')) {
    const post = table('post');
    italicAngle = v.getInt32(post + 4) / 65536;
    fixedPitch = v.getUint32(post + 12) !== 0;
  }

  const hmtx = table('hmtx');
  const advance = (gid: number) => v.getUint16(hmtx + 4 * Math.min(gid, numberOfHMetrics - 1));

  // cmap: prefer the full Unicode format 12, then the BMP format 4.
  const cmap = table('cmap');
  let f4 = -1;
  let f12 = -1;
  for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
    const p = cmap + 4 + i * 8;
    const platform = v.getUint16(p);
    const encoding = v.getUint16(p + 2);
    const sub = cmap + v.getUint32(p + 4);
    const format = v.getUint16(sub);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12 && f12 < 0) f12 = sub;
    if (format === 4 && f4 < 0) f4 = sub;
  }
  if (f4 < 0 && f12 < 0) throw new Error('Шрифтът няма Unicode таблица cmap.');
  const cache = new Map<number, number>();
  const lookup12 = (cp: number) => {
    const n = v.getUint32(f12 + 12);
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = f12 + 16 + mid * 12;
      const start = v.getUint32(p);
      const end = v.getUint32(p + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return v.getUint32(p + 8) + (cp - start);
    }
    return 0;
  };
  const lookup4 = (cp: number) => {
    if (cp > 0xffff) return 0;
    const segX2 = v.getUint16(f4 + 6);
    const ends = f4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2; i += 2) {
      if (cp > v.getUint16(ends + i)) continue;
      const start = v.getUint16(starts + i);
      if (cp < start) return 0;
      const delta = v.getUint16(deltas + i);
      const range = v.getUint16(ranges + i);
      if (range === 0) return (cp + delta) & 0xffff;
      const g = v.getUint16(ranges + i + range + 2 * (cp - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const glyph = (cp: number) => {
    let g = cache.get(cp);
    if (g === undefined) {
      g = f12 >= 0 ? lookup12(cp) : lookup4(cp);
      if (g >= numGlyphs) g = 0;
      cache.set(cp, g);
    }
    return g;
  };

  return { data, postscriptName: postscriptName(data, v, tables.get('name')), unitsPerEm, ascent, descent, capHeight, bbox, italicAngle, fixedPitch, numGlyphs, glyph, advance };
}

/** Name ID 6 of the `name` table (PDF names allow no spaces or delimiters). */
function postscriptName(data: Uint8Array, v: DataView, t: { offset: number; length: number } | undefined): string {
  if (!t) return 'Font';
  const count = v.getUint16(t.offset + 2);
  const strings = t.offset + v.getUint16(t.offset + 4);
  let found = '';
  for (let i = 0; i < count && !found; i++) {
    const p = t.offset + 6 + i * 12;
    const platform = v.getUint16(p);
    if (v.getUint16(p + 6) !== 6) continue;
    const len = v.getUint16(p + 8);
    const off = strings + v.getUint16(p + 10);
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < len; k += 2) found += String.fromCharCode(v.getUint16(off + k));
    } else if (platform === 1) {
      for (let k = 0; k < len; k++) found += String.fromCharCode(data[off + k]!);
    }
  }
  return found.replace(/[^A-Za-z0-9+\-_.]/g, '') || 'Font';
}

/** Width of a text in em (1 = the font size), from the glyph advances. */
export function textWidthEm(font: TtfFont, text: string): number {
  let w = 0;
  for (const ch of text) w += font.advance(font.glyph(ch.codePointAt(0)!));
  return w / font.unitsPerEm;
}
