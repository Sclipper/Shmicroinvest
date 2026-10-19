import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet, Mail, Play, Printer } from 'lucide-react';
import { ZERO, buildXlsx, dec, mergeSavedFilter, periodPresets, type PeriodPreset, type XlsxCell, type XlsxSheet } from '@shmi/core';
import { api } from '../api.ts';
import { DateInput } from '../components/DateInput.tsx';
import { bgDate, moneyOrBlank } from '../format.ts';
import { AccountPicker } from '../components/pickers.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, CommandBar, Empty, ErrorText, Field, Select, Spinner, cx } from '../components/ui.tsx';
import { useAccounts, useSession } from '../session.tsx';
import type { Account } from '../types.ts';
import { useShortcuts } from '../screens/entry/shortcuts.ts';
import { useQuickCommands } from '../shell/quickCommands.tsx';
import { ReportEmailDialog } from './ReportEmail.tsx';

/* ------------------------------------------------------------------ */
/* Period                                                              */
/* ------------------------------------------------------------------ */

export interface Period {
  from: string;
  to: string;
}

/** Default period = the active financial year (from its start date). */
export function useYearPeriod(): Period {
  const s = useSession();
  const start = s.year.startDate?.startsWith(String(s.year.year)) ? s.year.startDate.slice(0, 10) : `${s.year.year}-01-01`;
  return { from: start, to: `${s.year.year}-12-31` };
}

/** Presets of the active year (PeriodPickerPeriods, spec 05 1.4). */
export function usePeriodPresets(): PeriodPreset[] {
  const s = useSession();
  const years = useQuery({ queryKey: ['years'], queryFn: () => api.get<{ year: number; startDate: string }[]>('/years'), staleTime: 5 * 60_000 });
  const previous = years.data?.find((y) => y.year === s.year.year - 1)?.startDate ?? null;
  return useMemo(() => periodPresets(s.year, s.workingDate, previous), [s.year, s.workingDate, previous]);
}

/**
 * "Период" picker: preset list plus От дата / До дата in dd.MM.yyyy (spec 05 1.4).
 * Choosing a preset fills both dates; editing a date shows "Избран период" (Custom).
 */
export function PeriodFields({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const list = usePeriodPresets();
  const current = list.find((p) => p.from === value.from && p.to === value.to)?.id ?? 0;
  return (
    <>
      <Field label="Период">
        <Select
          value={current}
          className="w-48"
          aria-label="Период"
          onChange={(e) => {
            const p = list.find((x) => x.id === Number(e.target.value));
            if (p) onChange({ from: p.from, to: p.to });
          }}
        >
          <option value={0}>Избран период</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="От дата">
        <DateInput value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="w-32" aria-label="От дата" required />
      </Field>
      <Field label="До дата">
        <DateInput value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="w-32" aria-label="До дата" required />
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

const filterUrl = (name: string) => `/settings/report-filters/${encodeURIComponent(name)}`;

/** Stores the filter a report ran with (per user, 05 1.2 SavePropertyState). */
function saveReportFilter(name: string, filters: unknown) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return;
  void api.put(filterUrl(name), filters).catch(() => undefined);
}

/**
 * Filter state of a report screen, restored from the user's last run of the
 * report (GetPropertyStateValue, 05 1.2). The name must be the one passed to
 * useReport, which saves the filter on every "Справка".
 */
export function useReportFilters<F extends object>(name: string, defaults: F): [F, Dispatch<SetStateAction<F>>] {
  const s = useSession();
  const [f, setF] = useState(defaults);
  const touched = useRef(false);
  const saved = useQuery({ queryKey: ['reportFilter', name], queryFn: () => api.get<{ value: Record<string, unknown> | null }>(filterUrl(name)), staleTime: 0, gcTime: 0, retry: false });
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !saved.data) return;
    restored.current = true;
    // The user started typing before the saved filter arrived: keep the typed values.
    if (!touched.current) setF((cur) => mergeSavedFilter(cur, saved.data.value, s.year.year));
  }, [saved.data, s.year.year]);
  const set: Dispatch<SetStateAction<F>> = (v) => {
    touched.current = true;
    setF(v);
  };
  return [f, set];
}

