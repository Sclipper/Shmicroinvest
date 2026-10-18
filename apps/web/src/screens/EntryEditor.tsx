import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Save, Scale, Trash2, Undo2, X } from 'lucide-react';
import { amountFromCurrency, amountFromQuantity, dec, formatMoney, isCompanyCategory, parseAmount } from '@shmi/core';
import { api } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { DictionaryInput } from '../components/DictionaryInput.tsx';
import { AccountPicker, PartnerPicker } from '../components/pickers.tsx';
import { Button, CommandBar, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../session.tsx';
import { useWorkspace, type ScreenProps } from '../shell/workspace.tsx';
import type { Account } from '../types.ts';
import { EntryPaymentPanel, useEntryPayment } from '../payments/EntryPaymentPanel.tsx';

interface Line {
  accountId: number | null;
  amount: string;
  companyId: number | null;
  companyName?: string | null;
  currencyAmount: string;
  exchangeRate: string;
  quantity: string;
  price: string;
  description: string;
  vatTermId: number | null;
}

interface Draft {
  id?: number;
  number: string;
  accountingDate: string;
  documentDate: string;
  documentTypeId: number | null;
  documentNumber: string;
  companyId: number | null;
  companyName?: string | null;
  term: string;
  reference: string;
  optionalReference: string;
  paragraph: string;
  transactionTypeId: number;
  viesId: number | null;
  viesMonth: string;
  dueDate: string;
  isInitialBalance: boolean;
  source?: string;
  debits: Line[];
  credits: Line[];
}

const emptyLine = (): Line => ({ accountId: null, amount: '', companyId: null, currencyAmount: '', exchangeRate: '', quantity: '', price: '', description: '', vatTermId: null });

const toInput = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Number(v)).replace('.', ','));
const toApi = (v: string) => {
  const d = parseAmount(v);
  return d ? d.toString() : null;
};

function newDraft(date: string, isInitialBalance = false): Draft {
  return {
    number: '', accountingDate: date, documentDate: date, documentTypeId: isInitialBalance ? null : 1, documentNumber: '', companyId: null,
    term: '', reference: '', optionalReference: '', paragraph: '', transactionTypeId: 1, viesId: null, viesMonth: date.slice(0, 8) + '01',
    dueDate: '', isInitialBalance, debits: [emptyLine()], credits: [emptyLine()],
  };
}

