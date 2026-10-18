import { useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { STOCK_MESSAGES, isProductCategory, isProductReleaseCategory } from '@shmi/core';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { AccountPicker } from '../../components/pickers.tsx';
import { Button, CommandBar, Empty, Field, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useSession } from '../../session.tsx';
import type { Account } from '../../types.ts';
import { EditPane, isDecimal, normDecimal } from '../admin/common.tsx';

interface ProductAccountRef { parentId: number | null; parentNumber: string | null; accountId: number; number: string; description: string; accountType: number }
export interface ProductView {
  id: number;
  name: string;
  code: string | null;
  measure: string;
  price: string;
  incrementAccounts: ProductAccountRef[];
  decrementAccounts: ProductAccountRef[];
}
interface Form { name: string; code: string; measure: string; price: string; increment: number[]; decrement: number[] }

const toForm = (p: ProductView): Form => ({
  name: p.name, code: p.code ?? '', measure: p.measure, price: String(Number(p.price)),
  increment: p.incrementAccounts.map((a) => a.parentId!).filter(Boolean),
  decrement: p.decrementAccounts.map((a) => a.parentId!).filter(Boolean),
});

/** Дефиниране на СМЗ (Операции > Стоково-материални запаси, spec 03a 4.3). */
export function Products() {
  const can = useCan();
  const s = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const editable = can('UI_Operations_Products_DefineProducts');
  const priceDigits = Number(s.settings.PriceFormat ?? 2);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<ProductView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const list = useQuery({ queryKey: ['products'], queryFn: () => api.get<ProductView[]>('/products'), placeholderData: keepPreviousData });
  const measures = useQuery({ queryKey: ['products', 'measures'], queryFn: () => api.get<string[]>('/products/measures') });
  const row = list.data?.find((r) => r.id === sel?.id) ?? sel;
  const needle = q.trim().toLowerCase();
  const rows = (list.data ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.code ?? '').toLowerCase().includes(needle));
  const busy = useRef(false);
  const set = (patch: Partial<Form>) => form && setForm({ ...form, ...patch });

  const save = async () => {
    if (!form || busy.current) return;
    if (form.price.trim() && !isDecimal(form.price)) {
      await dialogs.alert('Невалидна цена.');
      return;
    }
    busy.current = true;
    const body = {
      name: form.name.trim(), code: form.code.trim() || null, measure: form.measure.trim(), price: form.price.trim() ? normDecimal(form.price) : '0',
      incrementAccountIds: form.increment, decrementAccountIds: form.decrement,
    };
    try {
      const r = row ? await api.put<ProductView>(`/products/${row.id}`, body) : await api.post<ProductView>('/products', body);
      await invalidate('products', 'accounts');
      setSel(r);
      setForm(toForm(r));
    } catch (e) {
      await dialogs.error(e, 'Стоката не може да бъде записана');
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (!row || !(await dialogs.confirm(STOCK_MESSAGES.strDeleteProductWarning))) return;
    try {
      await api.del(`/products/${row.id}`);
      await invalidate('products', 'accounts');
      setSel(null);
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const fmtPrice = (v: string) => Number(v).toLocaleString('bg-BG', { minimumFractionDigits: priceDigits, maximumFractionDigits: priceDigits });
  const accountsText = (l: ProductAccountRef[]) => l.map((a) => a.number).join(', ');

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <CommandBar right={list.data ? <span className="text-[12px] text-slate-500">{rows.length} записа</span> : undefined}>
        <Button variant="primary" icon={<Plus className="size-3.5" />} disabled={!editable} onClick={() => (setSel(null), setForm({ name: '', code: '', measure: 'бр.', price: '0', increment: [], decrement: [] }))}>
          Нов материал
        </Button>
        <Button icon={<Save className="size-3.5" />} onClick={save} disabled={!editable || !form}>
          Запис
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove} disabled={!editable || !row}>
          Изтриване
        </Button>
        <TextInput className="ml-3 w-64" placeholder="Търсене по име или код" value={q} onChange={(e) => setQ(e.target.value)} />
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
          {list.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !rows.length ? (
            <Empty>Няма дефинирани стоково-материални запаси.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Наименование</th>
                  <th>Код</th>
                  <th className="w-20">Мярка</th>
                  <th className="w-32 text-right">Цена ({s.baseCurrency})</th>
                  <th>Сметки за доставка</th>
                  <th>Сметки за реализация</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} aria-selected={r.id === row?.id} onClick={() => (setSel(r), setForm(toForm(r)))} className="cursor-default">
                    <td>{r.name}</td>
                    <td>{r.code}</td>
                    <td>{r.measure}</td>
                    <td className="num">{fmtPrice(r.price)}</td>
                    <td className="text-slate-600">{accountsText(r.incrementAccounts)}</td>
                    <td className="text-slate-600">{accountsText(r.decrementAccounts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {form ? (
          <EditPane
            title={row ? 'Редакция' : 'Нов материал'}
            width={420}
            footer={
              <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={!editable}>
                Запис
              </Button>
            }
          >
            <fieldset disabled={!editable} className="flex flex-col gap-2">
              <Field label="Наименование">
                <TextInput value={form.name} maxLength={255} onChange={(e) => set({ name: e.target.value })} autoFocus={!row} />
              </Field>
              <Field label="Код">
                <TextInput value={form.code} maxLength={50} onChange={(e) => set({ code: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Мярка">
                  <TextInput value={form.measure} maxLength={50} list="stock-measures" onChange={(e) => set({ measure: e.target.value })} />
                </Field>
                <Field label={`Цена (${s.baseCurrency})`}>
                  <TextInput value={form.price} inputMode="decimal" className="text-right" onChange={(e) => set({ price: e.target.value })} />
                </Field>
              </div>
              <datalist id="stock-measures">
                {(measures.data ?? []).map((m) => <option key={m} value={m} />)}
              </datalist>
              <AccountList
                label="Сметки за доставка"
                hint="Сметки на запаси (категории материали, продукция, стоки)."
                value={form.increment}
                onChange={(increment) => set({ increment })}
                filter={(a) => isProductCategory(a.categoryId) && !a.isMaterial}
                disabled={!editable}
              />
              <AccountList
                label="Сметки за реализация"
                hint="Сметки за приходи от продажби."
                value={form.decrement}
                onChange={(decrement) => set({ decrement })}
                filter={(a) => isProductReleaseCategory(a.categoryId) && !a.isMaterial}
                disabled={!editable}
              />
              {row && <div className="text-[12px] text-slate-500">За всяка избрана сметка се създава подсметка с името на стоката.</div>}
            </fieldset>
          </EditPane>
        ) : (
          <aside className="w-[420px] shrink-0 bg-slate-50">
            <Empty>Изберете запис или „Нов материал“</Empty>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Increment / decrement account list of a product (parent accounts that get a product sub-account). */
function AccountList({ label, hint, value, onChange, filter, disabled }: { label: string; hint: string; value: number[]; onChange: (ids: number[]) => void; filter: (a: Account) => boolean; disabled?: boolean }) {
  const { data: accounts = [] } = useAccounts();
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const pickable = useMemo(() => (a: Account) => filter(a) && !value.includes(a.id), [filter, value]);
  const [key, setKey] = useState(0);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-slate-600">{label}</span>
      <div className="rounded-sm border border-slate-300 bg-white">
        {value.length === 0 && <div className="px-2 py-1 text-[12px] text-slate-400">Няма избрани сметки</div>}
        {value.map((id) => {
          const a = byId.get(id);
          return (
            <div key={id} className={cx('flex items-center gap-2 border-b border-slate-100 px-2 py-0.5 last:border-b-0')}>
              <span className="min-w-14 font-medium">{a?.number ?? `#${id}`}</span>
              <span className="flex-1 truncate">{a?.description}</span>
              <button type="button" className="text-slate-500 hover:text-red-600" aria-label={`Премахни ${a?.number ?? id}`} onClick={() => onChange(value.filter((x) => x !== id))} disabled={disabled}>
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <AccountPicker key={key} value={null} leafOnly={false} filter={pickable} onChange={(a) => a && (onChange([...value, a.id]), setKey(key + 1))} />
      <span className="text-[11px] text-slate-500">{hint}</span>
    </div>
  );
}