/**
 * Report query that runs only on "Справка". Every run refetches, even with
 * unchanged filters (the counter is part of the key), and stores the filter
 * as the user's last filter of the report.
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
    saveReportFilter(name, filters);
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
  /**
   * Entity type of the print/export rows of the activity log (01b 8):
   * turnoverReport, chronologicalReport, analyticalReport, icaReport; others log "report".
   */
  logEntity?: string;
}

/** ЕкспортНаСправка / ПечатНаСправка (01b 8); a failed log write never blocks the report. */
export function logReportActivity(activity: 'print' | 'export', entityType: string, description: string) {
  void api.post('/activity/log', { activity, entityType, description }).catch(() => undefined);
}

/** End date of the applied filter, for the attachment name (05 11.1). */
const endDateOf = (applied: unknown): string | null => {
  const a = applied as { to?: unknown; endDate?: unknown } | null;
  const v = a?.to ?? a?.endDate;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

const REPORT_COMMANDS = ['Print', 'Export'] as const;

/** Date and time of a printout, "dd.MM.yyyy HH:mm" (Europe/Sofia). */
export function printedAt(d = new Date()) {
  const p = new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('day')}.${v('month')}.${v('year')} ${v('hour')}:${v('minute')}`;
}

/** "Визуализиране на дата и час в справки" (IsVisualizeDateTimeOnReportingEnabled, 06 3.4). */
export function useShowPrintDateTime() {
  const s = useSession();
  return (s.settings?.IsVisualizeDateTimeOnReportingEnabled ?? '').toLowerCase() === 'true';
}

/** Opens the browser print dialog while `printing` is set; resets it when the dialog closes. */
export function usePrinting(): [boolean, () => void] {
  const [printing, setPrinting] = useState(false);
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
  return [printing, () => setPrinting(true)];
}

/** Print-only copy of a report: company, title, subtitle, optional date and time, body, signature lines. */
export function PrintPortal({ title, subtitle, children, signatures = true }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; signatures?: boolean }) {
  const s = useSession();
  const withTime = useShowPrintDateTime();
  return createPortal(
    <div className="report-print-portal">
      <style href="shmi-report-print" precedence="default">
        {PRINT_CSS}
      </style>
      <div className="mb-2">
        <div className="flex justify-between text-[11px] text-slate-600">
          <span>{s.company.name}{s.company.bulstat ? `, ЕИК ${s.company.bulstat}` : ''}</span>
          {withTime && <span data-testid="print-date-time">Дата и час: {printedAt()}</span>}
        </div>
        <h1 className="text-[16px] font-bold">{title}</h1>
        {subtitle && <div className="text-[12px]">{subtitle}</div>}
      </div>
      {children}
      {signatures && (
        <div className="mt-6 flex justify-between text-[11px]">
          <span>Съставил: ....................</span>
          <span>Гл. счетоводител: ....................</span>
          <span>Управител: ....................</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Common report screen: command bar (Справка / Печат / Експорт CSV), filter form, result grid, print portal. */
export function ReportFrame<T>({ title, subtitle, filters, options, report, isEmpty, status, csv, csvName, xlsx, actions, children, logEntity = 'report' }: ReportFrameProps<T>) {
  const s = useSession();
  const formId = useId();
  const [printing, startPrint] = usePrinting();
  const [emailing, setEmailing] = useState(false);
  const shortcuts = useShortcuts();
  const { q, applied, run } = report;
  const data = applied ? q.data : undefined;
  const ready = data !== undefined && !q.isFetching && !isEmpty(data);
  const canExport = !!(csv || xlsx);

  const print = () => {
    if (!ready) return;
    logReportActivity('print', logEntity, title);
    startPrint();
  };

  const exportCsv = () => {
    if (!ready || !data || !csv) return;
    logReportActivity('export', logEntity, `${title} (CSV)`);
    downloadCsv(`${csvName}.csv`, [[`${title} на ${s.company.name}`], typeof subtitle === 'string' ? [subtitle] : [], [], ...csv(data)]);
  };

  const sheets = (d: T) => {
    const titleRows: Cell[][] = [[`${title} на ${s.company.name}`], typeof subtitle === 'string' ? [subtitle] : [], []];
    return xlsx ? xlsx(d) : [rowsToSheet(title, [...titleRows, ...(csv?.(d) ?? [])], titleRows.length)];
  };

  const exportXlsx = () => {
    if (!ready || !data || !canExport) return;
    logReportActivity('export', logEntity, `${title} (Excel)`);
    downloadXlsx(csvName, sheets(data));
  };

  // Window shortcuts of the reports (06 2.6): Печат Ctrl+P, Експорт Ctrl+E, with the user's overrides.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const cmd = shortcuts.match(e, REPORT_COMMANDS);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    if (cmd === 'Print') print();
    else exportXlsx();
  };

  useQuickCommands([
    {
      title: title,
      items: [
        { label: 'Справка', run },
        { label: 'Печат', run: print, disabled: !ready, gesture: shortcuts.gesture('Print') },
        ...(canExport ? [
          { label: 'Експорт Excel', run: exportXlsx, disabled: !ready, gesture: shortcuts.gesture('Export') },
          { label: 'Изпращане по e-mail', run: () => ready && setEmailing(true), disabled: !ready },
        ] : []),
      ],
    },
  ]);

  return (
    <div className="flex h-full flex-col outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <style href="shmi-report-print" precedence="default">
        {PRINT_CSS}
      </style>
      <CommandBar right={<span className="flex items-center gap-2 text-[12px] text-slate-500">{q.isFetching && <Spinner className="size-3.5" />}{data !== undefined && status?.(data)}</span>}>
        <Button type="submit" form={formId} variant="primary" icon={<Play className="size-3.5" />}>
          Справка
        </Button>
        <Button icon={<Printer className="size-3.5" />} disabled={!ready} onClick={print} title={shortcuts.gesture('Print')}>
          Печат
        </Button>
        {csv && (
          <Button icon={<FileDown className="size-3.5" />} disabled={!ready} onClick={exportCsv}>
            Експорт CSV
          </Button>
        )}
        {canExport && (
          <Button icon={<FileSpreadsheet className="size-3.5" />} disabled={!ready} onClick={exportXlsx} title={shortcuts.gesture('Export')}>
            Експорт Excel
          </Button>
        )}
        {canExport && (
          <Button icon={<Mail className="size-3.5" />} disabled={!ready} onClick={() => setEmailing(true)}>
            Изпращане по e-mail
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
      {printing && data !== undefined && (
        <PrintPortal title={title} subtitle={subtitle}>
          {children(data)}
        </PrintPortal>
      )}
      {emailing && data !== undefined && (
        <ReportEmailDialog title={title} sheets={() => sheets(data)} endDate={endDateOf(applied)} entityType={logEntity} onClose={() => setEmailing(false)} />
      )}
    </div>
  );
}

/** Amount cell that leaves zeroes blank (Delta prints empty cells for 0). */
export function Amt({ v, className }: { v: string | number | null | undefined; className?: string }) {
  return <td className={cx('num', className)}>{moneyOrBlank(v)}</td>;
}

/** Sum of decimal strings with decimal.js, as a 2-decimal string (client-side totals; never JS floats). */
export const sum = <T,>(rows: T[], pick: (r: T) => string | number | null | undefined): string =>
  rows.reduce((a, r) => {
    const v = pick(r);
    return v === null || v === undefined || v === '' ? a : a.plus(dec(v));
  }, ZERO).toFixed(2);
