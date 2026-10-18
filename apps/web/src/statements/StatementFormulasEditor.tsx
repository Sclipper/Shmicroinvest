import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save, Undo2 } from 'lucide-react';
import { STATEMENT_COLUMNS, validateFormula } from '@shmi/core';
import { api } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, CommandBar, Empty, ErrorText, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useWorkspace, type ScreenProps } from '../shell/workspace.tsx';
import { STATEMENT_OPTIONS, type StatementCode } from './FinancialStatements.tsx';

interface FormulaRow {
  id: number;
  key: string;
  statement: StatementCode;
  rowIdentifier: string;
  rowDescription: string;
  columnIdentifier: string;
  columnDescription: string;
  formula: string;
  defaultFormula: string;
  valueLastPeriod: string;
  position: number;
}

type Edit = { formula: string; valueLastPeriod: string };

/** Редакция на отчети и баланс (Ctrl+B, StatementFormulasEditorView, spec 05 9.9). */
export function StatementFormulasEditor({ tab }: ScreenProps) {
  const qc = useQueryClient();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const q = useQuery({ queryKey: ['statementFormulas'], queryFn: () => api.get<FormulaRow[]>('/statements/formulas') });
  const initial = (tab.params?.statement as StatementCode | undefined) ?? 'balance';
  const [statement, setStatement] = useState<StatementCode>(initial);
  const [column, setColumn] = useState('');
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Map<number, Edit>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const p = tab.params?.statement as StatementCode | undefined;
    if (p) {
      setStatement(p);
      setColumn('');
    }
  }, [tab.params?.statement]);

  const all = q.data ?? [];
  const keys = useMemo(() => new Set(all.map((f) => f.key.toLowerCase())), [all]);
  const columns = STATEMENT_COLUMNS.filter((c) => c.statement === statement);
  const value = (f: FormulaRow): Edit => edits.get(f.id) ?? { formula: f.formula, valueLastPeriod: f.valueLastPeriod };
  const changed = [...edits.entries()].filter(([id, e]) => {
    const f = all.find((x) => x.id === id);
    return f && (e.formula !== f.formula || Number(e.valueLastPeriod) !== Number(f.valueLastPeriod));
  });
  const dirty = changed.length > 0;
  useEffect(() => ws.update(tab.key, { dirty }), [dirty, tab.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = search.trim().toLowerCase();
  const rows = all.filter((f) => f.statement === statement && (!column || f.columnIdentifier === column)
    && (!needle || f.key.toLowerCase() === needle || f.rowDescription.toLowerCase().includes(needle) || value(f).formula.toLowerCase().includes(needle)));

  const set = (f: FormulaRow, patch: Partial<Edit>) => setEdits((m) => new Map(m).set(f.id, { ...value(f), ...patch }));
  const errors = new Map(rows.map((f) => [f.id, validateFormula(value(f).formula, (k) => keys.has(k))]));
  const invalid = [...edits.entries()].some(([id, e]) => validateFormula(e.formula, (k) => keys.has(k)) !== null && all.some((f) => f.id === id));

  const save = async () => {
    if (invalid) {
      await dialogs.alert('Има невалидни формули. Поправете ги преди запис.');
      return;
    }
    setSaving(true);
    try {
      await api.put('/statements/formulas', { edits: changed.map(([id, e]) => ({ id, formula: e.formula, valueLastPeriod: String(Number(e.valueLastPeriod.replace(',', '.')) || 0) })) });
      await qc.invalidateQueries({ queryKey: ['statementFormulas'] });
      await qc.invalidateQueries({ queryKey: ['reports', 'financialStatements'] });
      setEdits(new Map());
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setSaving(false);
    }
  };

  const restoreSelected = () => {
    const f = all.find((x) => x.id === selected);
    if (f) set(f, { formula: f.defaultFormula });
  };
  const restoreAll = async () => {
    if (!(await dialogs.confirm(`Възстановяване на формулите по подразбиране за „${STATEMENT_OPTIONS.find(([v]) => v === statement)?.[1]}“?`))) return;
    setEdits((m) => {
      const next = new Map(m);
      for (const f of all.filter((x) => x.statement === statement)) next.set(f.id, { ...value(f), formula: f.defaultFormula });
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{q.isFetching && <Spinner className="size-3.5" />}{dirty ? `Променени: ${changed.length}` : ''}</span>}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty || saving} onClick={() => void save()}>
          Запис
        </Button>
        <Button icon={<Undo2 className="size-3.5" />} disabled={!dirty} onClick={() => setEdits(new Map())}>
          Отказ
        </Button>
        <Button icon={<RotateCcw className="size-3.5" />} disabled={selected === null} onClick={restoreSelected}>
          Възстановяване
        </Button>
        <Button icon={<RotateCcw className="size-3.5" />} onClick={() => void restoreAll()}>
          Възстановяване на всички
        </Button>
      </CommandBar>
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <Field label="Избор на отчет/баланс">
          <Select value={statement} onChange={(e) => { setStatement(e.target.value as StatementCode); setColumn(''); setSelected(null); }} className="w-80">
            {STATEMENT_OPTIONS.filter(([v]) => v).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Група от формули">
          <Select value={column} onChange={(e) => setColumn(e.target.value)} className="w-72">
            <option value="">Всички</option>
            {columns.map((c) => (
              <option key={c.identifier} value={c.identifier}>
                {c.description}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Търсене (ключ, ред, формула)">
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
        </Field>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : q.error ? (
          <div className="p-3">
            <ErrorText error={q.error} />
          </div>
        ) : rows.length === 0 ? (
          <Empty>Няма формули.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-16">Ключ</th>
                <th>Ред от отчета</th>
                {!column && <th className="w-44">Група</th>}
                <th className="w-40 text-right">Предходна година в основна валута</th>
                <th className="w-[36rem]">Формула</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const v = value(f);
                const err = errors.get(f.id);
                const isDefault = v.formula === f.defaultFormula;
                return (
                  <tr key={f.id} aria-selected={selected === f.id} onClick={() => setSelected(f.id)} data-key={f.key}>
                    <td className="text-slate-600">{f.key}</td>
                    <td className="max-w-[32rem] truncate" title={f.rowDescription}>
                      {f.rowDescription}
                    </td>
                    {!column && <td className="max-w-44 truncate text-slate-600" title={f.columnDescription}>{f.columnDescription}</td>}
                    <td className="p-0!">
                      <input
                        aria-label={`Предходна година ${f.key}`}
                        className="num h-6 w-full bg-transparent px-2 outline-none focus:bg-white focus:ring-1 focus:ring-brand-300"
                        value={v.valueLastPeriod}
                        onFocus={() => setSelected(f.id)}
                        onChange={(e) => set(f, { valueLastPeriod: e.target.value })}
                      />
                    </td>
                    <td className="p-0!">
                      <input
                        aria-label={`Формула ${f.key}`}
                        title={err ?? (isDefault ? '' : `По подразбиране: ${f.defaultFormula}`)}
                        className={cx('h-6 w-full bg-transparent px-2 font-mono text-[12px] outline-none focus:bg-white focus:ring-1 focus:ring-brand-300', err && 'bg-red-50! text-red-700', !isDefault && !err && 'text-brand-700')}
                        value={v.formula}
                        spellCheck={false}
                        onFocus={() => setSelected(f.id)}
                        onChange={(e) => set(f, { formula: e.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {selected !== null && (() => {
        const f = all.find((x) => x.id === selected);
        if (!f) return null;
        const err = validateFormula(value(f).formula, (k) => keys.has(k));
        return (
          <div className="border-t border-slate-300 bg-slate-50 px-3 py-1.5 text-[12px]">
            <span className="font-semibold">{f.key}</span> — {f.rowDescription}
            <span className="ml-3 text-slate-500">По подразбиране: <code>{f.defaultFormula}</code></span>
            {err && <span className="ml-3 text-red-700">{err}</span>}
          </div>
        );
      })()}
    </div>
  );
}
