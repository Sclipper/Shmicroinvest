import { layoutColumns, needsLandscape, wrapText, type MeasureText, type ReportDoc, type ReportRow } from './reportExport.ts';
import { parseTtf, textWidthEm, type TtfFont } from './ttf.ts';

/**
 * PDF export of the report viewer (05 11.1; the attachment of "Изпращане по
 * e-mail", 05 11.3): a real PDF 1.7 file built from the report document,
 * A4 portrait or landscape when the table is wide, with the company, title,
 * period, the column header repeated on every page, the rows and totals,
 * page numbers and the signature lines of the printout. The text uses an
 * embedded TrueType font (Type0 / CIDFontType2, Identity-H) with a ToUnicode
 * map, so Cyrillic renders and can be searched and copied. No dependencies;
 * runs in the browser and in Node (deflate through CompressionStream).
 */

export interface PdfFonts {
  regular: Uint8Array;
  bold: Uint8Array;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 28.35; // 10 mm, as the print CSS
const BORDER = '0.55 0.6 0.66 RG 0.4 w';
const HEADER_FILL = '0.886 0.91 0.941 rg';

const enc = new TextEncoder();
const num = (n: number) => (Math.round(n * 100) / 100).toString();
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** UTF-16BE hex string with a BOM: PDF text strings outside Latin-1. */
const textString = (s: string) => {
  let out = '<FEFF';
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i));
  return `${out}>`;
};

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data as Uint8Array<ArrayBuffer>).body!.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface FontUse {
  font: TtfFont;
  resource: string;
  /** Glyph -> text it stands for (ToUnicode). */
  used: Map<number, string>;
  fallback: number;
}

function fontUse(data: Uint8Array, resource: string): FontUse {
  const font = parseTtf(data);
  const fallback = font.glyph(0x3f); // "?"
  return { font, resource, used: new Map([[0, '']]), fallback };
}

/** Glyph ids of a text as a hex string for Tj; characters the font lacks become "?". */
function encodeText(f: FontUse, text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let g = f.font.glyph(cp);
    let shown = ch;
    if (g === 0 && cp !== 0x20) {
      g = f.fallback;
      shown = '?';
    }
    if (!f.used.has(g)) f.used.set(g, shown);
    out += hex4(g);
  }
  return out;
}

interface Page {
  ops: string[];
}

