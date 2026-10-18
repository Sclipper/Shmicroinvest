import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet, Play, Printer } from 'lucide-react';
import { buildXlsx, type XlsxCell, type XlsxSheet } from '@shmi/core';
import { bgDate, moneyOrBlank } from '../format.ts';
import { AccountPicker } from '../components/pickers.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, CommandBar, Empty, ErrorText, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useSession } from '../session.tsx';
import type { Account } from '../types.ts';

/* ------------------------------------------------------------------ */
/* Period                                                              */
/* ------------------------------------------------------------------ */

export interface Period {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

function presets(year: number): { key: string; label: string; from: string; to: string }[] {
  const out = [{ key: 'y', label: `Цялата ${year} г.`, from: `${year}-01-01`, to: `${year}-12-31` }];
  for (let q = 1; q <= 4; q++) {
    const m1 = (q - 1) * 3 + 1;
    out.push({ key: `q${q}`, label: `${['I', 'II', 'III', 'IV'][q - 1]} тримесечие`, from: `${year}-${pad(m1)}-01`, to: `${year}-${pad(m1 + 2)}-${lastDay(year, m1 + 2)}` });
  }
  MONTHS.forEach((name, i) => out.push({ key: `m${i + 1}`, label: name, from: `${year}-${pad(i + 1)}-01`, to: `${year}-${pad(i + 1)}-${lastDay(year, i + 1)}` }));
  return out;
}

/** Default period = the active financial year. */
export function useYearPeriod(): Period {
  const s = useSession();
  return { from: `${s.year.year}-01-01`, to: `${s.year.year}-12-31` };
}

/** "Период" picker: preset list plus От дата / До дата (spec 05 1.4). */
export function PeriodFields({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const s = useSession();
  const list = useMemo(() => presets(s.year.year), [s.year.year]);
  const current = list.find((p) => p.from === value.from && p.to === value.to)?.key ?? '';
  return (
    <>
      <Field label="Период">
        <Select
          value={current}
          className="w-40"
          onChange={(e) => {
            const p = list.find((x) => x.key === e.target.value);
            if (p) onChange({ from: p.from, to: p.to });
          }}
        >
          <option value="">Избран период</option>
          {list.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="От дата">
        <TextInput type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-36" required />
      </Field>
      <Field label="До дата">
        <TextInput type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-36" required />
      </Field>
    </>
  );
}

export const periodText = (p: Period) => `от ${bgDate(p.from)} до ${bgDate(p.to)}`;

/* ------------------------------------------------------------------ */
/* Level / account                                                     */
/* ------------------------------------------------------------------ */

export const LEVELS = ['Синтетична', '1-во аналитично ниво', '2-ро аналитично ниво', '3-то аналитично ниво', '4-то аналитично ниво', '5-то аналитично ниво'];

/** "Ниво на справка": sub-account level N = tree level N + 2. */
export function LevelSelect({ value, onChange, className }: { value: number; onChange: (v: number) => void; className?: string }) {
  return (
    <Field label="Ниво на справка">
      <Select value={value} onChange={(e) => onChange(Number(e.target.value))} className={cx('w-56', className)}>
        {LEVELS.map((l, i) => (
          <option key={i} value={i}>
            {l}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Account picker working with the account number (reports filter by number with the 05 2.5 rule). */
export function AccountNumberPicker({ value, onChange, className, invalid, filter }: { value: string; onChange: (number: string, account: Account | null) => void; className?: string; invalid?: boolean; filter?: (a: Account) => boolean }) {
  const { data = [] } = useAccounts();
  const id = data.find((a) => a.number === value)?.id ?? null;
  return <AccountPicker value={id} leafOnly={false} onChange={(a) => onChange(a?.number ?? '', a)} className={className ?? 'w-64'} invalid={invalid} filter={filter} />;
}

export function useAccountName() {
  const { data = [] } = useAccounts();
  const map = useMemo(() => new Map(data.map((a) => [a.number, a.description])), [data]);
  return (n: string) => map.get(n) ?? '';
}

/* ------------------------------------------------------------------ */
/* Running a report                                                    */
/* ------------------------------------------------------------------ */

/**
 * Report query that runs only on "Справка". Every run refetches, even with
 * unchanged filters (the counter is part of the key).
 */
export function useReport<F, T>(name: string, filters: F, fetcher: (f: F) => Promise<T>, validate?: (f: F) => string | null) {
  const s = useSession();
  const dialogs = useDialogs();
  const [applied, setApplied] = useState<{ f: F; n: number } | null>(null);
  const q = useQuery({
    queryKey: ['reports', name, s.year.id, applied],
    queryFn: () => fetcher(applied!.f),
    enabled: !!applied,
    staleTime: Infinity,
    retry: false,
  });
  const run = () => {
    const err = validate?.(filters);
    if (err) {
      void dialogs.alert(err);
      return;
    }
    setApplied((a) => ({ f: filters, n: (a?.n ?? 0) + 1 }));
  };
  return { q, applied: applied?.f ?? null, run };
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

/** A cell: strings are written as text, numbers as amounts with a decimal comma. */
export type Cell = string | number | null | undefined;

/** Amount cell from an API decimal string. */
export const amt = (v: string | number | null | undefined): Cell => (v === null || v === undefined || v === '' ? '' : Number(v));

function csvCell(c: Cell) {
  if (c === null || c === undefined) return '';
  const s = typeof c === 'number' ? c.toFixed(2).replace('.', ',') : c;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Client-side CSV: ";" separator, UTF-8 BOM, CRLF (opens directly in a Bulgarian Excel). */
export function downloadCsv(fileName: string, rows: Cell[][]) {
  const text = '\uFEFF' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Excel export (spec 05 11.1)                                         */
/* ------------------------------------------------------------------ */

/** .xlsx workbook built in the browser (one sheet per entry). */
export function downloadXlsx(fileName: string, sheets: XlsxSheet[]) {
  const data = buildXlsx(sheets);
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = (fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`).replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV-style rows as one sheet: the title rows in bold, amounts as numbers. */
export function rowsToSheet(name: string, rows: Cell[][], titleRows = 0): XlsxSheet {
  const widths: number[] = [];
  for (const r of rows.slice(titleRows)) r.forEach((c, i) => { widths[i] = Math.min(60, Math.max(widths[i] ?? 8, typeof c === 'number' ? 14 : String(c ?? '').length + 2)); });
  return { name, rows: rows as XlsxCell[][], widths, boldRows: Array.from({ length: titleRows + 1 }, (_, i) => i) };
}

/* ------------------------------------------------------------------ */
/* Report screen frame                                                 */
/* ------------------------------------------------------------------ */

const PRINT_CSS = `
.report-print-portal { display: none; }
.grid-table thead tr.hdr1 th { height: 26px; }
.grid-table thead tr.hdr2 th { top: 26px; }
.grid-table tfoot tr.ft1 td { bottom: 27px; }
.grid-table tfoot tr.ft1 + tr.ft1 td { bottom: 0; }
.grid-table tfoot tr.ft2 td { bottom: 54px; }
.grid-table tbody tr.grp td { background: var(--color-slate-100); font-weight: 600; }
@media print {
  @page { size: A4 landscape; margin: 10mm; }
  html, body, #root { height: auto !important; background: #fff !important; }
  body > *:not(.report-print-portal) { display: none !important; }
  .report-print-portal { display: block; color: #000; font-size: 11px; }
  .report-print-portal * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .report-print-portal .grid-table { font-size: 9.5px; width: 100%; }
  .report-print-portal .grid-table thead th, .report-print-portal .grid-table tfoot td { position: static; }
  .report-print-portal .grid-table thead th { background: #e2e8f0; }
  .report-print-portal .grid-table thead { display: table-header-group; }
  .report-print-portal .grid-table tfoot { display: table-row-group; }
  .report-print-portal .grid-table tr { break-inside: avoid; }
  .report-print-portal .grid-table td, .report-print-portal .grid-table th { padding: 1px 4px; white-space: normal; }
  .report-print-portal .grid-table td.num, .report-print-portal .grid-table td.nowrap { white-space: nowrap; }
  .report-print-portal .grid-table { max-width: none; }
  .report-print-portal .grid-table [class*="w-"] { width: auto !important; max-width: none !important; }
  .report-print-portal .grid-table .truncate { overflow: visible; text-overflow: clip; }
}
`;

export interface ReportFrameProps<T> {
  /** Report title, e.g. "Оборотна ведомост". */
  title: string;
  /** Line(s) under the title in print and in the result header (period, account...). */
  subtitle?: ReactNode;
  /** Filter fields (rendered inside the form; Enter submits). */
  filters: ReactNode;
  /** Extra filter row (checkboxes). */
  options?: ReactNode;
  report: { q: UseQueryResult<T>; applied: unknown; run: () => void };
  isEmpty: (data: T) => boolean;
  /** Text at the right end of the command bar. */
  status?: (data: T) => ReactNode;
  /** CSV rows (title rows are added automatically). */
  csv?: (data: T) => Cell[][];
  csvName: string;
  /** Excel workbook; defaults to the CSV rows as one sheet. */
  xlsx?: (data: T) => XlsxSheet[];
  /** Extra command-bar buttons (data is set once a result is shown). */
  actions?: (data: T | undefined) => ReactNode;
  /** Result table. */
  children: (data: T) => ReactNode;
}

/** Common report screen: command bar (Справка / Печат / Експорт CSV), filter form, result grid, print portal. */
export function ReportFrame<T>({ title, subtitle, filters, options, report, isEmpty, status, csv, csvName, xlsx, actions, children }: ReportFrameProps<T>) {
  const s = useSession();
  const formId = useId();
  const [printing, setPrinting] = useState(false);
  const { q, applied, run } = report;
  const data = applied ? q.data : undefined;
  const ready = data !== undefined && !q.isFetching && !isEmpty(data);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => {
      window.print();
      // Some browsers do not fire afterprint for a cancelled dialog.
      setTimeout(done, 500);
    }, 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  const exportCsv = () => {
    if (!data || !csv) return;
    downloadCsv(`${csvName}.csv`, [[`${title} на ${s.company.name}`], typeof subtitle === 'string' ? [subtitle] : [], [], ...csv(data)]);
  };

  const exportXlsx = () => {
    if (!data) return;
    const titleRows: Cell[][] = [[`${title} на ${s.company.name}`], typeof subtitle === 'string' ? [subtitle] : [], []];
    downloadXlsx(csvName, xlsx ? xlsx(data) : [rowsToSheet(title, [...titleRows, ...(csv?.(data) ?? [])], titleRows.length)]);
  };

  const header = (
    <div className="mb-2">
      <div className="text-[11px] text-slate-600">{s.company.name}{s.company.bulstat ? `, ЕИК ${s.company.bulstat}` : ''}</div>
      <h1 className="text-[16px] font-bold">{title}</h1>
      {subtitle && <div className="text-[12px]">{subtitle}</div>}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <style href="shmi-report-print" precedence="default">
        {PRINT_CSS}
      </style>
      <CommandBar right={<span className="flex items-center gap-2 text-[12px] text-slate-500">{q.isFetching && <Spinner className="size-3.5" />}{data !== undefined && status?.(data)}</span>}>
        <Button type="submit" form={formId} variant="primary" icon={<Play className="size-3.5" />}>
          Справка
        </Button>
        <Button icon={<Printer className="size-3.5" />} disabled={!ready} onClick={() => setPrinting(true)}>
          Печат
        </Button>
        {csv && (
          <Button icon={<FileDown className="size-3.5" />} disabled={!ready} onClick={exportCsv}>
            Експорт CSV
          </Button>
        )}
        {(csv || xlsx) && (
          <Button icon={<FileSpreadsheet className="size-3.5" />} disabled={!ready} onClick={exportXlsx}>
            Експорт Excel
          </Button>
        )}
        {actions?.(ready ? data : undefined)}
      </CommandBar>
      <form
        id={formId}
        className="border-b border-slate-200 bg-white px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          {filters}
        </div>
        {options && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">{options}</div>}
      </form>
      {data !== undefined && subtitle && (
        <div className="flex items-baseline gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1 text-[12px] text-slate-600">
          <span className="font-semibold text-slate-800">{title}</span>
          <span>{subtitle}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!applied ? (
          <Empty>Задайте условията и натиснете „Справка“ (Enter).</Empty>
        ) : q.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : q.error ? (
          <div className="p-3">
            <ErrorText error={q.error} />
          </div>
        ) : data === undefined || isEmpty(data) ? (
          <Empty>Няма данни за избраните условия.</Empty>
        ) : (
          children(data)
        )}
      </div>
      {printing &&
        data !== undefined &&
        createPortal(
          <div className="report-print-portal">
            {header}
            {children(data)}
            <div className="mt-6 flex justify-between text-[11px]">
              <span>Съставил: ....................</span>
              <span>Гл. счетоводител: ....................</span>
              <span>Управител: ....................</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Amount cell that leaves zeroes blank (Delta prints empty cells for 0). */
export function Amt({ v, className }: { v: string | number | null | undefined; className?: string }) {
  return <td className={cx('num', className)}>{moneyOrBlank(v)}</td>;
}

/** Sum of decimal strings, rounded to cents (for client-side totals). */
export const sum = <T,>(rows: T[], pick: (r: T) => string | number | null | undefined) => Math.round(rows.reduce((a, r) => a + Number(pick(r) ?? 0), 0) * 100) / 100;
