import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eraser, Save, X } from 'lucide-react';
import { JOURNAL_EXTRA_MESSAGES as XM } from '@shmi/core';
import { api, qs } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { DictionaryInput } from '../../components/DictionaryInput.tsx';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Button, CommandBar, Empty, Field, Spinner, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useInvalidate, useSession } from '../../session.tsx';
import { useWorkspace, type ScreenProps } from '../../shell/workspace.tsx';
import { EntryFilterForm, emptyFilter, filterParams, type EntryFilterValues } from './EntryFilter.tsx';

interface Row { id: number; number: string; accounting_date: string; company: string | null; term: string | null; amount: string; debit_accounts: string | null; credit_accounts: string | null }

interface NewValues {
  newAccountingDate: string;
  newDocumentDate: string;
  newViesMonth: string;
  newCompanyId: number | null;
  newCompanyName: string | null;
  newTerm: string;
  newReference: string;
  newOptionalReference: string;
  fromDebitAccount: string;
  fromCreditAccount: string;
  newAccount: string;
}

const blank = (): NewValues => ({
  newAccountingDate: '', newDocumentDate: '', newViesMonth: '', newCompanyId: null, newCompanyName: null, newTerm: '', newReference: '', newOptionalReference: '',
  fromDebitAccount: '', fromCreditAccount: '', newAccount: '',
});

