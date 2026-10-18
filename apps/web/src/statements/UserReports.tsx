import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, FilePlus2, Filter, Pencil, Play, Plus, Save, Sigma, Trash2, Undo2 } from 'lucide-react';
import { formatMoney } from '@shmi/core';
import { api, qs } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Dialog, Empty, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell } from '../reports/common.tsx';
import { useSession } from '../session.tsx';

/* ---------------- types (API of /user-reports) ---------------- */

type Format = 1 | 2 | 3;
interface Condition {
  field: string;
  op: string;
  value: string;
}
interface FilterSpec {
  match: 'all' | 'any';
  conditions: Condition[];
}
interface ReportCell {
  key?: string;
  expression: string;
  isOnlyPositive?: boolean;
  isCurrencyAmount?: boolean;
  isQuantityAmount?: boolean;
  filter?: FilterSpec | null;
}
interface Line {
  number: number;
  name: string;
  cells: ReportCell[];
}
interface Report {
  id?: number;
  name: string;
  description: string;
  format: Format;
  columns: string[];
  lines: Line[];
}
interface ListItem {
  id: number;
  name: string;
  description: string | null;
  format: number | null;
}
interface RunResult {
  report: { id: number; name: string; description: string; format: Format };
  columns: string[];
  period: { start: string; end: string };
  lines: { number: number; name: string; values: string[]; quantity: boolean[] }[];
  issues: { message: string }[];
}
interface UserFormula {
  id: number;
  name: string;
  key: string;
  expression: string;
  isOnlyPositive: boolean;
}

const FORMATS: [Format, string][] = [[1, 'Една колона'], [2, 'Две колони'], [3, 'По месеци']];
const FIELDS: [string, string][] = [
  ['term', 'Основание'], ['reference', 'Забележка'], ['documentNumber', 'Номер на документ'], ['documentType', 'Вид документ'], ['partner', 'Партньор'],
  ['debitAccount', 'Сметка дебит'], ['creditAccount', 'Сметка кредит'], ['amount', 'Сума'], ['number', 'Номер на контиране'],
];
const OPS: [string, string][] = [
  ['equals', 'равно на'], ['contains', 'съдържа'], ['notContains', 'не съдържа'], ['startsWith', 'започва с'], ['greater', 'по-голямо от'], ['less', 'по-малко от'], ['isPartner', 'е партньор от базата'],
];
const columnCount = (f: Format) => (f === 2 ? 2 : 1);

type Mode = { kind: 'list' } | { kind: 'edit'; report: Report } | { kind: 'run'; id: number } | { kind: 'formulas' };

/** Мениджър на потребителските справки (spec 05 section 10). */
export function UserReports() {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  if (mode.kind === 'edit') return <ReportEditor initial={mode.report} onDone={() => setMode({ kind: 'list' })} />;
  if (mode.kind === 'run') return <ReportRun id={mode.id} onBack={() => setMode({ kind: 'list' })} />;
  if (mode.kind === 'formulas') return <UserFormulas onBack={() => setMode({ kind: 'list' })} />;
  return <ReportList onMode={setMode} />;
}

/* ---------------- list ---------------- */

