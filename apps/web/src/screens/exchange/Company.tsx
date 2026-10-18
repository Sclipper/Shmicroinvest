import { useEffect, useMemo, useState } from 'react';
import { compareAccountNumbers } from '../../format.ts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, FileDown, Play, Trash2, Upload } from 'lucide-react';
import { api, type Message } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Dialog, Empty, Field, Panel, Select, TextInput } from '../../components/ui.tsx';
import { useSession } from '../../session.tsx';
import { FileInput, MessageList, download, errorMessages, upload } from './common.tsx';

interface BackupRow { id: number; fileName: string; companyName: string; database: string; version: string; kind: string; size: number; createdAt: string }
interface CompanyItem { name: string; companyName: string; version: string }

const when = (iso: string) => new Date(iso).toLocaleString('bg-BG');
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Архивиране на фирма (01b 2). */
export function BackupScreen() {
  const s = useSession();
  const dialogs = useDialogs();
  const list = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupRow[]>('/backups'), refetchOnMount: 'always' });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: number; fileName: string; message: string }>('/backups');
      await list.refetch();
      await download(`/backups/${r.id}/download`);
      await dialogs.alert(`${r.message}\n${r.fileName}`);
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setBusy(false);
    }
  };
  const mine = list.data?.filter((b) => b.database === s.company.db) ?? [];
  return (
    <div className="h-full overflow-auto p-3" data-testid="backup-screen">
      <div className="flex max-w-[1100px] flex-col gap-3">
        <Panel title="Архивиране на фирма">
          <div className="flex items-center justify-between gap-3 p-3">
            <div className="text-[13px]">Архив на <span className="font-semibold">{s.company.name}</span>. Файлът се съхранява на сървъра и се изтегля.</div>
            <Button variant="primary" icon={<Archive className="size-3.5" />} disabled={busy} onClick={run}>Архивиране</Button>
          </div>
        </Panel>
        <Panel title="Архиви на фирмата">
          {mine.length ? <BackupTable rows={mine} /> : <Empty>Няма архиви.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function BackupTable({ rows, onRestore, onDelete }: { rows: BackupRow[]; onRestore?: (b: BackupRow) => void; onDelete?: (b: BackupRow) => void }) {
  return (
    <div className="overflow-x-auto">
    <table className="grid-table">
      <thead><tr><th>Файл</th><th>Фирма</th><th>Дата</th><th>Версия</th><th className="text-right">Размер</th><th /></tr></thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id}>
            <td>{b.fileName}</td><td>{b.companyName}</td><td>{when(b.createdAt)}</td><td>{b.version}</td><td className="text-right">{size(b.size)}</td>
            <td><div className="flex gap-1">
              <Button variant="ghost" className="h-6" icon={<Download className="size-3.5" />} onClick={() => download(`/backups/${b.id}/download`)}>Изтегляне</Button>
              {onRestore && <Button variant="ghost" className="h-6" icon={<Upload className="size-3.5" />} onClick={() => onRestore(b)}>Възстановяване</Button>}
              {onDelete && <Button variant="ghost" className="h-6 text-red-700" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(b)} aria-label="Изтриване" />}
            </div></td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** Възстановяване на фирма (01b 2): from the server store or an uploaded file; into the current company or as a new one. */
export function RestoreScreen() {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupRow[]>('/backups'), refetchOnMount: 'always' });
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'new' | 'current'>('new');
  const [busy, setBusy] = useState(false);
  const restore = async (src: { id: number } | { file: File }) => {
    if (mode === 'current' && !(await dialogs.confirm('Данните на текущата фирма ще бъдат заменени с данните от архива. Продължаване?'))) return;
    setBusy(true);
    try {
      const r = 'id' in src ? await api.post<{ message: string }>('/backups/restore', { id: src.id, mode }) : await upload<{ message: string }>('/backups/restore', src.file, { mode });
      await dialogs.alert(r.message);
      await qc.invalidateQueries();
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-auto p-3" data-testid="restore-screen">
      <div className="flex max-w-[1100px] flex-col gap-3">
        <Panel title="Възстановяване на фирма">
          <div className="flex flex-col gap-3 p-3">
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Като нова фирма</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'current'} onChange={() => setMode('current')} /> В текущата фирма (данните се заменят)</label>
            </div>
            <div className="flex items-center gap-3">
              <FileInput file={file} onChange={setFile} accept=".shbak" label="Архивен файл..." />
              <Button variant="primary" disabled={!file || busy} onClick={() => file && restore({ file })}>Възстановяване от файл</Button>
            </div>
          </div>
        </Panel>
        <Panel title="Архиви на сървъра">
          {list.data?.length ? (
            <BackupTable
              rows={list.data}
              onRestore={(b) => void restore({ id: b.id })}
              onDelete={async (b) => {
                if (!(await dialogs.confirm(`Изтриване на архива ${b.fileName}?`))) return;
                await api.del(`/backups/${b.id}`);
                await list.refetch();
              }}
            />
          ) : <Empty>Няма архиви.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

/** Избор на фирма (Ctrl+O): switch company inside the app; delete another company. */
export function ChooseCompany() {
  const s = useSession();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<CompanyItem[]>('/companies'), refetchOnMount: 'always' });
  const [db, setDb] = useState('');
  const users = useQuery({ queryKey: ['companyUsers', db], queryFn: () => api.get<{ id: number; name: string }[]>(`/companies/${db}/users`), enabled: !!db });
  const [userId, setUserId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Message[]>([]);
  const [del, setDel] = useState(false);
  useEffect(() => {
    if (companies.data?.length && !db) setDb(companies.data.find((c) => c.name !== s.company.db)?.name ?? companies.data[0]!.name);
  }, [companies.data, db, s.company.db]);
  useEffect(() => {
    if (users.data?.length) setUserId(users.data[0]!.id);
  }, [users.data]);
  const open = async () => {
    if (!userId) return;
    setError([]);
    try {
      await api.post('/login', { companyDb: db, userId, password });
      localStorage.setItem('shmi.lastCompany', db);
      await qc.invalidateQueries();
    } catch (e) {
      setError(errorMessages(e));
      setPassword('');
    }
  };
  const remove = async () => {
    if (!userId) return;
    setError([]);
    try {
      const r = await api.post<{ message: string }>(`/companies/${db}/delete`, { userId, password });
      setDel(false);
      setPassword('');
      setDb('');
      await companies.refetch();
      await dialogs.alert(r.message);
    } catch (e) {
      setError(errorMessages(e));
    }
  };
  const target = companies.data?.find((c) => c.name === db);
  return (
    <div className="h-full overflow-auto p-3" data-testid="choose-company">
      <Panel title="Избор на фирма" className="max-w-[560px]">
        <form className="flex flex-col gap-3 p-3" onSubmit={(e) => { e.preventDefault(); void open(); }}>
          <Field label="Фирма">
            <Select value={db} onChange={(e) => setDb(e.target.value)}>
              {companies.data?.map((c) => <option key={c.name} value={c.name}>{c.companyName}{c.name === s.company.db ? ' (активна)' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Потребител">
            <Select value={userId ?? ''} onChange={(e) => setUserId(Number(e.target.value))}>
              {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="Парола"><TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          <MessageList messages={error} />
          <div className="flex justify-between">
            <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!db || db === s.company.db || !s.user.isAdmin} onClick={() => setDel(true)}>Изтриване на фирмата</Button>
            <Button variant="primary" type="submit" disabled={!userId}>Отваряне</Button>
          </div>
        </form>
      </Panel>
      {del && target && (
        <Dialog title="Изтриване на фирма" onClose={() => setDel(false)} footer={<><Button onClick={() => setDel(false)}>Отказ</Button><Button variant="danger" onClick={remove}>Изтриване</Button></>}>
          <p className="text-[13px]">Фирма „{target.companyName}“ ще бъде изтрита. Преди изтриването се прави автоматичен архив. Въведете паролата на администратор на тази фирма.</p>
          <Field label="Парола" className="mt-3"><TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <MessageList messages={error} />
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Euro conversion (04b 4)                                             */
/* ------------------------------------------------------------------ */

interface EuroGrid {
  years: { from: boolean; to: boolean };
  differencesAccountId: number | null;
  flags: Record<string, boolean>;
  rows: { id: number; number: string; description: string; euroAccountId: number | null; euroAccountNumber: string | null }[];
  euroAccounts: { id: number; number: string; description: string }[];
}

const FLAG_LABELS: Record<string, string> = {
  mapping: 'Съответствие на сметките', openings: 'Начални салда 2026', postings: 'Контирания в 2026 по евро сметкоплана', bankTemplates: 'Банкови шаблони',
  fixedAssets: 'Дълготрайни активи', templates: 'Шаблони', reschedules: 'Разсрочвания', companyAccounts: 'Сметки на партньори', difference: 'Разлика от закръгляване',
};

/** Euro account of one BGN account: typed by number (a select per row would be too heavy for the whole chart). */
function EuroAccountCell({ value, accounts, onChange }: { value: number | null; accounts: EuroGrid['euroAccounts']; onChange: (id: number | null) => void }) {
  const current = accounts.find((a) => a.id === value) ?? null;
  const [text, setText] = useState(current?.number ?? '');
  useEffect(() => setText(current?.number ?? ''), [current?.number]);
  const found = accounts.find((a) => a.number === text.trim());
  return (
    <div className="flex items-center gap-2">
      <TextInput
        value={text}
        className={text.trim() && !found ? 'w-24 border-red-400' : 'w-24'}
        list="euro-accounts"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(found?.id ?? null)}
      />
      <span className="truncate text-[12px] text-slate-600">{found?.description ?? (text.trim() ? 'няма такава сметка' : '')}</span>
    </div>
  );
}

export function EuroConversion() {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const grid = useQuery({ queryKey: ['euro-conversion'], queryFn: () => api.get<EuroGrid>('/euro-conversion') });
  const [relations, setRelations] = useState<Record<number, number | null>>({});
  const [diff, setDiff] = useState<number | null>(null);
  const [opts, setOpts] = useState({ fixedAssets: true, templates: true, reschedules: true, backupFirst: true });
  const [filter, setFilter] = useState('');
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [report, setReport] = useState<Record<string, number | string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (grid.data) {
      setRelations(Object.fromEntries(grid.data.rows.map((r) => [r.id, r.euroAccountId])));
      setDiff(grid.data.differencesAccountId);
    }
  }, [grid.data]);
  const run = async () => {
    if (!(await dialogs.confirm('Конвертиране на базата данни към евро (2025 → 2026)? Всички отворени прозорци трябва да бъдат затворени.'))) return;
    setBusy(true);
    setMsgs([]);
    try {
      const r = await api.post<{ report: Record<string, number | string>; message: string; backup: { fileName: string } | null }>('/euro-conversion', { relations, differencesAccountId: diff, ...opts });
      setReport(r.report);
      await dialogs.alert(`${r.message}${r.backup ? `\nАрхив: ${r.backup.fileName}` : ''}`);
      await qc.invalidateQueries();
    } catch (e) {
      setMsgs(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  const g = grid.data;
  const euroSorted = useMemo(() => [...(g?.euroAccounts ?? [])].sort((a, b) => compareAccountNumbers(a.number, b.number)), [g]);
  const rows = g?.rows.filter((r) => !filter || r.number.startsWith(filter) || r.description.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CommandBar right={<Button variant="primary" icon={<Play className="size-3.5" />} disabled={busy || !g} onClick={run}>Конвертиране</Button>}>
        <TextInput placeholder="Търсене на сметка" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
        <span className="ml-2 text-[12px] text-slate-600">Сметка за обиране на разлики</span>
        <Select value={diff ?? ''} onChange={(e) => setDiff(e.target.value ? Number(e.target.value) : null)} className="w-64" aria-label="Сметка за обиране на разлики">
          <option value="">(не е избрана)</option>
          {euroSorted.map((a) => <option key={a.id} value={a.id}>{a.number} {a.description}</option>)}
        </Select>
        {Object.entries({ fixedAssets: 'ДМА', templates: 'Шаблони', reschedules: 'Разсрочвания', backupFirst: 'Архив преди конвертиране' }).map(([k, label]) => (
          <Checkbox key={k} label={label} checked={opts[k as keyof typeof opts]} onChange={(v) => setOpts({ ...opts, [k]: v })} />
        ))}
      </CommandBar>
      {g && (!g.years.from || !g.years.to) && <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-800">Нужни са счетоводни години 2025 и 2026.</div>}
      {g && (
        <div className="flex flex-wrap gap-3 border-b border-slate-200 px-3 py-1.5 text-[12px]">
          {Object.entries(g.flags).map(([k, v]) => <span key={k} className={v ? 'text-emerald-700' : 'text-slate-500'}>{v ? '✓' : '○'} {FLAG_LABELS[k] ?? k}</span>)}
        </div>
      )}
      <MessageList messages={msgs} />
      {report && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] text-emerald-800">
          {Object.entries(report).map(([k, v]) => `${FLAG_LABELS[k] ?? k}: ${v}`).join(' · ')}
        </div>
      )}
      <datalist id="euro-accounts">{g?.euroAccounts.map((a) => <option key={a.id} value={a.number}>{a.description}</option>)}</datalist>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead><tr><th className="w-28">Сметка (лв.)</th><th>Наименование</th><th className="w-72">Сметка (евро)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td><td>{r.description}</td>
                <td><EuroAccountCell value={relations[r.id] ?? null} accounts={g?.euroAccounts ?? []} onChange={(id) => setRelations({ ...relations, [r.id]: id })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export to external systems (04a 8.3)                                */
/* ------------------------------------------------------------------ */

interface ExportReport { id: number; name: string; fileName: string; description: string; parameters: { name: string; title: string; type: 'DateTime' | 'Text'; description?: string }[]; documents: { name: string; kind: string }[] }

export function ReportExports() {
  const s = useSession();
  const dialogs = useDialogs();
  const list = useQuery({ queryKey: ['report-exports'], queryFn: () => api.get<ExportReport[]>('/exchange/report-exports') });
  const [sel, setSel] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const r = list.data?.find((x) => x.id === sel) ?? null;
  useEffect(() => {
    if (r) setValues(Object.fromEntries(r.parameters.map((p) => [p.name, p.type === 'DateTime' ? (p.name.toLowerCase().includes('end') || p.name.toLowerCase().includes('to') ? `${s.year.year}-12-31` : `${s.year.year}-01-01`) : ''])));
  }, [r, s.year.year]);
  const add = async () => {
    if (!file) return;
    try {
      const x = await upload<{ id: number }>('/exchange/report-exports', file);
      setFile(null);
      await list.refetch();
      setSel(x.id);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const run = async () => {
    if (!r) return;
    try {
      await download(`/exchange/report-exports/${r.id}/run`, { parameters: values });
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CommandBar>
        <FileInput file={file} onChange={setFile} accept=".xml" label="Дефиниция (XML)..." />
        <Button disabled={!file} onClick={add}>Добавяне</Button>
        <Button variant="danger" disabled={!r} onClick={async () => { if (r && (await dialogs.confirm(`Премахване на „${r.name}“?`))) { await api.del(`/exchange/report-exports/${r.id}`); setSel(null); await list.refetch(); } }}>Премахване</Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-auto border-r border-slate-300">
          {list.data?.length ? (
            <table className="grid-table">
              <thead><tr><th>Експорт</th></tr></thead>
              <tbody>{list.data.map((x) => <tr key={x.id} aria-selected={x.id === sel} className="cursor-pointer" onClick={() => setSel(x.id)}><td>{x.name}</td></tr>)}</tbody>
            </table>
          ) : <Empty>Няма дефинирани експорти.</Empty>}
        </div>
        <div className="min-w-0 flex-1 overflow-auto p-3">
          {r && (
            <div className="flex max-w-[560px] flex-col gap-3">
              <div className="text-[13px] text-slate-600">{r.description}</div>
              {r.parameters.map((p) => (
                <Field key={p.name} label={p.title || p.name} hint={p.description}>
                  <TextInput type={p.type === 'DateTime' ? 'date' : 'text'} value={values[p.name] ?? ''} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
                </Field>
              ))}
              <div className="text-[12px] text-slate-500">Файлове: {r.documents.map((d) => `${d.name} (${d.kind})`).join(', ')}</div>
              <div className="flex justify-end"><Button variant="primary" icon={<FileDown className="size-3.5" />} onClick={run}>Експорт</Button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
