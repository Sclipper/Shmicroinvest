import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { ApiError, api, type Message } from '../api.ts';
import { Button, Field, Select, cx } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

/* ------------------------------------------------------------------ */
/* API types (apps/server/src/services/assets*.ts)                      */
/* ------------------------------------------------------------------ */

export interface AssetLookups {
  categories: { id: number; description: string }[];
  methods: { id: number; description: string }[];
  terminationTypes: { id: number; description: string }[];
  maxRates: Record<number, number>;
  ratePresets: number[];
}

export interface Location {
  id: number;
  name: string;
  parentId: number | null;
  leftIndex: number;
  rightIndex: number;
  level: number;
}

export interface AssetRow {
  id: number;
  inventoryNumber: string;
  name: string;
  personInCharge: string | null;
  categoryId: number;
  locationId: number;
  location: string;
  terminationStatusId: number;
  inventoryAccount: string | null;
  debitAccount: string | null;
  creditAccount: string | null;
  cost: string;
  accrued: string;
  bookValue: string;
  acquisitionDate: string;
  startDate: string;
  sapEndDate: string | null;
  dapEndDate: string | null;
  sapFinalDate: string | null;
  dapFinalDate: string | null;
  note: string | null;
  serialNumber: string | null;
  hasPostings: boolean;
  synchronized: boolean;
}

export type MonthStatus = 'normal' | 'posted' | 'postedDifferent' | 'readOnly';

export interface MonthView {
  month: string;
  amount: string;
  isProcessed: boolean;
  status: MonthStatus;
  readOnly: boolean;
  accountingId: number | null;
  accountingNumber: string | null;
  accountingDate: string | null;
  postedAmount: string | null;
}

export interface PlanView {
  isAccounting: boolean;
  depreciationAmount: string;
  nonDepreciableAmount: string;
  depreciableAmount: string;
  acquisitionDate: string;
  startDate: string;
  endDate: string | null;
  finalDate: string | null;
  activePeriodLength: number;
  annualRate: string;
  calcType: 'period' | 'rate';
  notApplied: boolean;
  conservation: { start: string; end: string | null } | null;
  note: string;
  serialNumber: string;
  methodId: number;
  lastProcessedDate: string;
  accrued: string;
  remainder: string;
  revaluationReserve: string;
  firstEditableMonthDate: string;
  startMonthIncluded: boolean;
  improvements: { id: number; date: string; amount: string }[];
  years: { year: number; percentage: string; amount: string; revaluationReserve: string }[];
  months: MonthView[];
  total: string;
}

export interface AssetView {
  id: number;
  inventoryNumber: string;
  name: string;
  personInCharge: string;
  categoryId: number;
  debitAccountId: number | null;
  creditAccountId: number | null;
  inventoryAccountId: number | null;
  locationId: number;
  synchronized: boolean;
  isEuro: boolean;
  terminationStatusId: number;
  terminationAccountingNumber: string | null;
  isTerminated: boolean;
  revaluationReserve: string;
  hasPostings: boolean;
  hasIasChanges: boolean;
  accounting: PlanView;
  tax: PlanView;
  messages: Message[];
}

export interface PreviewResult {
  accounting: PlanView;
  tax: PlanView;
  messages: Message[];
  conflicts: { month: string; accountingNumber: string | null }[];
}

/* ------------------------------------------------------------------ */
/* Requests with the error code (409 dialogs)                          */
/* ------------------------------------------------------------------ */

export class CodedError extends ApiError {
  code?: string;
  constructor(status: number, message: string, messages?: Message[], code?: string) {
    super(status, message, messages);
    this.code = code;
  }
}

/** Like api.* but keeps the server's error `code` (used by the asset save prompts). */
export async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new CodedError(res.status, data?.error ?? res.statusText, data?.messages, data?.code);
  return data as T;
}

/* ------------------------------------------------------------------ */
/* Lookups and locations                                               */
/* ------------------------------------------------------------------ */

export function useAssetLookups() {
  return useQuery({ queryKey: ['assetLookups'], queryFn: () => api.get<AssetLookups>('/assets/lookups'), staleTime: Infinity });
}

export function useLocations() {
  return useQuery({ queryKey: ['assetLocations'], queryFn: () => api.get<Location[]>('/asset-locations'), staleTime: 30_000 });
}

