import { emptyPaymentDocument, type PaymentDocumentFields } from '@shmi/core';
import { ApiError, type Message } from '../../api.ts';

/** Saved document as returned by /payment-documents. */
export interface PaymentDocumentDto extends PaymentDocumentFields {
  id: number;
  documentType: number;
  date: string;
  isDeleted: boolean;
}

/** A row of the registry: a saved document, a changed one, or a new unsaved one. */
export interface DocRow {
  key: string;
  id: number | null;
  date: string;
  isDeleted: boolean;
  doc: PaymentDocumentFields;
  dirty: boolean;
}

let seq = 0;
export const newKey = () => `new-${++seq}`;

export function rowFromDto(d: PaymentDocumentDto): DocRow {
  const { id, date, isDeleted, documentType: _t, ...doc } = d;
  return { key: `id-${id}`, id, date, isDeleted, doc: { ...emptyPaymentDocument(), ...doc }, dirty: false };
}

export function newRow(date: string, doc: Partial<PaymentDocumentFields> = {}): DocRow {
  return { key: newKey(), id: null, date, isDeleted: false, doc: { ...emptyPaymentDocument(), ...doc }, dirty: true };
}

export interface Suggestions {
  personNames: string[];
  personIbans: string[];
  orderers: string[];
  orderersIbans: string[];
}

export interface Branch {
  bankName: string | null;
  bankBranch: string | null;
  bankAddress: string | null;
  issuePlace: string | null;
}

export interface DiaryRow {
  id: number;
  documentType: number;
  typeDescription: string;
  customerIban: string | null;
  receiver: string | null;
  personIban: string | null;
  reason: string | null;
  qtty: string;
  date: string;
  personBic: string | null;
}

/* ------------------------------------------------------------------ */
/* Period of the registry filter (strPeriodDay…All)                     */
/* ------------------------------------------------------------------ */

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
export const PERIODS: [PeriodKind, string][] = [
  ['day', 'Ден'],
  ['week', 'Седмица'],
  ['month', 'Месец'],
  ['year', 'Година'],
  ['all', 'Всички'],
  ['custom', 'Избран период'],
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T12:00:00Z`);

/** ToDate of a period starting at FromDate (month: FromDate + 1 month - 1 day). */
export function periodEnd(kind: PeriodKind, from: string): string {
  const d = at(from);
  if (kind === 'day') return from;
  if (kind === 'week') d.setUTCDate(d.getUTCDate() + 6);
  else if (kind === 'month') {
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(d.getUTCDate() - 1);
  } else if (kind === 'year') {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return iso(d);
}

/** Download of the export file (binary response, not JSON). */
export async function postForFile(url: string, body: unknown): Promise<{ blob: Blob; fileName: string }> {
  const res = await fetch(`/api${url}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string; messages?: Message[] } | null;
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.messages);
  }
  const fileName = res.headers.get('x-export-file-name') ?? 'export.txt';
  return { blob: await res.blob(), fileName };
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
