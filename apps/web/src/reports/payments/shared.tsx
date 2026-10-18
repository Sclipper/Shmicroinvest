import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import { isCompanyCategory } from '@shmi/core';
import { Button, Field, Select, TextInput } from '../../components/ui.tsx';
import { useAccounts, useLookups } from '../../session.tsx';
import type { Account } from '../../types.ts';

/** Helpers shared by the partner and cash report screens (spec 05 6). */

/** Partner-category accounts and their ancestors (partner reports pick only these). */
export function usePartnerAccountFilter() {
  const { data: accounts = [] } = useAccounts();
  return useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const ok = new Set<number>();
    for (const a of accounts) {
      if (!isCompanyCategory(a.categoryId)) continue;
      let p: Account | undefined = a;
      while (p && !ok.has(p.id)) {
        ok.add(p.id);
        p = p.parentId != null ? byId.get(p.parentId) : undefined;
      }
    }
    return (a: Account) => ok.has(a.id);
  }, [accounts]);
}

/** Cash-category accounts (base/foreign cash, other cash) for the cash report combos. */
export const CASH_CATEGORIES = [21, 26, 58];

export function CashAccountSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const { data: accounts = [] } = useAccounts();
  const list = accounts.filter((a) => a.categoryId != null && CASH_CATEGORIES.includes(a.categoryId));
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className ?? 'w-64'} aria-label="Сметка">
      {!list.some((a) => a.number === value) && <option value={value}>{value}</option>}
      {list.map((a) => (
        <option key={a.id} value={a.number}>
          {a.number} {a.description}
        </option>
      ))}
    </Select>
  );
}

export function DocumentTypeSelect({ value, onChange, disabled, label = 'Тип документ', only }: { value: number | null; onChange: (v: number | null) => void; disabled?: boolean; label?: string; only?: number[] }) {
  const { data } = useLookups();
  const types = (data?.documentTypes ?? []).filter((d) => (only ? only.includes(d.id) : d.isVisible));
  return (
    <Field label={label}>
      <Select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className="w-48">
        {!only && <option value="">Всички</option>}
        {types.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ReportTypeSelect({ value, onChange, items = ['Стандартна', 'Валутна'] }: { value: number; onChange: (v: number) => void; items?: string[] }) {
  return (
    <Field label="Тип справка">
      <Select value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-36">
        {items.map((t, i) => (
          <option key={t} value={i}>
            {t}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** "Филтър по" + text of the partner reports. */
export function ColumnFilter({ columns, column, text, onChange }: { columns: [string, string][]; column: string; text: string; onChange: (column: string, text: string) => void }) {
  return (
    <>
      <Field label="Филтър по">
        <Select value={column} onChange={(e) => onChange(e.target.value, text)} className="w-40">
          {columns.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Филтър">
        <TextInput value={text} onChange={(e) => onChange(column, e.target.value)} className="w-40" />
      </Field>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Portrait print of letters and forms                                 */
/* ------------------------------------------------------------------ */

const LETTER_CSS = `
.pay-sheet { background: #fff; color: #000; }
@page pay-portrait { size: A4 portrait; margin: 15mm; }
@media print {
  .pay-sheet { page: pay-portrait; break-after: page; font-size: 11px; }
  .pay-sheet:last-child { break-after: auto; }
  .pay-sheet table { width: 100%; border-collapse: collapse; }
  .pay-sheet .no-print { display: none; }
}
`;

/**
 * "Печат" of a letter or a form report: renders the sheets into a print portal
 * (.report-print-portal, the class the report frame's print CSS shows) on A4
 * portrait, one sheet per page.
 */
export function SheetPrintButton({ label = 'Печат на бланките', disabled, children }: { label?: string; disabled?: boolean; children: () => ReactNode }) {
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
      <style href="shmi-pay-letter" precedence="default">
        {LETTER_CSS}
      </style>
      <Button icon={<Printer className="size-3.5" />} disabled={disabled} onClick={() => setPrinting(true)}>
        {label}
      </Button>
      {printing && createPortal(<div className="report-print-portal">{children()}</div>, document.body)}
    </>
  );
}

/** A letter or form sheet: on screen a white page, in print one A4 portrait page. */
export function Sheet({ children }: { children: ReactNode }) {
  return <div className="pay-sheet mx-auto my-3 max-w-[210mm] border border-slate-300 p-8 text-[12px] shadow-sm print:m-0 print:max-w-none print:border-0 print:p-0 print:shadow-none">{children}</div>;
}