/** Builds the PDF of a report document. */
export async function buildReportPdf(doc: ReportDoc, fonts: PdfFonts, opts: { compress?: boolean } = {}): Promise<Uint8Array> {
  const compress = opts.compress ?? true;
  const regular = fontUse(fonts.regular, 'F1');
  const bold = fontUse(fonts.bold, 'F2');
  const measure: MeasureText = (t, b) => textWidthEm(b ? bold.font : regular.font, t);
  const portraitWidth = A4[0] - 2 * MARGIN;
  const landscape = doc.sections.some((s) => needsLandscape(s, measure, portraitWidth));
  const [pageW, pageH] = landscape ? [A4[1], A4[0]] : A4;
  const width = pageW - 2 * MARGIN;
  const bottom = MARGIN + 14; // room for the page number
  const pages: Page[] = [];
  let page!: Page;
  let y = 0;

  const newPage = () => {
    page = { ops: [] };
    pages.push(page);
    y = pageH - MARGIN;
  };
  const text = (x: number, baseline: number, s: string, size: number, isBold = false, gray = 0) => {
    if (!s) return;
    const f = isBold ? bold : regular;
    page.ops.push(`BT ${gray ? `${num(gray)} g ` : ''}/${f.resource} ${num(size)} Tf 1 0 0 1 ${num(x)} ${num(baseline)} Tm <${encodeText(f, s)}> Tj ET${gray ? ' 0 g' : ''}`);
  };
  const width1 = (s: string, size: number, isBold = false) => measure(s, isBold) * size;
  /** Lines of text across the page width; a new page when they do not fit. */
  const paragraph = (s: string, size: number, isBold = false, gap = 2) => {
    for (const line of wrapText(s, width / size, (t) => measure(t, isBold))) {
      if (y - size * 1.25 < bottom) newPage();
      text(MARGIN, y - size, line, size, isBold);
      y -= size * 1.25;
    }
    y -= gap;
  };

  newPage();
  // Page header of the first page: company and date/time, title, subtitle (as PrintPortal).
  const meta = doc.meta;
  text(MARGIN, y - 8, meta.company, 8, false, 0.3);
  if (meta.printedAt) {
    const t = `Дата и час: ${meta.printedAt}`;
    text(pageW - MARGIN - width1(t, 8), y - 8, t, 8, false, 0.3);
  }
  y -= 12;
  paragraph(meta.title, 14, true, 1);
  for (const line of meta.subtitle ?? []) if (line.trim()) paragraph(line, 9);
  y -= 6;

  doc.sections.forEach((s, si) => {
    if (si > 0) {
      newPage();
    }
    if (doc.sections.length > 1 && s.name) paragraph(s.name, 11, true, 3);
    for (const t of s.titles) paragraph(t, 9);
    if (s.titles.length) y -= 3;
    if (!s.header && s.rows.length === 0) return;

    const { fontSize: size, widths } = layoutColumns(s, measure, width);
    const lineH = size * 1.2;
    const padV = 1.6;
    const tableW = widths.reduce((a, b) => a + b, 0);
    const xs = widths.reduce<number[]>((acc, w) => [...acc, acc[acc.length - 1]! + w], [MARGIN]);

    const cellLines = (t: string, c: number, isBold: boolean, numeric: boolean) => (numeric ? [t] : wrapText(t, (widths[c]! - 6) / size, (x) => measure(x, isBold)));
    // Amounts are right-aligned and never wrap; header texts are centred.
    const drawRow = (cells: { text: string; bold: boolean; numeric: boolean }[], opts: { bold: boolean; header?: boolean; span?: boolean }) => {
      const lines = opts.span
        ? [wrapText(cells[0]!.text, (tableW - 6) / size, (x) => measure(x, opts.bold))]
        : widths.map((_, c) => {
          const cell = cells[c];
          if (!cell?.text) return [];
          return cellLines(cell.text, c, opts.bold || cell.bold, !opts.header && cell.numeric);
        });
      const h = Math.max(1, ...lines.map((l) => l.length)) * lineH + 2 * padV;
      return { h, draw: (top: number) => {
        if (opts.header) page.ops.push(`${HEADER_FILL} ${num(MARGIN)} ${num(top - h)} ${num(tableW)} ${num(h)} re f 0 g`);
        page.ops.push(`${BORDER} ${num(MARGIN)} ${num(top - h)} ${num(tableW)} ${num(h)} re S`);
        if (!opts.span) for (const x of xs.slice(1, -1)) page.ops.push(`${num(x)} ${num(top)} m ${num(x)} ${num(top - h)} l S`);
        lines.forEach((ls, c) => {
          const isBold = opts.header || opts.bold || (!opts.span && !!cells[c]?.bold);
          const x0 = xs[c]!;
          const w = opts.span ? tableW : widths[c]!;
          ls.forEach((l, k) => {
            const base = top - padV - k * lineH - size * 0.95;
            const lw = width1(l, size, isBold);
            const x = opts.header ? x0 + (w - lw) / 2 : !opts.span && cells[c]?.numeric ? x0 + w - 3 - lw : x0 + 3;
            text(x, base, l, size, isBold);
          });
        });
      } };
    };

    const header = s.header ? drawRow(s.header, { bold: true, header: true }) : null;
    const putHeader = () => {
      if (!header) return;
      header.draw(y);
      y -= header.h;
    };
    if (header && y - header.h - lineH * 2 < bottom) newPage();
    putHeader();
    s.rows.forEach((r: ReportRow) => {
      if (r.blank) {
        y -= lineH * 0.6;
        return;
      }
      const row = drawRow(r.cells, { bold: r.bold, span: r.span });
      if (y - row.h < bottom) {
        newPage();
        putHeader();
      }
      row.draw(y);
      y -= row.h;
    });
    y -= 6;
  });

  if (meta.signatures) {
    if (y - 30 < bottom) newPage();
    y -= 22;
    const sigs = ['Съставил: ....................', 'Гл. счетоводител: ....................', 'Управител: ....................'];
    text(MARGIN, y, sigs[0]!, 8);
    text(MARGIN + (width - width1(sigs[1]!, 8)) / 2, y, sigs[1]!, 8);
    text(pageW - MARGIN - width1(sigs[2]!, 8), y, sigs[2]!, 8);
  }

  pages.forEach((p, i) => {
    page = p;
    const t = `Страница ${i + 1} от ${pages.length}`;
    text(pageW - MARGIN - width1(t, 7), MARGIN, t, 7, false, 0.35);
  });

  return writePdf({ pages, pageW, pageH, fonts: [regular, bold], title: meta.title, subject: meta.company, compress });
}

