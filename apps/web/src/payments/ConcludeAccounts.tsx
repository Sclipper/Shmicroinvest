import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Percent, Plus, Save, Trash2 } from 'lucide-react';
import { CONCLUDE_MODES, distributePercents, isCompanyCategory, isPercentDistributionAvailable, type ConcludeMode } from '@shmi/core';
import { api, qs, type Message } from '../api.ts';
import { money } from '../format.ts';
import { AccountPicker } from '../components/pickers.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate } from '../session.tsx';
import { PeriodFields, useYearPeriod, type Period } from '../reports/common.tsx';
import { normDecimal } from '../screens/admin/common.tsx';
import type { Account } from '../types.ts';

interface SourceRow {
  accountId: number;
  number: string;
  description: string;
  debitTurnover: string;
  creditTurnover: string;
  turnover: string;
  hasInitialBalance: boolean;
}
interface Turnover { accountId: number; debitTurnover: string; creditTurnover: string }
interface Planned { debits: { accountId: number; amount: string }[]; credits: { accountId: number; amount: string }[] }
interface Target { accountId: number | null; percent: string }

const targetFilter = (a: Account) => !isCompanyCategory(a.categoryId);
const isNum = (s: string) => /^\d+(\.\d+)?$/.test(normDecimal(s));

