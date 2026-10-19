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

export interface PeriodPreset {
  /** PeriodPickerPeriods value (05 1.4): 1..9, then 101..112 for the months. */
  id: number;
  label: string;
  from: string;
  to: string;
}

const MONTH_NAMES = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const monthEnd = (y: number, m: number) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

/**
 * Period picker presets (PeriodPickerPeriods, spec 05 1.4) for the active
 * financial year. "Accounting" periods start at the year's
 * FinancialYears.StartDate (a first year may start mid-year); calendar ones at
 * 1 January. The current months follow the working date: the calendar month is
 * the working date's own month, the accounting month is that month in the
 * active year, not before its start date.
 */
export function periodPresets(fy: { year: number; startDate: string }, workingDate: string, previousStartDate?: string | null): PeriodPreset[] {
  const y = fy.year;
  const start = fy.startDate && fy.startDate.startsWith(String(y)) ? fy.startDate.slice(0, 10) : `${y}-01-01`;
  const wy = Number(workingDate.slice(0, 4)) || y;
  const wm = Number(workingDate.slice(5, 7)) || 1;
  const accMonthFrom = `${y}-${pad2(wm)}-01`;
  const out: PeriodPreset[] = [
    { id: 1, label: 'Текуща счетоводна година', from: start, to: `${y}-12-31` },
    { id: 2, label: 'Текуща календарна година', from: `${y}-01-01`, to: `${y}-12-31` },
    { id: 3, label: 'Текущ счетоводен месец', from: accMonthFrom < start ? start : accMonthFrom, to: monthEnd(y, wm) },
    { id: 4, label: 'Текущ календарен месец', from: `${wy}-${pad2(wm)}-01`, to: monthEnd(wy, wm) },
    {
      id: 5, label: 'Предходна счетоводна година',
      from: previousStartDate && previousStartDate.startsWith(String(y - 1)) ? previousStartDate.slice(0, 10) : `${y - 1}-01-01`, to: `${y - 1}-12-31`,
    },
  ];
  ['I', 'II', 'III', 'IV'].forEach((q, i) => out.push({ id: 6 + i, label: `${q} тримесечие`, from: `${y}-${pad2(i * 3 + 1)}-01`, to: monthEnd(y, i * 3 + 3) }));
  MONTH_NAMES.forEach((name, i) => out.push({ id: 101 + i, label: name, from: `${y}-${pad2(i + 1)}-01`, to: monthEnd(y, i + 1) }));
  return out;
}