/* ------------------------------------------------------------------ */
/* File structure                                                      */
/* ------------------------------------------------------------------ */

function toUnicodeCMap(used: Map<number, string>): string {
  const entries = [...used].filter(([, s]) => s !== '').sort((a, b) => a[0] - b[0]);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([g, s]) => `<${hex4(g)}> <${[...s].map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp);
    }).join('')}>`).join('\n')}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

/** /W array of the used glyphs, in 1/1000 em. */
function widthsArray(f: FontUse): string {
  const gids = [...f.used.keys()].sort((a, b) => a - b);
  return `[${gids.map((g) => `${g} [${Math.round((f.font.advance(g) * 1000) / f.font.unitsPerEm)}]`).join(' ')}]`;
}

async function writePdf(p: { pages: Page[]; pageW: number; pageH: number; fonts: FontUse[]; title: string; subject: string; compress: boolean }): Promise<Uint8Array> {
  const objects: (Uint8Array | null)[] = [];
  const reserve = () => {
    objects.push(null);
    return objects.length;
  };
  const set = (n: number, body: string | Uint8Array) => {
    objects[n - 1] = typeof body === 'string' ? enc.encode(body) : body;
  };
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const part of parts) {
      out.set(part, o);
      o += part.length;
    }
    return out;
  };
  const stream = async (dict: string, data: Uint8Array, extra = '') => {
    const body = p.compress ? await deflate(data) : data;
    return concat([enc.encode(`<< /Length ${body.length}${p.compress ? ' /Filter /FlateDecode' : ''}${extra}${dict ? ` ${dict}` : ''} >>\nstream\n`), body, enc.encode('\nendstream')]);
  };

  const catalog = reserve();
  const pagesObj = reserve();
  const info = reserve();
  const fontRefs: string[] = [];
  for (const f of p.fonts) {
    const type0 = reserve();
    const cid = reserve();
    const descriptor = reserve();
    const file = reserve();
    const toUnicode = reserve();
    const name = f.font.postscriptName;
    const k = 1000 / f.font.unitsPerEm;
    const flags = (f.font.fixedPitch ? 1 : 0) | 32;
    set(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
    set(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW ${Math.round(f.font.advance(0) * k)} /W ${widthsArray(f)} /CIDToGIDMap /Identity >>`);
    set(descriptor, `<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} /FontBBox [${f.font.bbox.map((b) => Math.round(b * k)).join(' ')}] /ItalicAngle ${f.font.italicAngle} /Ascent ${Math.round(f.font.ascent * k)} /Descent ${Math.round(f.font.descent * k)} /CapHeight ${Math.round(f.font.capHeight * k)} /StemV 80 /FontFile2 ${file} 0 R >>`);
    set(file, await stream('', f.font.data, ` /Length1 ${f.font.data.length}`));
    set(toUnicode, await stream('', enc.encode(toUnicodeCMap(f.used))));
    fontRefs.push(`/${f.resource} ${type0} 0 R`);
  }
  const kids: number[] = [];
  for (const pg of p.pages) {
    const pageObj = reserve();
    const content = reserve();
    set(content, await stream('', enc.encode(pg.ops.join('\n'))));
    set(pageObj, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(p.pageW)} ${num(p.pageH)}] /Resources << /Font << ${fontRefs.join(' ')} >> >> /Contents ${content} 0 R >>`);
    kids.push(pageObj);
  }
  set(pagesObj, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const d = new Date();
  const pdfDate = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
  set(info, `<< /Title ${textString(p.title)} /Subject ${textString(p.subject)} /Producer (Shmelta Pro) /CreationDate (${pdfDate}) >>`);

  // Header with a binary comment line (raw high bytes, not UTF-8).
  const head = concat([enc.encode('%PDF-1.7\n%'), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), enc.encode('\n')]);
  const parts: Uint8Array[] = [head];
  let offset = head.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const chunk = concat([enc.encode(`${i + 1} 0 obj\n`), body!, enc.encode('\nendobj\n')]);
    offsets.push(offset);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return concat(parts);
}

