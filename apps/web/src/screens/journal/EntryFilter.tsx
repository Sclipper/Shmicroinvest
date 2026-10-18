import { useState } from 'react';
import { Eraser, Search } from 'lucide-react';
import { Button, Field, Select, TextInput } from '../../components/ui.tsx';
import { PartnerPicker } from '../../components/pickers.tsx';
import { useLookups } from '../../session.tsx';

/** AccountingFilter (02a 7 / 6.1): the fields of the journal list and the mass-edit screen. */
export interface EntryFilterValues {
  numberFrom: string;
  numberTo: string;
  from: string;
  to: string;
  companyId: string;
  companyName?: string;
  debit: string;
  credit: string;
  account: string;
  amount: string;
  amountFrom: string;
  amountTo: string;
  term: string;
  reference: string;
  documentTypeId: string;
  documentNumber: string;
  transactionTypeId: string;
  vatTermId: string;
  viesMonth: string;
  icaType: string;
  initial: string;
  text: string;
}

export const emptyFilter = (year: number, initial = ''): EntryFilterValues => ({
  numberFrom: '', numberTo: '', from: `${year}-01-01`, to: `${year}-12-31`, companyId: '', companyName: '', debit: '', credit: '', account: '',
  amount: '', amountFrom: '', amountTo: '', term: '', reference: '', documentTypeId: '', documentNumber: '', transactionTypeId: '', vatTermId: '',
  viesMonth: '', icaType: '', initial, text: '',
});

/** Query parameters of a filter (empty values dropped; amounts with '.' decimals). */
export function filterParams(f: EntryFilterValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (k === 'companyName' || v === '' || v === undefined) continue;
    out[k] = k.startsWith('amount') ? String(v).replace(',', '.') : String(v);
  }
  return out;
}

export function EntryFilterForm({ value, onApply, onClear, compact, showKind = true }: { value: EntryFilterValues; onApply: (f: EntryFilterValues) => void; onClear?: () => void; compact?: boolean; showKind?: boolean }) {
  const lookups = useLookups();
  const [f, setF] = useState(value);
  const [more, setMore] = useState(!compact);
  const set = (p: Partial<EntryFilterValues>) => setF({ ...f, ...p });
  const txt = (k: keyof EntryFilterValues, label: string, cls = 'w-24') => (
    <Field label={label}>
      <TextInput value={(f[k] as string) ?? ''} onChange={(e) => set({ [k]: e.target.value })} className={cls} aria-label={label} />
    </Field>
  );
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(f);
      }}
    >
      {txt('numberFrom', 'От номер')}
      {txt('numberTo', 'До номер')}
      <Field label="От дата">
        <TextInput type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} className="w-36" aria-label="От дата" />
      </Field>
      <Field label="До дата">
        <TextInput type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} className="w-36" aria-label="До дата" />
      </Field>
      {txt('debit', 'Дебит сметка')}
      {txt('credit', 'Кредит сметка')}
      <Field label="Тип документ">
        <Select value={f.documentTypeId} onChange={(e) => set({ documentTypeId: e.target.value })} className="w-44" aria-label="Тип документ">
          <option value="">Всички</option>
          {lookups.data?.documentTypes.filter((t) => t.isVisible).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      {txt('documentNumber', '№ документ')}
      {showKind && (
        <Field label="Вид">
          <Select value={f.initial} onChange={(e) => set({ initial: e.target.value })} className="w-36" aria-label="Вид">
            <option value="">Операции</option>
            <option value="1">Начални салда</option>
            <option value="all">Всички</option>
          </Select>
        </Field>
      )}
      <Field label="Търсене" className="min-w-40 flex-1">
        <TextInput value={f.text} onChange={(e) => set({ text: e.target.value })} placeholder="номер, основание, документ, партньор" aria-label="Търсене" />
      </Field>
      {more && (
        <div className="flex w-full flex-wrap items-end gap-2">
          <Field label="Фирма" className="w-56">
            <PartnerPicker value={f.companyId ? Number(f.companyId) : null} valueName={f.companyName} onChange={(p) => set({ companyId: p ? String(p.id) : '', companyName: p?.name ?? '' })} />
          </Field>
          {txt('amount', 'Сума (точна)')}
          {txt('amountFrom', 'Сума от')}
          {txt('amountTo', 'Сума до')}
          {txt('term', 'Основание', 'w-40')}
          {txt('reference', 'Забележка', 'w-40')}
          <Field label="Тип на сделката">
            <Select value={f.transactionTypeId} onChange={(e) => set({ transactionTypeId: e.target.value })} className="w-32" aria-label="Тип на сделката">
              <option value="">Всички</option>
              {lookups.data?.transactionTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Операция по ДДС">
            <Select value={f.vatTermId} onChange={(e) => set({ vatTermId: e.target.value })} className="w-52" aria-label="Операция по ДДС">
              <option value="">Всички</option>
              {lookups.data?.vatTerms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Месец за експорт">
            <TextInput type="month" value={f.viesMonth} onChange={(e) => set({ viesMonth: e.target.value })} className="w-36" aria-label="Месец за експорт" />
          </Field>
          <Field label="Протокол (ICA)">
            <Select value={f.icaType} onChange={(e) => set({ icaType: e.target.value })} className="w-36" aria-label="Протокол (ICA)">
              <option value="">Всички</option>
              {lookups.data?.icaTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" icon={<Search className="size-3.5" />}>
          Филтрирай
        </Button>
        <Button
          icon={<Eraser className="size-3.5" />}
          onClick={() => {
            const cleared = { ...emptyFilter(Number(f.from.slice(0, 4)) || new Date().getFullYear(), showKind ? f.initial : '') };
            setF(cleared);
            onClear?.();
            onApply(cleared);
          }}
        >
          Изчисти
        </Button>
        {compact && (
          <Button variant="ghost" onClick={() => setMore(!more)}>
            {more ? 'По-малко' : 'Още филтри'}
          </Button>
        )}
      </div>
    </form>
  );
}
