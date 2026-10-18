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
