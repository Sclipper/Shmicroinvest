/**
 * Parses what a user types into an ISO date. Accepts dd.mm.yyyy, d.m.yy, d.m
 * (current year), ddmmyyyy, ddmmyy and ISO yyyy-mm-dd. Returns null when the
 * text is not a real calendar date.
 */
export function parseBgDate(text: string, refYear = new Date().getFullYear()): string | null {
  const s = text.trim();
  if (!s) return null;
  let d: number, m: number, y: number;
  let match: RegExpMatchArray | null;
  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})[./\-\s](\d{1,2})(?:[./\-\s](\d{2}|\d{4}))?\.?$/))) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = match[3] ? Number(match[3]) : refYear;
    if (match[3]?.length === 2) y += 2000;
  } else if ((match = s.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/))) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
    if (match[3]!.length === 2) y += 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export const isoToBg = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
