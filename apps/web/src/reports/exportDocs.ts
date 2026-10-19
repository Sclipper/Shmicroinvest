import regularFontUrl from '@shmi/core/fonts/DejaVuSansCondensed.ttf?url';
import boldFontUrl from '@shmi/core/fonts/DejaVuSansCondensed-Bold.ttf?url';
import { buildReportDocx } from '@shmi/core/docx';
import { buildReportPdf, type PdfFonts } from '@shmi/core/pdf';
import type { ReportDoc } from '@shmi/core';

/**
 * PDF and Word writers of the report viewer, loaded on the first export
 * (dynamic import from reports/common.tsx). The PDF embeds DejaVu Sans
 * Condensed (Latin + Cyrillic subset, packages/core/fonts), fetched once.
 *
 * The fonts are DejaVu 2.37 (Bitstream Vera license + public domain, see
 * packages/core/fonts/LICENSE-DejaVu.txt; redistribution and modification
 * allowed), subset with fontTools pyftsubset to U+0020-017F, Cyrillic
 * U+0400-045F/0490-0491, punctuation, € and № without hinting or layout tables.
 */

let fonts: Promise<PdfFonts> | null = null;

const fetchFont = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Шрифтът за PDF не може да бъде зареден.');
  return new Uint8Array(await r.arrayBuffer());
};

function loadFonts(): Promise<PdfFonts> {
  fonts ??= Promise.all([fetchFont(regularFontUrl), fetchFont(boldFontUrl)])
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((e: unknown) => {
      fonts = null;
      throw e;
    });
  return fonts;
}

export async function reportPdf(doc: ReportDoc): Promise<Uint8Array> {
  return buildReportPdf(doc, await loadFonts());
}

export function reportDocx(doc: ReportDoc): Uint8Array {
  return buildReportDocx(doc);
}
