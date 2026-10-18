import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api, qs } from '../api.ts';
import { money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, CommandBar, Empty, Field, Panel, Spinner, TextInput } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate } from '../session.tsx';
import { PeriodFields, useYearPeriod, type Period } from '../reports/common.tsx';

interface Row {
  accountId: number;
  number: string;
  description: string;
  isActive: boolean;
  concludeNumber: string;
  concludeDescription: string;
  debitTurnover: string;
  creditTurnover: string;
  amount: string;
  debitAccountId: number;
  creditAccountId: number;
}

/** Автоматично приключване на сметки (spec 02c 3.3): accounts with a "Приключва се към" account. */
export function AutoConclude() {
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const accounts = useAccounts().data ?? [];
  const numberOf = (id: number) => accounts.find((a) => a.id === id)?.number ?? '';
  const [period, setPeriod] = useState<Period>(useYearPeriod());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(period.from) && /^\d{4}-\d{2}-\d{2}$/.test(period.to);
  const rows = useQuery({
    queryKey: ['closings', 'auto', period.from, period.to, filter],
    queryFn: () => api.get<Row[]>(`/closings/auto${qs({ from: period.from, to: period.to, filter })}`),
    enabled: valid,
  });
  const list = rows.data ?? [];

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/closings/auto', { from: period.from, to: period.to, filter });
      await invalidate('closings', 'journal', 'entries', 'reports');
      await dialogs.alert(r.message, 'Автоматично приключване на сметки');
    } catch (e) {
      await dialogs.error(e, 'Автоматично приключване на сметки');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={busy && <Spinner />}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={busy || !list.length || !can('UI_Operations_AutoOperations_ConcludeChartOfAccounts')} onClick={save}>
          Приключване
        </Button>
      </CommandBar>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-3 py-2">
        <PeriodFields value={period} onChange={setPeriod} />
        <Field label="Сметка">
          <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} className="w-28" aria-label="Филтър по сметка" />
        </Field>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <Panel title="Сметки за приключване">
          {rows.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !list.length ? (
            <Empty>Няма сметки за приключване. Задайте „Приключва се към“ в индивидуалния сметкоплан.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Сметка</th>
                  <th>Наименование</th>
                  <th>Вид</th>
                  <th>Приключва се към</th>
                  <th className="text-right">Дебитен оборот</th>
                  <th className="text-right">Кредитен оборот</th>
                  <th>Дебит</th>
                  <th>Кредит</th>
                  <th className="text-right">Сума</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.accountId}>
                    <td>{r.number}</td>
                    <td>{r.description}</td>
                    <td>{r.isActive ? 'Активна' : 'Пасивна'}</td>
                    <td title={r.concludeDescription}>{r.concludeNumber}</td>
                    <td className="num">{money(r.debitTurnover)}</td>
                    <td className="num">{money(r.creditTurnover)}</td>
                    <td>{numberOf(r.debitAccountId)}</td>
                    <td>{numberOf(r.creditAccountId)}</td>
                    <td className="num">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