/* ------------------------------------------------------------------ */
/* Reading back (tests, verification of exports)                       */
/* ------------------------------------------------------------------ */

/** Number of pages of a PDF written by buildReportPdf. */
export function pdfPageCount(pdf: Uint8Array): number {
  const m = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(latin1(pdf));
  return m ? Number(m[1]) : 0;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

/**
 * Text of the pages of a PDF written by buildReportPdf (one line per text
 * run), decoded through the fonts' ToUnicode maps.
 */
export async function extractPdfText(pdf: Uint8Array): Promise<string[]> {
  const raw = latin1(pdf);
  const objects = new Map<number, { dict: string; data: Uint8Array | null }>();
  const re = /(\d+) 0 obj\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const streamAt = raw.indexOf('stream\n', start);
    const endAt = raw.indexOf('endobj', start);
    if (streamAt >= 0 && streamAt < endAt) {
      const dict = raw.slice(start, streamAt);
      const len = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      let data = pdf.subarray(streamAt + 7, streamAt + 7 + len);
      if (dict.includes('/FlateDecode')) data = await inflate(data);
      objects.set(Number(m[1]), { dict, data });
      re.lastIndex = streamAt + 7 + len;
    } else {
      objects.set(Number(m[1]), { dict: raw.slice(start, endAt), data: null });
      re.lastIndex = endAt;
    }
  }
  const dec = new TextDecoder();
  const cmaps = new Map<number, Map<string, string>>();
  const cmapOf = (fontObj: number) => {
    if (cmaps.has(fontObj)) return cmaps.get(fontObj)!;
    const map = new Map<string, string>();
    const ref = /\/ToUnicode (\d+) 0 R/.exec(objects.get(fontObj)?.dict ?? '')?.[1];
    const data = ref ? objects.get(Number(ref))?.data : null;
    if (data) {
      for (const [, g, u] of dec.decode(data).matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
        const units = u!.match(/.{4}/g)!.map((h) => parseInt(h, 16));
        map.set(g!, String.fromCharCode(...units));
      }
    }
    cmaps.set(fontObj, map);
    return map;
  };
  const pagesDict = [...objects.values()].find((o) => o.dict.includes('/Type /Pages'))?.dict ?? '';
  const kids = [...(/\/Kids \[([^\]]*)\]/.exec(pagesDict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((k) => Number(k[1]));
  const out: string[] = [];
  for (const kid of kids) {
    const dict = objects.get(kid)?.dict ?? '';
    const fonts = new Map([...(/\/Font << ([^>]*) >>/.exec(dict)?.[1] ?? '').matchAll(/\/(\w+) (\d+) 0 R/g)].map((f) => [f[1]!, Number(f[2])]));
    const content = objects.get(Number(/\/Contents (\d+) 0 R/.exec(dict)?.[1]))?.data;
    if (!content) continue;
    let font = new Map<string, string>();
    for (const t of dec.decode(content).matchAll(/\/(\w+) [\d.]+ Tf|<([0-9A-F]*)> Tj/g)) {
      if (t[1]) font = cmapOf(fonts.get(t[1]) ?? -1);
      else out.push((t[2]!.match(/.{4}/g) ?? []).map((g) => font.get(g) ?? ' ').join(''));
    }
  }
  return out;
}