/** Приключване на разходни и приходни сметки (spec 02c 3.2). */
export function ConcludeAccounts() {
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const accounts = useAccounts().data ?? [];
  const numberOf = (id: number) => accounts.find((a) => a.id === id)?.number ?? `#${id}`;
  const [period, setPeriod] = useState<Period>(useYearPeriod());
  const [mode, setMode] = useState<ConcludeMode>('economic');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [targets, setTargets] = useState<Target[]>([{ accountId: null, percent: '100' }]);
  const [percentChosen, setPercentChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const def = CONCLUDE_MODES.find((m) => m.id === mode)!;

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(period.from) && /^\d{4}-\d{2}-\d{2}$/.test(period.to);
  const sources = useQuery({
    queryKey: ['closings', 'turnovers', mode, period.from, period.to, filter],
    queryFn: () => api.get<SourceRow[]>(`/closings/turnovers${qs({ mode, from: period.from, to: period.to, filter })}`),
    enabled: valid,
  });
  const list = sources.data ?? [];
  useEffect(() => {
    setSelected({});
    setAmounts({});
  }, [mode, period.from, period.to]);

  const chosen = list.filter((r) => selected[r.accountId]);
  const body = {
    mode, from: period.from, to: period.to,
    sources: chosen.map((r) => ({ accountId: r.accountId, amount: isNum(amounts[r.accountId] ?? r.turnover) ? normDecimal(amounts[r.accountId] ?? r.turnover) : '-1' })),
    targets: targets.map((t) => ({ accountId: t.accountId, percent: isNum(t.percent) ? normDecimal(t.percent) : '0' })),
  };
  const percentAvailable = isPercentDistributionAvailable(mode, chosen.length, body.targets);
  const percentDistribution = percentAvailable && percentChosen;
  const preview = useQuery({
    queryKey: ['closings', 'preview', JSON.stringify(body), percentDistribution],
    queryFn: () => api.post<{ messages: Message[]; entries: Planned[] }>('/closings/preview', { ...body, percentDistribution }),
    enabled: valid && chosen.length > 0,
  });

  const allSelected = list.length > 0 && list.every((r) => selected[r.accountId]);
  const setTarget = (i: number, t: Partial<Target>) => setTargets(targets.map((x, j) => (j === i ? { ...x, ...t } : x)));

  const distribute = async () => {
    const ids = targets.filter((t) => t.accountId).map((t) => t.accountId!);
    if (!ids.length) return;
    try {
      const rows = await api.get<Turnover[]>(`/closings/account-turnovers${qs({ from: period.from, to: period.to, ids: ids.join(',') })}`);
      const basis = targets.map((t) => {
        const r = rows.find((x) => x.accountId === t.accountId);
        return r ? (def.creditDistribution ? r.creditTurnover : r.debitTurnover) : '0';
      });
      const p = distributePercents(basis);
      setTargets(targets.map((t, i) => ({ ...t, percent: p[i]!.toDecimalPlaces(4).toString() })));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const post = async (confirm: boolean): Promise<void> => {
    const res = await api.post<{ posted: boolean; warnings: Message[]; entries: { id: number }[] }>('/closings', { ...body, percentDistribution, confirm });
    if (!res.posted) {
      if (await dialogs.messages('Приключване на сметки', res.warnings, true)) return post(true);
      return;
    }
    await invalidate('closings', 'journal', 'entries', 'reports');
    setSelected({});
    await dialogs.alert(`Създадени са ${res.entries.length} мемориални ордера.`, 'Приключване на сметки');
  };
  const save = async () => {
    setBusy(true);
    try {
      await post(false);
    } catch (e) {
      await dialogs.error(e, 'Приключване на сметки');
    } finally {
      setBusy(false);
    }
  };

  const messages = preview.data?.messages ?? [];
  const totalPercent = useMemo(() => targets.reduce((a, t) => a + (isNum(t.percent) ? Number(normDecimal(t.percent)) : 0), 0), [targets]);

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={busy && <Spinner />}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={busy || !chosen.length || !can('UI_Operations_AutoOperations_ConcludeAccounts')} onClick={save}>
          Запис
        </Button>
      </CommandBar>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-3 py-2">
        <PeriodFields value={period} onChange={setPeriod} />
        <Field label="Вид приключване">
          <Select value={mode} onChange={(e) => setMode(e.target.value as ConcludeMode)} className="w-64" aria-label="Вид приключване">
            {CONCLUDE_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.text}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Сметка">
          <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} className="w-28" placeholder="напр. 60" aria-label="Филтър по сметка" />
        </Field>
      </div>
      <div className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-auto p-3">
        <Panel title="Сметки за приключване" className="min-w-[520px] flex-1 self-start">
          {sources.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !list.length ? (
            <Empty>Няма сметки с обороти за периода.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-8">
                    <input type="checkbox" aria-label="Избор на всички" className="size-3.5 accent-brand-500" checked={allSelected} onChange={(e) => setSelected(Object.fromEntries(list.map((r) => [r.accountId, e.target.checked])))} />
                  </th>
                  <th>Сметка</th>
                  <th>Наименование</th>
                  <th className="text-right">Дебитен оборот</th>
                  <th className="text-right">Кредитен оборот</th>
                  <th className="text-right">Оборот</th>
                  <th className="text-right">Сума за приключване</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.accountId} aria-selected={!!selected[r.accountId]}>
                    <td>
                      <input type="checkbox" aria-label={`Избор ${r.number}`} className="size-3.5 accent-brand-500" checked={!!selected[r.accountId]} onChange={(e) => setSelected({ ...selected, [r.accountId]: e.target.checked })} />
                    </td>
                    <td>
                      {r.number}
                      {r.hasInitialBalance && <span className="ml-1 text-[11px] text-amber-700" title="Сметката има начално салдо">НС</span>}
                    </td>
                    <td>{r.description}</td>
                    <td className="num">{money(r.debitTurnover)}</td>
                    <td className="num">{money(r.creditTurnover)}</td>
                    <td className="num">{money(r.turnover)}</td>
                    <td className="p-0!">
                      <input
                        aria-label={`Сума ${r.number}`}
                        className="num h-6 w-full bg-transparent px-2 outline-none focus:bg-white focus:ring-1 focus:ring-brand-300 disabled:text-slate-400"
                        disabled={!selected[r.accountId]}
                        value={amounts[r.accountId] ?? r.turnover}
                        onChange={(e) => setAmounts({ ...amounts, [r.accountId]: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div className="flex w-[440px] flex-col gap-3">
          <Panel
            title={def.isDebitType ? 'Приключване към сметки' : 'Приключване към сметки (кредит)'}
            actions={
              <div className="flex gap-1">
                {percentDistribution && (
                  <Button variant="ghost" icon={<Percent className="size-3.5" />} onClick={distribute}>
                    Автоматично разпределение
                  </Button>
                )}
                <Button variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setTargets([...targets, { accountId: null, percent: '0' }])}>
                  Ред
                </Button>
              </div>
            }
          >
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Сметка</th>
                  <th className="w-24 text-right">Процент</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {targets.map((t, i) => (
                  <tr key={i}>
                    <td className="p-0.5!">
                      <AccountPicker value={t.accountId} onChange={(a) => setTarget(i, { accountId: a?.id ?? null })} filter={targetFilter} />
                    </td>
                    <td className="p-0!">
                      <input aria-label={`Процент ${i + 1}`} className="num h-7 w-full bg-transparent px-2 outline-none focus:bg-white focus:ring-1 focus:ring-brand-300" value={t.percent} onChange={(e) => setTarget(i, { percent: e.target.value })} />
                    </td>
                    <td>
                      {targets.length > 1 && (
                        <button aria-label="Премахни" className="text-slate-500 hover:text-red-600" onClick={() => setTargets(targets.filter((_, j) => j !== i))}>
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Общо</td>
                  <td className="num">{totalPercent.toFixed(2)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            {percentAvailable && (
              <div className="border-t border-slate-200 px-3 py-1.5">
                <Checkbox label="Разпределение по проценти" checked={percentChosen} onChange={setPercentChosen} />
              </div>
            )}
          </Panel>
          <Panel title="Мемориални ордери">
            <div className="flex flex-col gap-1 p-2 text-[12.5px]">
              {!chosen.length ? (
                <span className="text-slate-500">Изберете сметки за приключване.</span>
              ) : preview.isLoading ? (
                <Spinner />
              ) : (
                <>
                  {messages.map((m, i) => (
                    <div key={i} className={cx(m.severity === 'critical' ? 'text-red-700' : 'text-amber-700')}>
                      {m.severity === 'critical' ? '⛔' : '⚠'} {m.text}
                    </div>
                  ))}
                  {(preview.data?.entries ?? []).map((e, i) => (
                    <div key={i} className="rounded-sm border border-slate-200 px-2 py-1">
                      <div className="font-semibold text-slate-600">МО {i + 1} · {def.term}</div>
                      {e.debits.map((l, j) => (
                        <div key={`d${j}`} className="flex justify-between"><span>Дт {numberOf(l.accountId)}</span><span className="num">{money(l.amount)}</span></div>
                      ))}
                      {e.credits.map((l, j) => (
                        <div key={`c${j}`} className="flex justify-between"><span>Кт {numberOf(l.accountId)}</span><span className="num">{money(l.amount)}</span></div>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
