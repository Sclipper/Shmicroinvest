import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, Save } from 'lucide-react';
import { api, qs } from '../../api.ts';
import { money } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, CommandBar, Empty, ErrorText, Field, Spinner, TextInput } from '../../components/ui.tsx';
import { useCan, useInvalidate, useSession } from '../../session.tsx';
import { AccountNumberPicker, PeriodFields, sum, useYearPeriod } from '../../reports/common.tsx';

interface WriteOffRow {
  productId: number;
  productName: string;
  measure: string;
  decrementAccountId: number;
  decrementAccount: string;
  stockAccountId: number | null;
  stockAccount: string | null;
  quantity: string;
  averagePrice: string;
  deliveryAmount: string;
  saleAmount: string;
}

/**
 * Изписване на СМЗ (Ctrl+I, spec 03a 4.5): sold quantities of the period are
 * written off at weighted average cost, Dt sales account / Ct stock account.
 */
export function WriteOffs() {
  const s = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const period = useYearPeriod();
  const [f, setF] = useState({ ...period, account: '', date: s.workingDate.slice(0, 10) });
  const [applied, setApplied] = useState<typeof f | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const list = useQuery({
    queryKey: ['writeOffs', applied],
    queryFn: () => api.get<WriteOffRow[]>(`/stock/write-offs${qs({ from: applied!.from, to: applied!.to, account: applied!.account, date: applied!.date })}`),
    enabled: !!applied,
    retry: false,
  });
  const rows = list.data ?? [];
  const chosen = rows.filter((r) => !excluded.has(r.productId));

  const run = () => {
    setExcluded(new Set());
    setApplied({ ...f });
    if (applied && JSON.stringify(applied) === JSON.stringify(f)) void list.refetch();
  };

  const save = async () => {
    if (!applied || !chosen.length) return;
    setSaving(true);
    try {
      const r = await api.post<{ created: { id: number; number: string }[] }>('/stock/write-offs', { ...applied, date: f.date, account: applied.account || undefined, productIds: chosen.map((x) => x.productId) });
      await invalidate('journal', 'entries', 'reports');
      await dialogs.alert(`Създадени контировки: ${r.created.length}${r.created.length ? ` (№ ${r.created.map((c) => c.number).join(', ')})` : ''}.`);
      await list.refetch();
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{list.isFetching && <Spinner className="size-3.5" />}{applied && !list.isFetching ? `${rows.length} стоки` : ''}</span>}>
        <Button type="submit" form="write-offs-form" variant="primary" icon={<Play className="size-3.5" />}>
          Покажи
        </Button>
        <Button icon={<Save className="size-3.5" />} onClick={save} disabled={!can('UI_Operations_Products_WriteOffs') || saving || !chosen.length || list.isFetching}>
          Запис
        </Button>
      </CommandBar>
      <form
        id="write-offs-form"
        className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
        <Field label="Сметка">
          <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} />
        </Field>
        <Field label="Дата на изписване">
          <TextInput type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="w-36" required />
        </Field>
      </form>
      <div className="min-h-0 flex-1 overflow-auto">
        {!applied ? (
          <Empty>Задайте период и натиснете „Покажи“.</Empty>
        ) : list.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : list.error ? (
          <div className="p-3"><ErrorText error={list.error} /></div>
        ) : !rows.length ? (
          <Empty>Няма продадени количества за изписване.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Продукт</th>
                <th className="w-16">Мярка</th>
                <th className="w-28">Сметка</th>
                <th className="w-28">Сметка на стоката</th>
                <th className="w-28 text-right">Количество</th>
                <th className="w-28 text-right">Средна цена</th>
                <th className="w-32 text-right">Сума на доставка</th>
                <th className="w-32 text-right">Сума на продажба</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.productId} className={excluded.has(r.productId) ? 'text-slate-400' : undefined}>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`Изписване ${r.productName}`}
                      className="size-3.5 accent-brand-500"
                      checked={!excluded.has(r.productId)}
                      onChange={(e) => setExcluded((x) => {
                        const n = new Set(x);
                        if (e.target.checked) n.delete(r.productId);
                        else n.add(r.productId);
                        return n;
                      })}
                    />
                  </td>
                  <td>{r.productName}</td>
                  <td>{r.measure}</td>
                  <td>{r.decrementAccount}</td>
                  <td>{r.stockAccount ?? <span className="text-red-600">няма</span>}</td>
                  <td className="num">{Number(r.quantity).toLocaleString('bg-BG', { maximumFractionDigits: 6 })}</td>
                  <td className="num">{Number(r.averagePrice).toLocaleString('bg-BG', { maximumFractionDigits: 6 })}</td>
                  <td className="num">{money(r.deliveryAmount)}</td>
                  <td className="num">{money(r.saleAmount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={7} className="text-right">Общо:</td>
                <td className="num">{money(sum(chosen, (r) => r.deliveryAmount))}</td>
                <td className="num">{money(sum(chosen, (r) => r.saleAmount))}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      {applied && rows.length > 0 && (
        <div className="flex justify-end gap-6 border-t border-slate-300 bg-slate-50 px-3 py-1.5 text-[13px]">
          <span>Доставка общо: <b>{money(sum(chosen, (r) => r.deliveryAmount))}</b></span>
          <span>Продажба общо: <b>{money(sum(chosen, (r) => r.saleAmount))}</b></span>
        </div>
      )}
    </div>
  );
}
