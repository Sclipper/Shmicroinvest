import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dec, ZERO } from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate, money, moneyOrBlank } from '../format.ts';
import { Button, Dialog, Empty, Field, Spinner, TextInput, cx } from '../components/ui.tsx';

/** Shared types and widgets of the payments screens (Разплащания, Обвързване). */

export interface PaymentLink {
  id: number;
  paymentAccountingId: number;
  refAccountingId: number;
  accountId: number;
  accountNumber: string;
  companyId: number | null;
  companyName: string;
  amount: string;
  currencyAmount: string;
  refNumber: string;
  refDate: string;
  refDocumentType: string;
  refDocumentNumber: string;
  refDocumentDate: string;
  refTerm: string;
  refAmount: string;
  paymentNumber: string;
  paymentDate: string;
  paymentDocumentType: string;
  paymentDocumentNumber: string;
  paymentDocumentDate: string;
  paymentTerm: string;
  paymentAmount: string;
}

export interface OpenItemRow {
  accountingId: number;
  accountingNumber: string;
  accountingDate: string;
  isInitialBalance: boolean;
  accountId: number;
  accountNumber: string;
  accountDescription: string;
  companyId: number;
  companyName: string;
  side: 'client' | 'supplier';
  kind: 'liability' | 'payment' | 'none';
  currencyIso: string;
  documentTypeShortName: string | null;
  documentNumber: string | null;
  documentDate: string;
  dueDate: string | null;
  term: string | null;
  booked: string;
  open: string;
  openAbs: string;
  openCurrency: string;
  openCurrencyAbs: string;
  exchangeRate: string;
  label: string;
  links?: PaymentLink[];
}

export interface PartnerOpenItems {
  liabilities: OpenItemRow[];
  payments: OpenItemRow[];
  balance: string;
  currencyBalance: string;
}

/** Cash and bank categories: Каса/Разплащателна сметка in base and foreign currency, other cash. */
export const PAYMENT_ACCOUNT_CATEGORIES = [21, 22, 26, 27, 58];

const valid = (x: string | null | undefined) => !!x && /^-?\d+(\.\d+)?$/.test(x.trim());
/** Sum of money strings (invalid input counts as zero), as a 2-decimal string. */
export const sum = (xs: (string | null | undefined)[]) => xs.reduce((a, x) => (valid(x) ? a.plus(dec(x!.trim())) : a), ZERO).toFixed(2);
/** Smaller of two money strings. */
export const minOf = (a: string, b: string) => (dec(a).lessThan(dec(b)) ? dec(a).toFixed(2) : dec(b).toFixed(2));

export const opLabel = (i: Pick<OpenItemRow, 'side' | 'kind'>) =>
  i.kind === 'payment' ? 'Плащане' : i.side === 'client' ? 'Вземане' : 'Задължение';

export interface Allocation { amount: string; currencyAmount?: string }

/**
 * Grid of open documents with a checkbox and an editable amount per row
 * (the centre/right grids of F3 and BindingDocumentsView).
 */