/** The location and all its descendants (nested set). */
export function subtreeIds(locations: Location[], id: number | null) {
  if (!id) return [];
  const root = locations.find((l) => l.id === id);
  if (!root) return [];
  return locations.filter((l) => l.leftIndex >= root.leftIndex && l.rightIndex <= root.rightIndex).map((l) => l.id);
}

/** "Местоположение" select for report filters (the node and its sub-groups). */
export function LocationSelect({ value, onChange, className }: { value: number | null; onChange: (id: number | null) => void; className?: string }) {
  const { data = [] } = useLocations();
  return (
    <Field label="Местоположение">
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className={cx('w-52', className)}>
        <option value="">Всички</option>
        {data.map((l) => (
          <option key={l.id} value={l.id}>
            {'  '.repeat(Math.max(0, l.level - 1))}
            {l.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export const categoryLabel = (lookups: AssetLookups | undefined, id: number | null | undefined) => lookups?.categories.find((c) => c.id === id)?.description ?? '';
export const terminationLabel = (lookups: AssetLookups | undefined, id: number) => lookups?.terminationTypes.find((c) => c.id === id)?.description ?? '';

export const MONTH_NAMES = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];
export const MONTH_SHORT = ['Яну', 'Фев', 'Мар', 'Апр', 'Май', 'Юни', 'Юли', 'Авг', 'Сеп', 'Окт', 'Ное', 'Дек'];

/* ------------------------------------------------------------------ */
/* Printable documents (protocols, change protocols)                    */
/* ------------------------------------------------------------------ */

const PRINT_CSS = `
.asset-print-portal { display: none; }
@media print {
  @page { size: A4 portrait; margin: 12mm; }
  html, body, #root { height: auto !important; background: #fff !important; }
  body > *:not(.asset-print-portal) { display: none !important; }
  .asset-print-portal { display: block; color: #000; font-size: 11px; }
  .asset-print-portal .grid-table { font-size: 10px; width: 100%; }
  .asset-print-portal .grid-table thead th { position: static; background: #e2e8f0; }
  .asset-print-portal .grid-table td, .asset-print-portal .grid-table th { white-space: normal; padding: 2px 4px; }
}
`;

/** Wraps a printable document: shows it on screen and prints only it with "Печат". */
export function PrintableDoc({ children, toolbar }: { children: ReactNode; toolbar?: ReactNode }) {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => {
      window.print();
      setTimeout(done, 500);
    }, 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);
  return (
    <>
      <style href="shmi-asset-print" precedence="default">
        {PRINT_CSS}
      </style>
      <div className="mb-2 flex items-center gap-2">
        <Button icon={<Printer className="size-3.5" />} onClick={() => setPrinting(true)}>
          Печат
        </Button>
        {toolbar}
      </div>
      <div className="rounded-sm border border-slate-300 bg-white p-6">{children}</div>
      {printing && createPortal(<div className="asset-print-portal">{children}</div>, document.body)}
    </>
  );
}

/** Company line at the top of the documents. */
export function DocHeader({ title, subtitle, company }: { title: string; subtitle?: ReactNode; company?: { companyName: string; bulstat?: string; address?: string } }) {
  const s = useSession();
  const name = company?.companyName || s.company.name;
  const bulstat = company?.bulstat || s.company.bulstat;
  return (
    <div className="mb-4">
      <div className="text-[12px]">
        {name}
        {bulstat ? `, ЕИК ${bulstat}` : ''}
        {company?.address ? `, ${company.address}` : ''}
      </div>
      <h1 className="mt-3 text-center text-[16px] font-bold">{title}</h1>
      {subtitle && <div className="text-center text-[12px]">{subtitle}</div>}
    </div>
  );
}

export function Signatures({ labels }: { labels: string[] }) {
  return (
    <div className="mt-10 grid gap-6 text-[12px]" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
      {labels.map((l) => (
        <div key={l}>
          {l} ....................
        </div>
      ))}
    </div>
  );
}

/** Sorted unique values helper. */
export function useUnique<T>(items: T[], pick: (t: T) => string | null | undefined) {
  return useMemo(() => [...new Set(items.map(pick).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'bg')), [items, pick]);
}