/** Редакция на контировки (Редакция > Администриране, spec 02a 6). */
export function MassEdit({ tab }: ScreenProps) {
  const s = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [filter, setFilter] = useState<EntryFilterValues>(emptyFilter(s.year.year));
  const [applied, setApplied] = useState<EntryFilterValues | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [v, setV] = useState<NewValues>(blank());
  const [saving, setSaving] = useState(false);
  const q = useQuery({
    queryKey: ['entries', 'mass-edit', applied],
    queryFn: () => api.get<{ rows: Row[] }>(`/journal/mass-edit/search${qs(filterParams(applied!))}`),
    enabled: !!applied,
    retry: false,
  });
  const rows = q.data?.rows ?? [];
  const set = (p: Partial<NewValues>) => setV({ ...v, ...p });

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ updated: number }>('/journal/mass-edit', {
        ids: checked,
        newAccountingDate: v.newAccountingDate || null,
        newDocumentDate: v.newDocumentDate || null,
        newViesMonth: v.newViesMonth ? `${v.newViesMonth}-01` : null,
        newCompanyId: v.newCompanyId,
        newTerm: v.newTerm || null,
        newReference: v.newReference || null,
        newOptionalReference: v.newOptionalReference || null,
        fromDebitAccount: v.fromDebitAccount || null,
        fromCreditAccount: v.fromCreditAccount || null,
        newAccount: v.newAccount || null,
      });
      await invalidate('entries', 'reports', 'accounts', 'dictionary');
      await dialogs.alert(`Редактирани контировки: ${r.updated}.`, XM.strEditAccountings);
      // 6.3: the grid, the filter and the new values are cleared, all rows unchecked.
      setChecked([]);
      setV(blank());
      setApplied(null);
      setFilter(emptyFilter(s.year.year));
      ws.update(tab.key, { dirty: false });
    } catch (e) {
      await dialogs.error(e, XM.strEditAccountings);
    } finally {
      setSaving(false);
    }
  };

  const txt = (k: keyof NewValues, label: string, cls = '') => (
    <Field label={label} className={cls}>
      <TextInput value={(v[k] as string) ?? ''} onChange={(e) => set({ [k]: e.target.value })} aria-label={label} />
    </Field>
  );

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={saving}>
          Запис
        </Button>
        <Button icon={<X className="size-3.5" />} onClick={() => ws.close(tab.key)}>
          Отказ
        </Button>
        <Button icon={<Eraser className="size-3.5" />} onClick={() => setV(blank())}>
          Изчисти данните
        </Button>
      </CommandBar>
      <EntryFilterForm key={JSON.stringify(filter)} value={filter} showKind={false} onApply={(f) => {
        setFilter(f);
        setApplied(f);
        setChecked([]);
      }} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px] gap-0">
        <div className="min-h-0 overflow-auto border-r border-slate-200">
          {!applied ? (
            <Empty>Задайте филтър и натиснете „Филтрирай“.</Empty>
          ) : q.isLoading ? (
            <Empty>
              <Spinner />
            </Empty>
          ) : q.error ? (
            <Empty>{(q.error as Error).message}</Empty>
          ) : !rows.length ? (
            <Empty>Няма контировки.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-7">
                    <input type="checkbox" aria-label="Избор на всички" className="size-3.5" checked={checked.length === rows.length} onChange={(e) => setChecked(e.target.checked ? rows.map((r) => r.id) : [])} />
                  </th>
                  <th>Номер</th>
                  <th>Дата</th>
                  <th>Партньор</th>
                  <th>Основание</th>
                  <th>Дебит</th>
                  <th>Кредит</th>
                  <th className="text-right">Сума</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} aria-selected={checked.includes(r.id)} onClick={() => setChecked((c) => (c.includes(r.id) ? c.filter((x) => x !== r.id) : [...c, r.id]))}>
                    <td>
                      <input type="checkbox" className="size-3.5" aria-label={`Избор ${r.number}`} checked={checked.includes(r.id)} readOnly />
                    </td>
                    <td className="font-medium">{r.number}</td>
                    <td>{bgDate(r.accounting_date)}</td>
                    <td className="max-w-48 truncate">{r.company}</td>
                    <td className="max-w-64 truncate">{r.term}</td>
                    <td>{r.debit_accounts}</td>
                    <td>{r.credit_accounts}</td>
                    <td className="num">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="min-h-0 overflow-auto bg-slate-50 p-3">
          <h3 className="mb-2 font-semibold text-slate-700">{XM.strHeaderEditAccountingData}</h3>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Нова дата на осчетоводяване">
              <TextInput type="date" value={v.newAccountingDate} onChange={(e) => set({ newAccountingDate: e.target.value })} aria-label="Нова дата на осчетоводяване" />
            </Field>
            <Field label="Нова дата на документ">
              <TextInput type="date" value={v.newDocumentDate} onChange={(e) => set({ newDocumentDate: e.target.value })} aria-label="Нова дата на документ" />
            </Field>
            <Field label="Нов месец за експорт">
              <TextInput type="month" value={v.newViesMonth} onChange={(e) => set({ newViesMonth: e.target.value })} aria-label="Нов месец за експорт" />
            </Field>
            <Field label="Нова фирма">
              <PartnerPicker value={v.newCompanyId} valueName={v.newCompanyName} onChange={(p) => set({ newCompanyId: p?.id ?? null, newCompanyName: p?.name ?? null })} />
            </Field>
            <Field label="Ново основание" className="col-span-2">
              <DictionaryInput type="terms" value={v.newTerm} onChange={(x) => set({ newTerm: x })} />
            </Field>
            <Field label="Нова забележка" className="col-span-2">
              <DictionaryInput type="references" value={v.newReference} onChange={(x) => set({ newReference: x })} />
            </Field>
            {s.settings.IsOptionalReferenceEnabled === 'True' && (
              <Field label="Нова втора забележка" className="col-span-2">
                <DictionaryInput type="references" value={v.newOptionalReference} onChange={(x) => set({ newOptionalReference: x })} />
              </Field>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 items-end gap-2 rounded-sm border border-slate-300 bg-white p-2">
            {txt('fromDebitAccount', 'Замени сметка дебит')}
            {txt('fromCreditAccount', 'кредит')}
            {txt('newAccount', 'със сметка')}
          </div>
          <p className="mt-2 text-[12px] text-slate-500">Номер, суми, тип и номер на документ и тип на сделката не се редактират.</p>
        </div>
      </div>
    </div>
  );
}