export function OpenItemsGrid({ rows, selected, onToggle, onAmount, onRowClick, activeId, showCurrency, testId }: {
  rows: OpenItemRow[];
  selected: Map<number, Allocation>;
  onToggle: (row: OpenItemRow, on: boolean) => void;
  onAmount?: (row: OpenItemRow, amount: string) => void;
  onRowClick?: (row: OpenItemRow) => void;
  activeId?: number | null;
  showCurrency?: boolean;
  testId?: string;
}) {
  if (!rows.length) return <Empty>Няма документи.</Empty>;
  return (
    <table className="grid-table" data-testid={testId}>
      <thead>
        <tr>
          <th className="w-6" />
          <th>Операция</th>
          <th>Контиране</th>
          <th>Тип документи</th>
          <th>Документ №</th>
          <th>Дата</th>
          <th>Сметка</th>
          <th className="text-right">Салдо</th>
          {showCurrency && <th className="text-right">Валутно салдо</th>}
          {showCurrency && <th className="text-right">Курс</th>}
          <th className="text-right">Сума</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const a = selected.get(r.accountingId);
          return (
            <tr key={`${r.accountingId}:${r.accountId}`} aria-selected={activeId === r.accountingId} onClick={() => onRowClick?.(r)} className="cursor-default" data-doc={r.documentNumber ?? ''}>
              <td>
                <input type="checkbox" className="size-3.5 accent-brand-500" aria-label={`Избор ${r.label}`} checked={!!a} onChange={(e) => onToggle(r, e.target.checked)} onClick={(e) => e.stopPropagation()} />
              </td>
              <td>{opLabel(r)}</td>
              <td>{r.isInitialBalance ? 'Н.С.' : r.accountingNumber}</td>
              <td>{r.documentTypeShortName}</td>
              <td className="font-medium">{r.documentNumber}</td>
              <td>{bgDate(r.documentDate)}</td>
              <td>{r.accountNumber}</td>
              <td className="num">{money(r.openAbs)}</td>
              {showCurrency && <td className="num">{moneyOrBlank(r.openCurrencyAbs)} {Number(r.openCurrencyAbs) ? r.currencyIso : ''}</td>}
              {showCurrency && <td className="num">{Number(r.exchangeRate) ? Number(r.exchangeRate).toFixed(5) : ''}</td>}
              <td className="w-28 py-0">
                {a && onAmount ? (
                  <TextInput aria-label={`Сума ${r.label}`} className="h-6 w-24 text-right" value={a.amount} onClick={(e) => e.stopPropagation()} onChange={(e) => onAmount(r, e.target.value)} />
                ) : (
                  <span className={cx('num block', !a && 'text-slate-400')}>{a ? money(a.amount) : ''}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={7}>Общо</td>
          <td className="num">{money(sum(rows.map((r) => r.openAbs)))}</td>
          {showCurrency && <td className="num">{money(sum(rows.map((r) => r.openCurrencyAbs)))}</td>}
          {showCurrency && <td />}
          <td className="num">{money(sum([...selected.values()].map((a) => a.amount)))}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** Toggling a row selects its whole open amount. */
export function toggleIn(map: Map<number, Allocation>, row: OpenItemRow, on: boolean) {
  const next = new Map(map);
  if (!on) next.delete(row.accountingId);
  else next.set(row.accountingId, { amount: dec(row.openAbs).toFixed(2) });
  return next;
}

export const toRows = (map: Map<number, Allocation>) => [...map.entries()].map(([accountingId, a]) => ({ accountingId, amount: a.amount || null }));

/**
 * BindingDocumentsView (Обвързване): open documents of one account and partner
 * with a number/date filter and an editable amount per row.
 */
export function BindingDocumentsDialog({ accountId, companyId, excludeAccountingId, kind, onClose, onOk, busy }: {
  accountId: number;
  companyId: number;
  excludeAccountingId?: number | null;
  /** Which documents may be chosen; undefined = both. */
  kind?: 'liability' | 'payment';
  onClose: () => void;
  onOk: (rows: { accountingId: number; amount: string | null }[]) => void;
  busy?: boolean;
}) {
  const [f, setF] = useState({ number: '', from: '', to: '' });
  const [sel, setSel] = useState(new Map<number, Allocation>());
  const q = useQuery({
    queryKey: ['payments', 'candidates', accountId, companyId, excludeAccountingId],
    queryFn: () => api.get<OpenItemRow[]>(`/payments/candidates${qs({ accountId, companyId, exclude: excludeAccountingId ?? undefined })}`),
  });
  const rows = useMemo(() => (q.data ?? []).filter((r) => (!kind || r.kind === kind)
    && (!f.number || (r.documentNumber ?? '').toLowerCase().startsWith(f.number.toLowerCase()))
    && (!f.from || r.documentDate >= f.from) && (!f.to || r.documentDate <= f.to)), [q.data, f, kind]);
  const showCurrency = rows.some((r) => Number(r.openCurrencyAbs) !== 0);
  return (
    <Dialog
      title="Обвързване на документи"
      onClose={onClose}
      width={860}
      footer={
        <>
          <Button onClick={() => setSel(new Map())}>Изчистване</Button>
          <Button variant="primary" disabled={!sel.size || busy} onClick={() => onOk(toRows(sel))}>
            ОК
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <Field label="Документ №">
          <TextInput value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} className="w-32" />
        </Field>
        <Field label="От дата">
          <TextInput type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="w-36" />
        </Field>
        <Field label="До дата">
          <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" />
        </Field>
      </div>
      <div className="max-h-[45vh] overflow-auto border border-slate-200">
        {q.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : (
          <OpenItemsGrid
            rows={rows}
            selected={sel}
            showCurrency={showCurrency}
            testId="binding-grid"
            onToggle={(r, on) => setSel(toggleIn(sel, r, on))}
            onAmount={(r, v) => setSel(new Map(sel).set(r.accountingId, { amount: v }))}
          />
        )}
      </div>
    </Dialog>
  );
}