function ReportList({ onMode }: { onMode: (m: Mode) => void }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const q = useQuery({ queryKey: ['userReports'], queryFn: () => api.get<ListItem[]>('/user-reports') });
  const [selected, setSelected] = useState<number | null>(null);
  const [choose, setChoose] = useState(false);
  const sel = q.data?.find((r) => r.id === selected) ?? null;

  const edit = async (id: number) => onMode({ kind: 'edit', report: await api.get<Report>(`/user-reports/${id}`) });
  const remove = async () => {
    if (!sel || !(await dialogs.confirm(`Изтриване на справка „${sel.name}“?`))) return;
    try {
      await api.del(`/user-reports/${sel.id}`);
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ['userReports'] });
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const copy = async () => {
    if (!sel) return;
    await api.post(`/user-reports/${sel.id}/copy`);
    await qc.invalidateQueries({ queryKey: ['userReports'] });
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Play className="size-3.5" />} disabled={!sel} onClick={() => sel && onMode({ kind: 'run', id: sel.id })}>
          Изпълни
        </Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!sel} onClick={() => sel && void edit(sel.id)}>
          Редакция
        </Button>
        <Button icon={<FilePlus2 className="size-3.5" />} onClick={() => setChoose(true)}>
          Нова справка
        </Button>
        <Button icon={<Copy className="size-3.5" />} disabled={!sel} onClick={() => void copy()}>
          Копиране
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!sel} onClick={() => void remove()}>
          Изтриване на справка
        </Button>
        <Button icon={<Sigma className="size-3.5" />} onClick={() => onMode({ kind: 'formulas' })}>
          Потребителски формули
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : !q.data?.length ? (
          <Empty>Няма потребителски справки. Натиснете „Нова справка“.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-80">Име</th>
                <th>Описание</th>
                <th className="w-32">Изглед</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id} aria-selected={r.id === selected} onClick={() => setSelected(r.id)} onDoubleClick={() => onMode({ kind: 'run', id: r.id })} className="cursor-default">
                  <td>{r.name}</td>
                  <td className="max-w-[40rem] truncate">{r.description}</td>
                  <td>{FORMATS.find(([f]) => f === r.format)?.[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {choose && (
        <Dialog title="Нова справка" onClose={() => setChoose(false)} width={420}>
          <div className="mb-3">Изберете изглед:</div>
          <div className="flex gap-2">
            {FORMATS.map(([f, label]) => (
              <Button key={f} onClick={() => { setChoose(false); onMode({ kind: 'edit', report: { name: '', description: '', format: f, columns: f === 2 ? ['Колона 1', 'Колона 2'] : ['Стойност'], lines: [] } }); }}>
                {label}
              </Button>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

/* ---------------- editor ---------------- */

function ReportEditor({ initial, onDone }: { initial: Report; onDone: () => void }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const [r, setR] = useState<Report>(initial);
  const [sel, setSel] = useState<number | null>(r.lines.length ? 0 : null);
  const [filterFor, setFilterFor] = useState<{ line: number; col: number } | null>(null);
  const count = columnCount(r.format);

  const setLine = (i: number, patch: Partial<Line>) => setR({ ...r, lines: r.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const setCell = (i: number, col: number, patch: Partial<ReportCell>) => setLine(i, { cells: r.lines[i]!.cells.map((c, k) => (k === col ? { ...c, ...patch } : c)) });
  const add = () => {
    const number = Math.max(0, ...r.lines.map((l) => l.number)) + 1;
    setR({ ...r, lines: [...r.lines, { number, name: `Ред ${number}`, cells: Array.from({ length: count }, () => ({ expression: '0' })) }] });
    setSel(r.lines.length);
  };
  const move = (d: -1 | 1) => {
    if (sel === null) return;
    const j = sel + d;
    if (j < 0 || j >= r.lines.length) return;
    const lines = [...r.lines];
    [lines[sel], lines[j]] = [lines[j]!, lines[sel]!];
    // Row order is the row number (UserReportRows.Number); keys stay with their line.
    setR({ ...r, lines: lines.map((l, i) => ({ ...l, number: i + 1, cells: l.cells.map((c, col) => ({ ...c, key: c.key || `${col === 0 ? 'u' : 'v'}${l.number}` })) })) });
    setSel(j);
  };
  const save = async () => {
    try {
      const body = { ...r, lines: r.lines.map((l) => ({ ...l, cells: l.cells.map((c) => ({ ...c, key: c.key || undefined })) })) };
      if (r.id) await api.put(`/user-reports/${r.id}`, body);
      else await api.post('/user-reports', body);
      await qc.invalidateQueries({ queryKey: ['userReports'] });
      onDone();
    } catch (e) {
      await dialogs.error(e, 'Справката не е записана');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={() => void save()}>
          Запис
        </Button>
        <Button icon={<Undo2 className="size-3.5" />} onClick={onDone}>
          Отказ
        </Button>
        <span className="mx-2 h-5 w-px bg-slate-300" />
        <Button icon={<Plus className="size-3.5" />} onClick={add}>
          Добавяне
        </Button>
        <Button icon={<Trash2 className="size-3.5" />} disabled={sel === null} onClick={() => { if (sel === null) return; setR({ ...r, lines: r.lines.filter((_, i) => i !== sel) }); setSel(null); }}>
          Изтриване
        </Button>
        <Button icon={<ArrowUp className="size-3.5" />} disabled={sel === null || sel === 0} onClick={() => move(-1)} aria-label="Нагоре" />
        <Button icon={<ArrowDown className="size-3.5" />} disabled={sel === null || sel === r.lines.length - 1} onClick={() => move(1)} aria-label="Надолу" />
      </CommandBar>
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <Field label="Име на справката">
          <TextInput value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} className="w-72" />
        </Field>
        <Field label="Описание на справката">
          <TextInput value={r.description} onChange={(e) => setR({ ...r, description: e.target.value })} className="w-96" />
        </Field>
        <Field label="Изглед">
          <TextInput value={FORMATS.find(([f]) => f === r.format)?.[1] ?? ''} disabled className="w-32" />
        </Field>
        {r.format !== 3 && Array.from({ length: count }, (_, i) => (
          <Field key={i} label={count === 2 ? `Име на колона ${i + 1}` : 'Име на колоната'}>
            <TextInput value={r.columns[i] ?? ''} onChange={(e) => { const columns = [...r.columns]; columns[i] = e.target.value; setR({ ...r, columns }); }} className="w-40" />
          </Field>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {r.lines.length === 0 ? (
          <Empty>Няма редове. Натиснете „Добавяне“.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-12">№</th>
                <th className="w-64">Име на реда</th>
                {Array.from({ length: count }, (_, i) => (
                  <th key={i}>{count === 2 ? `Формула (${r.columns[i] || `колона ${i + 1}`})` : 'Формула'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l, i) => (
                <tr key={i} aria-selected={sel === i} onClick={() => setSel(i)}>
                  <td className="text-slate-600">{l.number}</td>
                  <td className="p-0!">
                    <input aria-label={`Име на ред ${l.number}`} className="h-6 w-full bg-transparent px-2 outline-none focus:bg-white" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} />
                  </td>
                  {l.cells.map((c, col) => (
                    <td key={col} className="py-0.5!">
                      <div className="flex items-center gap-2">
                        <span className="w-8 text-[11px] text-slate-400" title="Ключ на реда">{c.key || (col === 0 ? 'u' : 'v') + l.number}</span>
                        <input aria-label={`Формула ред ${l.number}${count === 2 ? ` колона ${col + 1}` : ''}`} className="field-input h-6! flex-1 font-mono text-[12px]" spellCheck={false} value={c.expression} onChange={(e) => setCell(i, col, { expression: e.target.value })} />
                        <Checkbox label="Само положителна стойност" checked={Boolean(c.isOnlyPositive)} onChange={(v) => setCell(i, col, { isOnlyPositive: v })} />
                        <Checkbox label="Сума във валута" checked={Boolean(c.isCurrencyAmount)} onChange={(v) => setCell(i, col, { isCurrencyAmount: v, isQuantityAmount: v ? false : c.isQuantityAmount })} />
                        <Checkbox label="Количество" checked={Boolean(c.isQuantityAmount)} onChange={(v) => setCell(i, col, { isQuantityAmount: v, isCurrencyAmount: v ? false : c.isCurrencyAmount })} />
                        <Button className={cx('w-32 justify-center', Boolean(c.filter?.conditions.length) && 'border-brand-500! text-brand-700')} icon={<Filter className="size-3.5 shrink-0" />} onClick={() => setFilterFor({ line: i, col })}>
                          Филтър{c.filter?.conditions.length ? ` (${c.filter.conditions.length})` : ''}
                        </Button>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="border-t border-slate-300 bg-slate-50 px-3 py-1.5 text-[11.5px] text-slate-600">
        Формулите използват езика на отчетите: idb, icb, fdb, fcb, dt, ct, ac(дебит,кредит), клетки от отчетите (b50, r30), потребителски формули и ключовете на редовете (u1, v1); операции „+“, „-“, „[ ]“ (≥ 0), „{'{ }'}“ (≤ 0).
      </div>
      {filterFor && (
        <FilterDialog
          initial={r.lines[filterFor.line]!.cells[filterFor.col]!.filter ?? { match: 'all', conditions: [] }}
          onClose={() => setFilterFor(null)}
          onOk={(f) => { setCell(filterFor.line, filterFor.col, { filter: f.conditions.length ? f : null }); setFilterFor(null); }}
        />
      )}
    </div>
  );
}

function FilterDialog({ initial, onOk, onClose }: { initial: FilterSpec; onOk: (f: FilterSpec) => void; onClose: () => void }) {
  const [f, setF] = useState<FilterSpec>(initial);
  const setCond = (i: number, patch: Partial<Condition>) => setF({ ...f, conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <Dialog title="Условие за филтриране на контировките" onClose={onClose} width={720} footer={<><Button variant="primary" onClick={() => onOk(f)}>OK</Button><Button onClick={onClose}>Отказ</Button></>}>
      <div className="mb-2 flex items-center gap-2">
        <span>Контировките отговарят на</span>
        <Select value={f.match} onChange={(e) => setF({ ...f, match: e.target.value as 'all' | 'any' })} className="w-48">
          <option value="all">всички условия (И)</option>
          <option value="any">някое от условията (ИЛИ)</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        {f.conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} className="w-44" aria-label="Поле">
              {FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className="w-44" aria-label="Условие">
              {OPS.filter(([v]) => (c.field === 'amount' ? ['equals', 'greater', 'less'].includes(v) : c.field === 'partner' ? !['greater', 'less'].includes(v) : !['greater', 'less', 'isPartner'].includes(v))).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <TextInput value={c.value} disabled={c.op === 'isPartner'} onChange={(e) => setCond(i, { value: e.target.value })} className="flex-1" aria-label="Стойност" />
            <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })} aria-label="Изтриване на условие" />
          </div>
        ))}
        <div>
          <Button icon={<Plus className="size-3.5" />} onClick={() => setF({ ...f, conditions: [...f.conditions, { field: 'term', op: 'contains', value: '' }] })}>
            Добавяне на условие
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------------- execution ---------------- */

function ReportRun({ id, onBack }: { id: number; onBack: () => void }) {
  const period = useYearPeriod();
  const s = useSession();
  const meta = useQuery({ queryKey: ['userReport', id], queryFn: () => api.get<Report>(`/user-reports/${id}`) });
  const years = useQuery({ queryKey: ['years'], queryFn: () => api.get<{ id: number; year: number }[]>('/years') });
  const [f, setF] = useState({ ...period, year: s.year.year, createdBy: '' });
  const monthly = meta.data?.format === 3;
  const report = useReport(`userReport:${id}`, f, (x) => api.get<RunResult>(`/user-reports/${id}/run${qs(monthly ? { year: x.year } : { from: x.from, to: x.to })}`), (x) => (!monthly && x.from > x.to ? 'Началната дата е след крайната дата.' : null));
  const a = report.applied ?? f;
  const title = meta.data?.name ?? 'Потребителска справка';
  const subtitle = monthly ? `за ${a.year} г.` : periodText(a);
  const fmt = (v: string, quantity: boolean) => (Number(v) === 0 ? '' : formatMoney(v, quantity ? 3 : 2));

  const csv = (d: RunResult): Cell[][] => [['№', 'Ред', ...d.columns], ...d.lines.map((l) => [l.number, l.name, ...l.values.map((v) => amt(v))])];

  return (
    <ReportFrame<RunResult>
      title={title}
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.lines.length === 0}
      csvName={`${title}_${monthly ? a.year : `${a.from}_${a.to}`}`}
      csv={csv}
      actions={() => (
        <Button icon={<Undo2 className="size-3.5" />} onClick={onBack}>
          Назад
        </Button>
      )}
      filters={
        <>
          {monthly ? (
            <Field label="Счетоводна година">
              <Select value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })} className="w-32">
                {(years.data ?? []).map((y) => <option key={y.id} value={y.year}>{y.year}</option>)}
              </Select>
            </Field>
          ) : (
            <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          )}
          <Field label="Съставител">
            <TextInput value={f.createdBy} onChange={(e) => setF({ ...f, createdBy: e.target.value })} className="w-48" />
          </Field>
        </>
      }
    >
      {(d) => (
        <div className="p-0">
          {d.issues.length > 0 && <div className="border-b border-amber-300 bg-amber-50 px-3 py-1 text-[12px] text-amber-900">{d.issues.map((i) => i.message).join(' · ')}</div>}
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-12">№</th>
                <th>Ред</th>
                {d.columns.map((c) => <th key={c} className="w-32 text-right">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.number}>
                  <td className="text-slate-600">{l.number}</td>
                  <td>{l.name}</td>
                  {l.values.map((v, i) => <td key={i} className="num">{fmt(v, l.quantity[Math.min(i, l.quantity.length - 1)] ?? false)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {a.createdBy && <div className="px-3 py-2 text-[12px]">Съставител: {a.createdBy}</div>}
        </div>
      )}
    </ReportFrame>
  );
}

/* ---------------- saved user formulas ---------------- */

function UserFormulas({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const q = useQuery({ queryKey: ['userFormulas'], queryFn: () => api.get<UserFormula[]>('/user-formulas') });
  const [edit, setEdit] = useState<Partial<UserFormula> | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const sel = q.data?.find((x) => x.id === selected);
  const save = async () => {
    if (!edit) return;
    try {
      const body = { name: edit.name ?? '', key: edit.key ?? '', expression: edit.expression ?? '', isOnlyPositive: Boolean(edit.isOnlyPositive) };
      if (edit.id) await api.put(`/user-formulas/${edit.id}`, body);
      else await api.post('/user-formulas', body);
      await qc.invalidateQueries({ queryKey: ['userFormulas'] });
      setEdit(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const rows = (q.data ?? []).filter((x) => !search || `${x.name} ${x.key} ${x.expression}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button icon={<Undo2 className="size-3.5" />} onClick={onBack}>Назад</Button>
        <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ name: '', key: '', expression: '' })}>Добавяне</Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!sel} onClick={() => sel && setEdit(sel)}>Редакция</Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!sel} onClick={async () => { if (sel && (await dialogs.confirm(`Изтриване на формула „${sel.name}“?`))) { await api.del(`/user-formulas/${sel.id}`); await qc.invalidateQueries({ queryKey: ['userFormulas'] }); } }}>Изтриване</Button>
        <TextInput placeholder="Филтър по име или сметка" value={search} onChange={(e) => setSearch(e.target.value)} className="ml-2 w-64" />
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? <Empty>Няма потребителски формули.</Empty> : (
          <table className="grid-table">
            <thead><tr><th className="w-64">Име</th><th className="w-32">Ключ</th><th>Формула</th><th className="w-40">Само положителна</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id} aria-selected={x.id === selected} onClick={() => setSelected(x.id)} onDoubleClick={() => setEdit(x)}>
                  <td>{x.name}</td><td>{x.key}</td><td className="font-mono text-[12px]">{x.expression}</td><td>{x.isOnlyPositive ? 'Да' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <Dialog title={edit.id ? 'Редакция на формула' : 'Нова формула'} onClose={() => setEdit(null)} width={560} footer={<><Button variant="primary" onClick={() => void save()}>Запис</Button><Button onClick={() => setEdit(null)}>Отказ</Button></>}>
          <div className="flex flex-col gap-2">
            <Field label="Име"><TextInput value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Ключ" hint="Използва се в редовете на справките, например „cash“."><TextInput value={edit.key ?? ''} onChange={(e) => setEdit({ ...edit, key: e.target.value })} /></Field>
            <Field label="Формула"><TextInput className="font-mono" value={edit.expression ?? ''} onChange={(e) => setEdit({ ...edit, expression: e.target.value })} /></Field>
            <Checkbox label="Само положителна стойност" checked={Boolean(edit.isOnlyPositive)} onChange={(v) => setEdit({ ...edit, isOnlyPositive: v })} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
