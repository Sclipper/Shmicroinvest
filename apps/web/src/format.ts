import { formatMoney } from '@shmi/core';

export const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
export const moneyOrBlank = (v: string | number | null | undefined) => (v === null || v === undefined || Number(v) === 0 ? '' : formatMoney(v));

/** ISO yyyy-mm-dd -> dd.mm.yyyy */
export function bgDate(iso: string | null | undefined) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export const monthLabel = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');

/** Account sort order (spec 05 2.1): first part as text, further parts numerically. */
export function compareAccountNumbers(a: string, b: string) {
  const pa = a.split('/');
  const pb = b.split('/');
  if (pa[0] !== pb[0]) return pa[0]! < pb[0]! ? -1 : 1;
  for (let i = 1; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? -1);
    const y = Number(pb[i] ?? -1);
    if (x !== y) return x - y;
  }
  return 0;
}
