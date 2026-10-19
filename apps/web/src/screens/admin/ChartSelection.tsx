import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ListPlus } from 'lucide-react';
import { CHART_TEMPLATE_LABELS, CHART_TEMPLATE_TYPES, SHELL_MESSAGES, chartTemplateAccounts, type ChartTemplateType, type TemplateAccount } from '@shmi/core';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, CommandBar, Empty, Panel, Spinner, cx } from '../../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useSession } from '../../session.tsx';
import { useWorkspace, type ScreenProps } from '../../shell/workspace.tsx';


/** Избор на сметкоплан (Alt+K): add accounts from a chart template to the individual chart. */
export function ChartSelection({ tab }: ScreenProps) {
  const s = useSession();
  const ws = useWorkspace();
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const editable = can('UI_Operations_ChartOfAccounts_ChartOfAccountsSelection');
  const { data: accounts, isLoading } = useAccounts();
  // The chosen chart type (03a 1.3) is preselected; commercial when none is chosen yet.
  const [type, setType] = useState<ChartTemplateType>(() =>
    (CHART_TEMPLATE_TYPES as readonly string[]).includes(s.chartOfAccountsType ?? '') ? (s.chartOfAccountsType as ChartTemplateType) : 'commercial');
  const template = useMemo(() => chartTemplateAccounts(type), [type]);
  const existing = useMemo(() => new Set((accounts ?? []).map((a) => a.number)), [accounts]);
  const kids = useMemo(() => {
    const m = new Map<string, TemplateAccount[]>();
    for (const a of template) m.set(a.parentNumber, [...(m.get(a.parentNumber) ?? []), a]);
    return m;
  }, [template]);
  const missing = template.filter((a) => !existing.has(a.number));
  // Selection of not-yet-present accounts; all of them by default.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selected = missing.filter((a) => !unchecked.has(a.number));
  /**
   * The user worked with the selection (or came here because no chart type is
   * chosen): leaving with selected, not transferred accounts asks
   * strSelectedAccountsExistWarning (03a 1.4).
   */
  const [touched, setTouched] = useState(!!tab.params?.notDefined);
  const pending = touched && editable && selected.length > 0;
  useEffect(() => {
    ws.update(tab.key, { dirty: pending, dirtyMessage: SHELL_MESSAGES.strSelectedAccountsExistWarning });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, tab.key]);

  const descendants = (n: string): string[] => (kids.get(n) ?? []).flatMap((k) => [k.number, ...descendants(k.number)]);
  const toggle = (a: TemplateAccount, on: boolean) => {
    setTouched(true);
    const all = [a.number, ...descendants(a.number)].filter((n) => !existing.has(n));
    setUnchecked((u) => {
      const n = new Set(u);
      for (const x of all) if (on) n.delete(x);
      else n.add(x);
      return n;
    });
  };

  const rows: { a: TemplateAccount; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const a of kids.get(parent) ?? []) {
      rows.push({ a, depth });
      if (expanded.has(a.number)) walk(a.number, depth + 1);
    }
  };
  walk('0', 0);

  const apply = async () => {
    if (!selected.length) return;
    if (!(await dialogs.confirm(`Ще бъдат добавени ${selected.length} сметки от сметкоплан „${CHART_TEMPLATE_LABELS[type]}“ в сметкоплана за ${s.year.year} г. Съществуващите сметки не се променят. Желаете ли да продължите?`))) return;
    try {
      const all = selected.length === missing.length;
      const r = await api.post<{ added: number }>('/accounts/template', { type, ...(all ? {} : { numbers: selected.map((a) => a.number) }) });
      await invalidate('accounts', 'session');
      setUnchecked(new Set());
      setTouched(false);
      await dialogs.alert(r.added === 1 ? "Добавена е 1 сметка." : `Добавени са ${r.added} сметки.`, "Избор на сметкоплан");
    } catch (e) {
      await dialogs.error(e);
    }
  };

  if (isLoading) return <Empty><Spinner /></Empty>;

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">Шаблон: {template.length} сметки · налични: {template.length - missing.length} · избрани за добавяне: {selected.length}</span>}>
        <Button variant="primary" icon={<ListPlus className="size-3.5" />} disabled={!editable || !selected.length} onClick={apply}>
          Добавяне на избраните
        </Button>
        <Button variant="ghost" onClick={() => { setTouched(true); setUnchecked(new Set()); }}>Маркирай всички</Button>
        <Button variant="ghost" onClick={() => { setTouched(true); setUnchecked(new Set(missing.map((a) => a.number))); }}>Размаркирай всички</Button>
        <span className="mx-1 h-5 w-px bg-slate-300" />
        <Button variant="ghost" onClick={() => setExpanded(new Set(template.filter((a) => kids.has(a.number)).map((a) => a.number)))}>Разгъни всички</Button>
        <Button variant="ghost" onClick={() => setExpanded(new Set())}>Свий всички</Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 border-r border-slate-300 bg-slate-50 p-3">
          <Panel title="Вид сметкоплан">
            <div className="flex flex-col gap-1.5 p-3">
              {CHART_TEMPLATE_TYPES.map((id) => (
                <label key={id} className="flex items-center gap-2 whitespace-nowrap">
                  <input
                    type="radio"
                    name="chart-template"
                    className="accent-brand-500"
                    checked={type === id}
                    onChange={() => { setType(id); setUnchecked(new Set()); setExpanded(new Set()); }}
                  />
                  <span>{CHART_TEMPLATE_LABELS[id]}</span>
                </label>
              ))}
            </div>
          </Panel>
          <div className="mt-3 text-[12px] leading-relaxed text-slate-600">
            {s.chartIsEmpty ? (
              <span className="text-amber-700">Сметкопланът за {s.year.year} г. е празен. Изберете шаблон и добавете сметките.</span>
            ) : (
              <>Сметките от шаблона, които липсват в индивидуалния сметкоплан, могат да бъдат добавени. Наличните сметки (сиви) не се променят.</>
            )}
            <div className="mt-2">Сметкоплан {s.year.year >= 2026 ? 'в евро (от 2026 г.)' : 'в лева (до 2025 г.)'}.</div>
            {type === 'budget' && <div className="mt-2">Бюджетният сметкоплан включва и полето „Параграф“ в прозорец Контиране.</div>}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Наименование</th>
                <th>Характер</th>
                <th>Състояние</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ a, depth }) => {
                const has = existing.has(a.number);
                const subtree = [a.number, ...descendants(a.number)].filter((n) => !existing.has(n));
                const on = subtree.filter((n) => !unchecked.has(n)).length;
                const hasKids = kids.has(a.number);
                return (
                  <tr key={a.number} className={cx(has && 'text-slate-400')}>
                    <td style={{ paddingLeft: 8 + depth * 16 }} className={cx(depth <= 1 && 'font-semibold')}>
                      {hasKids ? (
                        <button className="mr-1 inline-flex align-middle text-slate-500" onClick={() => setExpanded((x) => { const n = new Set(x); if (n.has(a.number)) n.delete(a.number); else n.add(a.number); return n; })}>
                          {expanded.has(a.number) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        </button>
                      ) : (
                        <span className="mr-1 inline-block w-3.5" />
                      )}
                      <input
                        type="checkbox"
                        className="mr-1.5 size-3.5 align-middle accent-brand-500"
                        checked={has || (subtree.length > 0 && on === subtree.length)}
                        ref={(el) => {
                          if (el) el.indeterminate = !has && on > 0 && on < subtree.length;
                        }}
                        disabled={!editable || subtree.length === 0}
                        onChange={(e) => toggle(a, e.target.checked)}
                      />
                      {a.number}
                    </td>
                    <td className={cx(depth <= 1 && 'font-semibold')}>{a.description}</td>
                    <td>{a.isActive === true ? 'А' : a.isActive === false ? 'П' : 'АП'}</td>
                    <td className="text-[12px]">
                      {has ? 'налична' : <span className="text-emerald-700">нова</span>}
                      {hasKids && subtree.length > (has ? 0 : 1) && <span className="text-emerald-700"> · за добавяне {on}/{subtree.length}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