/** Контиране (F2) / Редакция на контиране: header + debit/credit grids (spec 02a section 4). */
export function EntryEditor({ tab }: ScreenProps) {
  const session = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const can = useCan();
  const lookups = useLookups();
  const accounts = useAccounts();
  const id = tab.params?.id as number | undefined;
  const fromDraft = tab.params?.draft as Draft | undefined;
  const loaded = useQuery({ queryKey: ['entry', id], queryFn: () => api.get<Record<string, unknown>>(`/entries/${id}`), enabled: !!id, staleTime: 0 });
  const nextNumber = useQuery({ queryKey: ['entries', 'next-number'], queryFn: () => api.get<{ number: string }>('/entries/next-number'), enabled: !id });
  const [d, setD] = useState<Draft | null>(id ? null : (fromDraft ?? newDraft(session.workingDate, !!tab.params?.initial)));
  const [saving, setSaving] = useState(false);
  const pay = useEntryPayment();

  useEffect(() => {
    if (loaded.data && !d) setD(fromServer(loaded.data));
  }, [loaded.data, d]);

  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const setDirty = (dirty: boolean) => tab.dirty !== dirty && ws.update(tab.key, { dirty });
  const patch = (p: Partial<Draft>) => {
    setD((x) => (x ? { ...x, ...p } : x));
    setDirty(true);
  };

  if (!d || !lookups.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const totals = (lines: Line[]) => lines.reduce((acc, l) => acc.plus(parseAmount(l.amount) ?? 0), dec(0));
  const td = totals(d.debits);
  const tc = totals(d.credits);
  const diff = td.minus(tc);
  const docTypes = lookups.data.documentTypes.filter((t) => t.isVisible || t.id === d.documentTypeId);
  const readOnly = !!d.id && !can('UI_Edit_Accountings');

  const setLine = (side: 'debits' | 'credits', i: number, p: Partial<Line>) => {
    const lines = d[side].map((l, j) => (j === i ? recalc({ ...l, ...p }, p, byId.get((p.accountId ?? l.accountId) as number)) : l));
    patch({ [side]: lines } as Partial<Draft>);
  };
  const addLine = (side: 'debits' | 'credits') => patch({ [side]: [...d[side], emptyLine()] } as Partial<Draft>);
  const removeLine = (side: 'debits' | 'credits', i: number) => patch({ [side]: d[side].length > 1 ? d[side].filter((_, j) => j !== i) : [emptyLine()] } as Partial<Draft>);

  /** Изравняване: put the difference on the shorter side's last (or a new) line. */
  const balance = () => {
    if (diff.isZero()) return;
    const side = diff.gt(0) ? 'credits' : 'debits';
    const lines = [...d[side]];
    const idx = lines.findIndex((l) => !parseAmount(l.amount));
    const target = idx >= 0 ? idx : lines.length - 1;
    const cur = parseAmount(lines[target]!.amount) ?? dec(0);
    lines[target] = { ...lines[target]!, amount: toInput(cur.plus(diff.abs()).toFixed(2)) };
    patch({ [side]: lines } as Partial<Draft>);
  };

  const payload = () => ({
    number: d.number || null,
    accountingDate: d.accountingDate,
    documentDate: d.documentDate || null,
    documentTypeId: d.documentTypeId,
    documentNumber: d.documentNumber,
    companyId: d.companyId,
    term: d.term,
    reference: d.reference || null,
    optionalReference: d.optionalReference || null,
    paragraph: d.paragraph || null,
    transactionTypeId: d.transactionTypeId,
    viesId: d.viesId,
    viesMonth: d.viesMonth || null,
    dueDate: d.dueDate || null,
    isInitialBalance: d.isInitialBalance,
    source: d.source,
    debits: d.debits.filter((l) => l.accountId).map(lineToApi),
    credits: d.credits.filter((l) => l.accountId).map(lineToApi),
  });

  const save = async (andNew = false) => {
    if (saving) return;
    setSaving(true);
    try {
      if (!(await pay.beforeSave(payload()))) return;
      const r = d.id ? await api.put<{ id: number; number: string; warnings: { key: string; text: string; severity: 'warning' }[] }>(`/entries/${d.id}`, payload()) : await api.post<{ id: number; number: string; warnings: { key: string; text: string; severity: 'warning' }[] }>('/entries', payload());
      await invalidate('entries', 'reports', 'accounts', 'dictionary');
      await pay.afterSave(r.id, payload());
      if (r.warnings?.length) await dialogs.messages(`Контиране ${r.number} е записано с предупреждения`, r.warnings);
      setDirty(false);
      if (andNew) {
        setD(newDraft(d.accountingDate, d.isInitialBalance));
        ws.update(tab.key, { title: d.isInitialBalance ? 'Начални салда' : 'Контиране', params: {} });
        void nextNumber.refetch();
      } else {
        ws.close(tab.key);
      }
    } catch (e) {
      await dialogs.error(e, 'Операцията не може да бъде записана');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!d.id || !(await dialogs.confirm(`Желаете ли да изтриете контиране ${d.number}?`))) return;
    try {
      await api.del(`/entries/${d.id}`);
      await invalidate('entries', 'reports', 'accounts');
      setDirty(false);
      ws.close(tab.key);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const reversal = async () => {
    if (!d.id) return;
    try {
      const draft = await api.get<Record<string, unknown>>(`/entries/${d.id}/reversal`);
      ws.open('entry', { title: 'Сторно', params: { draft: fromServer(draft) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey && e.key === 's') || (e.shiftKey && e.key === 'F9')) {
      e.preventDefault();
      void save();
    } else if (e.ctrlKey && e.key === 'F9') {
      e.preventDefault();
      balance();
    } else if (e.altKey && e.key === 'F9') {
      e.preventDefault();
      void save(true);
    }
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <CommandBar
        right={
          <>
            {d.id && <Button icon={<Undo2 className="size-3.5" />} onClick={reversal} disabled={!can('UI_Operations_Accounting')}>Сторно</Button>}
            {d.id && <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove} disabled={!can('UI_Edit_Accountings_DeleteAccounting')}>Изтриване</Button>}
          </>
        }
      >
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={() => save()} disabled={saving || readOnly} title="Ctrl+S">
          Запис
        </Button>
        {!d.id && (
          <Button onClick={() => save(true)} disabled={saving} title="Alt+F9">
            Запис и ново
          </Button>
        )}
        <Button icon={<Scale className="size-3.5" />} onClick={balance} disabled={diff.isZero()} title="Ctrl+F9">
          Изравняване
        </Button>
        <Button icon={<X className="size-3.5" />} onClick={async () => (!tab.dirty || (await dialogs.confirm('Желаете ли изход без запис на данните?'))) && ws.close(tab.key)}>
          Отказ
        </Button>
        {d.isInitialBalance && <span className="ml-2 rounded-sm bg-amber-100 px-2 py-0.5 text-[12px] text-amber-900">Начално салдо</span>}
      </CommandBar>

      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
        <div className="grid grid-cols-12 gap-x-3 gap-y-2 rounded-sm border border-slate-300 bg-white p-3">
          <Field label="Номер" className="col-span-2">
            <TextInput value={d.id ? d.number : d.number || nextNumber.data?.number || ''} readOnly className="bg-slate-50 font-medium" />
          </Field>
          <Field label="Дата на контиране" className="col-span-2">
            <TextInput type="date" value={d.accountingDate} onChange={(e) => patch({ accountingDate: e.target.value, ...(d.documentDate === d.accountingDate ? { documentDate: e.target.value } : {}), viesMonth: e.target.value.slice(0, 8) + '01' })} />
          </Field>
          <Field label="Тип документ" className="col-span-3">
            <Select value={d.documentTypeId ?? ''} onChange={(e) => patch({ documentTypeId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>
              {docTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Документ №" className="col-span-2">
            <TextInput value={d.documentNumber} onChange={(e) => patch({ documentNumber: e.target.value })} />
          </Field>
          <Field label="Дата на документ" className="col-span-3">
            <TextInput type="date" value={d.documentDate} onChange={(e) => patch({ documentDate: e.target.value })} />
          </Field>

          <Field label="Партньор" className="col-span-5">
            <PartnerPicker value={d.companyId} valueName={d.companyName} onChange={(p) => patch({ companyId: p?.id ?? null, companyName: p?.name ?? null, ...(p?.dueDays && !d.dueDate ? { dueDate: addDays(d.documentDate || d.accountingDate, p.dueDays) } : {}) })} />
          </Field>
          <Field label="Основание" className="col-span-7">
            <DictionaryInput type="terms" value={d.term} onChange={(v) => patch({ term: v })} />
          </Field>
          <Field label="Забележка" className={session.settings.IsOptionalReferenceEnabled === 'True' ? 'col-span-4' : 'col-span-7'}>
            <DictionaryInput type="references" value={d.reference} onChange={(v) => patch({ reference: v })} />
          </Field>
          {session.settings.IsOptionalReferenceEnabled === 'True' && (
            <Field label="Втора забележка" className="col-span-3">
              <DictionaryInput type="references" value={d.optionalReference} onChange={(v) => patch({ optionalReference: v })} />
            </Field>
          )}
          <Field label="Тип на сделката" className="col-span-2">
            <Select value={d.transactionTypeId} onChange={(e) => patch({ transactionTypeId: Number(e.target.value) })}>
              {lookups.data.transactionTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Месец за експорт (ДДС)" className="col-span-2">
            <TextInput type="month" value={d.viesMonth.slice(0, 7)} onChange={(e) => patch({ viesMonth: e.target.value ? `${e.target.value}-01` : '' })} />
          </Field>
          <Field label="Падеж" className="col-span-1">
            <TextInput type="date" value={d.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} className="px-1" />
          </Field>
          <EntryPaymentPanel ctl={pay} payload={payload()} entryId={d.id} readOnly={readOnly} />
          {session.settings.IsParagraphEnabled === 'True' && (
            <Field label="Параграф" className="col-span-12">
              <DictionaryInput type="paragraphs" value={d.paragraph} onChange={(v) => patch({ paragraph: v })} />
            </Field>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          {(['debits', 'credits'] as const).map((side) => (
            <LinesGrid
              key={side}
              title={side === 'debits' ? 'Дебит' : 'Кредит'}
              lines={d[side]}
              byId={byId}
              headerCompanyId={d.companyId}
              vatTerms={lookups.data!.vatTerms}
              total={side === 'debits' ? td : tc}
              onChange={(i, p) => setLine(side, i, p)}
              onAdd={() => addLine(side)}
              onRemove={(i) => removeLine(side, i)}
            />
          ))}
        </div>
        <div className={cx('mt-2 flex justify-end gap-6 px-1 text-[13px]', diff.isZero() ? 'text-slate-600' : 'font-semibold text-red-700')}>
          <span>Общо дебит: {formatMoney(td)}</span>
          <span>Общо кредит: {formatMoney(tc)}</span>
          <span>Разлика: {formatMoney(diff)}</span>
        </div>
      </div>
    </div>
  );
}

function LinesGrid({ title, lines, byId, headerCompanyId, vatTerms, total, onChange, onAdd, onRemove }: {
  title: string; lines: Line[]; byId: Map<number, Account>; headerCompanyId: number | null; vatTerms: { id: number; description: string; vatValue: string }[];
  total: ReturnType<typeof dec>; onChange: (i: number, p: Partial<Line>) => void; onAdd: () => void; onRemove: (i: number) => void;
}) {
  const accs = lines.map((l) => (l.accountId ? byId.get(l.accountId) : undefined));
  const showCurrency = accs.some((a) => a?.isForeignCurrency);
  const showMaterial = accs.some((a) => a?.isMaterial);
  const showPartner = accs.some((a) => isCompanyCategory(a?.categoryId));
  return (
    <div className="flex flex-col rounded-sm border border-slate-300 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-2 py-1">
        <span className="font-semibold text-slate-700">{title}</span>
        <Button variant="ghost" className="h-6 px-2" icon={<Plus className="size-3.5" />} onClick={onAdd}>
          Ред
        </Button>
      </div>
      <table className="grid-table">
        <thead>
          <tr>
            <th className="w-[40%]">Сметка</th>
            <th className="w-28 text-right">Сума</th>
            {showPartner && <th>Партньор</th>}
            {showCurrency && <th className="w-24 text-right">Вал. сума</th>}
            {showCurrency && <th className="w-20 text-right">Курс</th>}
            {showMaterial && <th className="w-20 text-right">Кол.</th>}
            {showMaterial && <th className="w-20 text-right">Цена</th>}
            <th className="w-20">ДДС</th>
            <th className="w-7" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const a = accs[i];
            const amountBad = !!l.accountId && !parseAmount(l.amount);
            return (
              <tr key={i}>
                <td className="p-0.5">
                  <AccountPicker value={l.accountId} onChange={(acc) => onChange(i, { accountId: acc?.id ?? null })} />
                </td>
                <td className="p-0.5">
                  <TextInput className={cx('num', amountBad && 'border-amber-400')} value={l.amount} inputMode="decimal" onChange={(e) => onChange(i, { amount: e.target.value })} onBlur={() => l.amount && parseAmount(l.amount) && onChange(i, { amount: toInput(parseAmount(l.amount)!.toFixed(2)) })} />
                </td>
                {showPartner && (
                  <td className="p-0.5">
                    {isCompanyCategory(a?.categoryId) ? (
                      <PartnerPicker value={l.companyId ?? headerCompanyId} valueName={l.companyName} onChange={(p) => onChange(i, { companyId: p?.id ?? null, companyName: p?.name ?? null })} />
                    ) : null}
                  </td>
                )}
                {showCurrency && (
                  <td className="p-0.5">{a?.isForeignCurrency && <TextInput className="num" value={l.currencyAmount} inputMode="decimal" onChange={(e) => onChange(i, { currencyAmount: e.target.value })} />}</td>
                )}
                {showCurrency && (
                  <td className="p-0.5">{a?.isForeignCurrency && <TextInput className="num" value={l.exchangeRate} inputMode="decimal" onChange={(e) => onChange(i, { exchangeRate: e.target.value })} />}</td>
                )}
                {showMaterial && <td className="p-0.5">{a?.isMaterial && <TextInput className="num" value={l.quantity} inputMode="decimal" onChange={(e) => onChange(i, { quantity: e.target.value })} />}</td>}
                {showMaterial && <td className="p-0.5">{a?.isMaterial && <TextInput className="num" value={l.price} inputMode="decimal" onChange={(e) => onChange(i, { price: e.target.value })} />}</td>}
                <td className="p-0.5">
                  <Select value={l.vatTermId ?? ''} onChange={(e) => onChange(i, { vatTermId: e.target.value ? Number(e.target.value) : null })} className="px-1">
                    <option value="" />
                    {vatTerms.map((v) => (
                      <option key={v.id} value={v.id} title={v.description}>
                        {v.description}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="p-0.5 text-center">
                  <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => onRemove(i)} aria-label="Изтрий ред" tabIndex={-1}>
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Общо</td>
            <td className="num">{formatMoney(total)}</td>
            <td colSpan={8} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Row calculations (spec 02a 2): currency amount × rate, quantity × price. */
function recalc(l: Line, changed: Partial<Line>, acc: Account | undefined): Line {
  if (!acc) return l;
  if (acc.isForeignCurrency && ('currencyAmount' in changed || 'exchangeRate' in changed)) {
    const ca = parseAmount(l.currencyAmount);
    const r = parseAmount(l.exchangeRate);
    if (ca && r) return { ...l, amount: toInput(amountFromCurrency(ca, r).toFixed(2)) };
  }
  if (acc.isMaterial && ('quantity' in changed || 'price' in changed)) {
    const q = parseAmount(l.quantity);
    const p = parseAmount(l.price);
    if (q && p) return { ...l, amount: toInput(amountFromQuantity(q, p).toFixed(2)) };
  }
  return l;
}

function lineToApi(l: Line) {
  return {
    accountId: l.accountId!,
    amount: toApi(l.amount) ?? '0',
    companyId: l.companyId,
    description: l.description || null,
    vatTermId: l.vatTermId,
    currencyAmount: toApi(l.currencyAmount),
    exchangeRate: toApi(l.exchangeRate),
    quantity: toApi(l.quantity),
    price: toApi(l.price),
  };
}

function fromServer(e: Record<string, unknown>): Draft {
  const lines = (arr: unknown) =>
    ((arr as Record<string, string | number | null>[]) ?? []).map((l) => ({
      accountId: l.accountId as number,
      amount: toInput(l.amount as string),
      companyId: (l.companyId as number) ?? null,
      currencyAmount: toInput(l.currencyAmount as string),
      exchangeRate: toInput(l.exchangeRate as string),
      quantity: toInput(l.quantity as string),
      price: toInput(l.price as string),
      description: (l.description as string) ?? '',
      vatTermId: (l.vatTermId as number) ?? null,
    }));
  const s = (k: string) => ((e[k] as string | null) ?? '');
  return {
    id: e.id as number | undefined,
    number: s('number'),
    accountingDate: s('accountingDate'),
    documentDate: s('documentDate'),
    documentTypeId: (e.documentTypeId as number) ?? null,
    documentNumber: s('documentNumber'),
    companyId: (e.companyId as number) ?? null,
    term: s('term'),
    reference: s('reference'),
    optionalReference: s('optionalReference'),
    paragraph: s('paragraph'),
    transactionTypeId: (e.transactionTypeId as number) ?? 1,
    viesId: (e.viesId as number) ?? null,
    viesMonth: s('viesMonth'),
    dueDate: s('dueDate'),
    isInitialBalance: !!e.isInitialBalance,
    source: (e.source as string) ?? undefined,
    debits: lines(e.debits).length ? lines(e.debits) : [emptyLine()],
    credits: lines(e.credits).length ? lines(e.credits) : [emptyLine()],
  };
}

function addDays(date: string, days: number) {
  const dt = new Date(date + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
