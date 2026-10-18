import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BookCheck, FilePlus2, Save, Trash2 } from 'lucide-react';
import { RESCHEDULE_MESSAGES, isCompanyCategory, parseAmount } from '@shmi/core';
import { api, qs } from '../../api.ts';
import { bgDate, money, monthLabel } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { AccountPicker, PartnerPicker } from '../../components/pickers.tsx';
import { Button, CommandBar, Empty, Field, Panel, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../../session.tsx';
import { useWorkspace, type ScreenProps } from '../../shell/workspace.tsx';

interface ListRow {
  id: number; number: string | null; name: string | null; amount: string; documentTypeId: number | null; documentName: string | null;
  documentNumber: string | null; documentDate: string | null; fromDate: string; toDate: string; debitAccount: string; creditAccount: string;
  companyName: string | null; term: string | null; reference: string | null; lastProcessedMonth: string | null; processedAmount: string; remainingAmount: string;
}

interface Detail { id: number; month: string; amount: string; isProcessed: boolean; accountingId: number | null; accountingNumber: number | null }

interface Card {
  id: number; number: string | null; name: string | null; amount: string; documentTypeId: number | null; documentNumber: string | null; documentDate: string | null;
  fromDate: string; toDate: string; isRescheduleByDays: boolean; debitAccountId: number; creditAccountId: number; companyId: number | null; companyName: string | null;
  term: string | null; reference: string | null; sourceAccountingId: number | null;
  lastProcessedMonth: string | null; processedAmount: string; remainingAmount: string; details: Detail[];
}

/** Prefill from the entry editor ("Разсрочване на приход/разход"). */
export interface RescheduleFromEntry {
  amount?: string; documentTypeId?: number | null; documentNumber?: string | null; documentDate?: string | null;
  debitAccountId?: number | null; creditAccountId?: number | null; companyId?: number | null; companyName?: string | null;
  term?: string | null; sourceAccountingId?: number | null;
}

interface Form {
  id?: number; number: string; name: string; amount: string; documentTypeId: number | null; documentNumber: string; documentDate: string;
  fromDate: string; toDate: string; isRescheduleByDays: boolean; debitAccountId: number | null; creditAccountId: number | null;
  companyId: number | null; companyName: string | null; term: string; reference: string; sourceAccountingId: number | null;
}

const toInput = (v: string | null | undefined) => (v ? String(Number(v)).replace('.', ',') : '');

function blank(year: number, p?: RescheduleFromEntry): Form {
  return {
    number: '', name: p?.term ?? '', amount: toInput(p?.amount), documentTypeId: p?.documentTypeId ?? null, documentNumber: p?.documentNumber ?? '', documentDate: p?.documentDate ?? '',
    fromDate: `${year}-01-01`, toDate: `${year}-12-31`, isRescheduleByDays: false, debitAccountId: p?.debitAccountId ?? null, creditAccountId: p?.creditAccountId ?? null,
    companyId: p?.companyId ?? null, companyName: p?.companyName ?? null, term: p?.term ?? '', reference: '', sourceAccountingId: p?.sourceAccountingId ?? null,
  };
}

const toForm = (c: Card): Form => ({
  id: c.id, number: c.number ?? '', name: c.name ?? '', amount: toInput(c.amount), documentTypeId: c.documentTypeId, documentNumber: c.documentNumber ?? '', documentDate: c.documentDate ?? '',
  fromDate: c.fromDate, toDate: c.toDate, isRescheduleByDays: c.isRescheduleByDays, debitAccountId: c.debitAccountId, creditAccountId: c.creditAccountId,
  companyId: c.companyId, companyName: c.companyName, term: c.term ?? '', reference: c.reference ?? '', sourceAccountingId: c.sourceAccountingId,
});

/** Разсрочване на приходи/разходи (Ctrl+R; spec 02a 9.3, 07 AccountingReschedulesListView). */
export function Reschedules({ tab }: ScreenProps) {
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const { data: accounts = [] } = useAccounts();
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const editable = can('UI_Operations_AccountingReschedules');
  const fromEntry = tab.params?.fromEntry as RescheduleFromEntry | undefined;

  const [f, setF] = useState({ number: '', name: '', documentNumber: '', debit: '', credit: '' });
  const list = useQuery({
    queryKey: ['reschedules', 'list', f],
    queryFn: () => api.get<ListRow[]>(`/reschedules${qs({ number: f.number.trim(), name: f.name.trim(), documentNumber: f.documentNumber.trim(), debit: f.debit.trim(), credit: f.credit.trim() })}`),
    placeholderData: keepPreviousData,
  });
  const [card, setCard] = useState<Card | null>(null);
  const [form, setForm] = useState<Form | null>(() => (fromEntry ? blank(s.year.year, fromEntry) : null));
  const [saved, setSaved] = useState<string>(() => (fromEntry ? '' : 'null'));
  const [busy, setBusy] = useState(false);
  const [toMonth, setToMonth] = useState(s.workingDate.slice(0, 7));

  const dirty = form !== null && JSON.stringify(form) !== saved;
  useEffect(() => {
    if (!!tab.dirty !== dirty) ws.update(tab.key, { dirty });
  }, [dirty, tab.dirty, tab.key, ws]);

  const show = (c: Card) => {
    const fm = toForm(c);
    setCard(c);
    setForm(fm);
    setSaved(JSON.stringify(fm));
  };

  const leave = async () => !dirty || dialogs.confirm('Има незаписани промени в картона. Желаете ли да продължите без запис?');

  const open = async (id: number) => {
    if (form?.id === id || !(await leave())) return;
    try {
      show(await api.get<Card>(`/reschedules/${id}`));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const create = async () => {
    if (!(await leave())) return;
    const fm = blank(s.year.year);
    setCard(null);
    setForm(fm);
    setSaved(JSON.stringify(fm));
  };

  const save = async () => {
    if (!form || busy) return;
    const amount = parseAmount(form.amount);
    const body = {
      ...(form.id && form.number.trim() === (card?.number ?? '') ? {} : { number: form.number.trim() || null }),
      name: form.name, amount: amount ? amount.toString() : '', documentTypeId: form.documentTypeId, documentNumber: form.documentNumber || null, documentDate: form.documentDate || null,
      fromDate: form.fromDate, toDate: form.toDate, isRescheduleByDays: form.isRescheduleByDays, debitAccountId: form.debitAccountId, creditAccountId: form.creditAccountId,
      companyId: form.companyId, term: form.term || null, reference: form.reference || null, sourceAccountingId: form.sourceAccountingId,
    };
    setBusy(true);
    try {
      const c = form.id ? await api.put<Card>(`/reschedules/${form.id}`, body) : await api.post<Card>('/reschedules', body);
      show(c);
      await invalidate('reschedules');
    } catch (e) {
      await dialogs.error(e, 'Картонът не може да бъде записан');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!form?.id || !(await dialogs.confirm(RESCHEDULE_MESSAGES.strConfirmVoidAccountingReschedule))) return;
    try {
      await api.del(`/reschedules/${form.id}`);
      setCard(null);
      setForm(null);
      setSaved('null');
      await invalidate('reschedules');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const process = async () => {
    const ids = form?.id ? [form.id] : (list.data ?? []).map((r) => r.id);
    if (!ids.length || busy) return;
    if (dirty) return dialogs.alert('Запишете промените в картона преди осчетоводяване.');
    const what = form?.id ? `картон ${card?.number ?? ''} „${card?.name ?? ''}“` : `всички показани картони (${ids.length})`;
    if (!(await dialogs.confirm(`Желаете ли да се осчетоводят неосчетоводените периоди до ${monthLabel(`${toMonth}-01`)} г. за ${what}?`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ created: { id: number; number: string }[] }>('/reschedules/process', { toMonth, ids });
      await invalidate('reschedules', 'entries', 'reports');
      if (form?.id) show(await api.get<Card>(`/reschedules/${form.id}`));
      await dialogs.alert(r.created.length ? `Създадени са ${r.created.length} мемориални ордера (№ ${r.created[0]!.number}${r.created.length > 1 ? ` – ${r.created[r.created.length - 1]!.number}` : ''}).` : 'Няма неосчетоводени периоди до избрания месец.');
    } catch (e) {
      await dialogs.error(e, 'Осчетоводяването не е извършено');
    } finally {
      setBusy(false);
    }
  };

  const set = (p: Partial<Form>) => setForm((x) => (x ? { ...x, ...p } : x));
  const partnerVisible = !!form && [form.debitAccountId, form.creditAccountId].some((id) => id && isCompanyCategory(byId.get(id)?.categoryId));

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={list.data ? <span className="text-[12px] text-slate-500">{list.data.length} картона</span> : undefined}>
        <Button variant="primary" icon={<FilePlus2 className="size-3.5" />} disabled={!editable} onClick={create}>
          Нов
        </Button>
        <Button icon={<Save className="size-3.5" />} disabled={!editable || !form || busy} onClick={save}>
          Запис
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!editable || !form?.id} onClick={remove}>
          Изтриване
        </Button>
        <span className="ml-3 text-[12px] text-slate-600">До месец</span>
        <TextInput type="month" aria-label="До месец" className="w-36" value={toMonth} onChange={(e) => setToMonth(e.target.value)} />
        <Button icon={<BookCheck className="size-3.5" />} disabled={!editable || busy || !toMonth || (!form?.id && !list.data?.length)} onClick={process} title={form?.id ? 'Осчетоводяване на избрания картон' : 'Осчетоводяване на всички показани картони'}>
          Осчетоводяване до месец
        </Button>
      </CommandBar>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-300 bg-slate-50 px-3 py-2">
        <Field label="Номер">
          <TextInput className="w-24" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
        </Field>
        <Field label="Наименование">
          <TextInput className="w-52" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Документ №">
          <TextInput className="w-28" value={f.documentNumber} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} />
        </Field>
        <Field label="Сметка Дебит">
          <TextInput className="w-24" value={f.debit} onChange={(e) => setF({ ...f, debit: e.target.value })} />
        </Field>
        <Field label="Сметка Кредит">
          <TextInput className="w-24" value={f.credit} onChange={(e) => setF({ ...f, credit: e.target.value })} />
        </Field>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
          {list.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !list.data?.length ? (
            <Empty>Няма картони за разсрочване.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-14">Номер</th>
                  <th>Наименование</th>
                  <th>Документ</th>
                  <th className="w-24">От дата</th>
                  <th className="w-24">До дата</th>
                  <th className="w-16">Дебит</th>
                  <th className="w-16">Кредит</th>
                  <th className="w-28 text-right">Ст-ст</th>
                  <th className="w-28 text-right">Начислени</th>
                  <th className="w-28 text-right">Остатък</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id} aria-selected={form?.id === r.id} onClick={() => open(r.id)} className="cursor-default">
                    <td>{r.number}</td>
                    <td className="max-w-56 truncate font-medium">{r.name}</td>
                    <td className="nowrap">{[r.documentName, r.documentNumber && `№ ${r.documentNumber}`, bgDate(r.documentDate)].filter(Boolean).join(' ')}</td>
                    <td className="nowrap">{bgDate(r.fromDate)}</td>
                    <td className="nowrap">{bgDate(r.toDate)}</td>
                    <td>{r.debitAccount}</td>
                    <td>{r.creditAccount}</td>
                    <td className="num">{money(r.amount)}</td>
                    <td className="num">{money(r.processedAmount)}</td>
                    <td className="num">{money(r.remainingAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <aside className="flex w-[520px] shrink-0 flex-col bg-slate-50">
          {!form ? (
            <Empty>Изберете картон или „Нов“</Empty>
          ) : (
            <>
              <div className="border-b border-slate-300 bg-slate-200 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-slate-600 uppercase">
                {form.id ? `Картон № ${card?.number ?? ''}` : 'Нов картон'}
                {dirty && <span className="ml-2 font-normal normal-case text-amber-700">(незаписан)</span>}
              </div>
              <fieldset disabled={!editable} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                <div className="grid grid-cols-[6rem_1fr_9rem] gap-2">
                  <Field label="Номер">
                    <TextInput value={form.number} maxLength={30} placeholder="авт." onChange={(e) => set({ number: e.target.value })} />
                  </Field>
                  <Field label="Наименование">
                    <TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!form.id} />
                  </Field>
                  <Field label="Стойност">
                    <TextInput className="num" inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
                  </Field>
                </div>
                <div className="grid grid-cols-[1fr_8rem_9rem] gap-2">
                  <Field label="Тип документ">
                    <Select value={form.documentTypeId ?? ''} onChange={(e) => set({ documentTypeId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">—</option>
                      {lookups.data?.documentTypes.filter((t) => t.isVisible || t.id === form.documentTypeId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Документ №">
                    <TextInput value={form.documentNumber} maxLength={30} onChange={(e) => set({ documentNumber: e.target.value })} />
                  </Field>
                  <Field label="Дата на документ">
                    <TextInput type="date" value={form.documentDate} onChange={(e) => set({ documentDate: e.target.value })} />
                  </Field>
                </div>
                <div className="grid grid-cols-[9rem_9rem_1fr] items-end gap-2">
                  <Field label="От дата">
                    <TextInput type="date" value={form.fromDate} onChange={(e) => set({ fromDate: e.target.value })} />
                  </Field>
                  <Field label="До дата">
                    <TextInput type="date" value={form.toDate} onChange={(e) => set({ toDate: e.target.value })} />
                  </Field>
                  <div className="flex gap-3 pb-1" role="radiogroup" aria-label="Разпределение">
                    {([[false, 'По месеци'], [true, 'По дни']] as const).map(([v, label]) => (
                      <label key={label} className="inline-flex items-center gap-1.5">
                        <input type="radio" name={`resched-${form.id ?? 'new'}`} checked={form.isRescheduleByDays === v} onChange={() => set({ isRescheduleByDays: v })} className="accent-brand-500" />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Сметка Дебит">
                    <AccountPicker value={form.debitAccountId} onChange={(a) => set({ debitAccountId: a?.id ?? null })} />
                  </Field>
                  <Field label="Сметка Кредит">
                    <AccountPicker value={form.creditAccountId} onChange={(a) => set({ creditAccountId: a?.id ?? null })} />
                  </Field>
                </div>
                {partnerVisible && (
                  <Field label="Партньор">
                    <PartnerPicker value={form.companyId} valueName={form.companyName} onChange={(p) => set({ companyId: p?.id ?? null, companyName: p?.name ?? null })} />
                  </Field>
                )}
                <Field label="Основание">
                  <TextInput value={form.term} onChange={(e) => set({ term: e.target.value })} />
                </Field>
                <Field label="Забележка">
                  <TextInput value={form.reference} onChange={(e) => set({ reference: e.target.value })} />
                </Field>
                {card && (
                  <div className="grid grid-cols-3 gap-2 rounded border border-slate-300 bg-white px-2 py-1.5 text-[12px]">
                    <div>
                      <div className="text-slate-500">Последен осчетоводен месец</div>
                      <div className="font-medium">{card.lastProcessedMonth ? monthLabel(card.lastProcessedMonth) : '—'}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Начислени</div>
                      <div className="num font-medium">{money(card.processedAmount)}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Остатъчна стойност</div>
                      <div className="num font-medium">{money(card.remainingAmount)}</div>
                    </div>
                  </div>
                )}
                {card && (
                  <Panel title="Периоди">
                    <table className="grid-table">
                      <thead>
                        <tr>
                          <th>Месец</th>
                          <th className="text-right">Сума</th>
                          <th>Статус</th>
                        </tr>
                      </thead>
                      <tbody>
                        {card.details.map((d) => (
                          <tr key={d.id}>
                            <td>{monthLabel(d.month)}</td>
                            <td className="num">{money(d.amount)}</td>
                            <td>
                              {d.isProcessed && d.accountingId ? (
                                <button type="button" className="text-brand-700 hover:underline" onClick={() => ws.open('entry', { key: `entry:${d.accountingId}`, title: `Контиране ${d.accountingNumber ?? ''}`, params: { id: d.accountingId } })}>
                                  МО № {d.accountingNumber}
                                </button>
                              ) : d.isProcessed ? 'Осчетоводен' : <span className="text-slate-500">Неосчетоводен</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Panel>
                )}
              </fieldset>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
