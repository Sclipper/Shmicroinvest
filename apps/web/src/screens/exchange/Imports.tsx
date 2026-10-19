import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { api, type Message } from '../../api.ts';
import { AccountPicker } from '../../components/pickers.tsx';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, Field, Panel, Select, TextInput } from '../../components/ui.tsx';
import { useInvalidate, useLookups, useSession } from '../../session.tsx';
import { money } from '../../format.ts';
import { FileInput, MessageList, Wizard, download, errorMessages, upload } from './common.tsx';

interface CategoryRow { categoryId: number; name: string; accountId: number | null; accountNumber: string | null }

function CategoryGrid({ rows, value, onChange }: { rows: CategoryRow[]; value: Record<number, number | null>; onChange: (v: Record<number, number | null>) => void }) {
  return (
    <table className="grid-table">
      <thead>
        <tr><th className="w-72">Категория</th><th>Сметка</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.categoryId}>
            <td>{r.name}</td>
            <td><AccountPicker value={value[r.categoryId] ?? null} onChange={(a) => onChange({ ...value, [r.categoryId]: a?.id ?? null })} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function useResult() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [done, setDone] = useState<string | null>(null);
  return { messages, setMessages, done, setDone, reset: () => { setMessages([]); setDone(null); } };
}

/* ------------------------------------------------------------------ */
/* Text file (04a 4)                                                   */
/* ------------------------------------------------------------------ */

export function TextImport() {
  const s = useSession();
  const invalidate = useInvalidate();
  const cats = useQuery({ queryKey: ['exchange', 'text-categories'], queryFn: () => api.get<CategoryRow[]>('/exchange/text/categories') });
  const [file, setFile] = useState<File | null>(null);
  const [usePeriod, setUsePeriod] = useState(false);
  const [from, setFrom] = useState(`${s.year.year}-01-01`);
  const [to, setTo] = useState(`${s.year.year}-12-31`);
  const [term, setTerm] = useState('');
  const [map, setMap] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const res = useResult();
  useEffect(() => {
    if (cats.data) setMap(Object.fromEntries(cats.data.map((c) => [c.categoryId, c.accountId])));
  }, [cats.data]);
  const run = async () => {
    if (!file) return;
    setBusy(true);
    res.reset();
    try {
      const r = await upload<{ accountings: number; message: string }>('/exchange/text/import', file, {
        from: usePeriod ? from : undefined, to: usePeriod ? to : undefined, predefinedTerm: term.trim() || undefined, categoryMap: map,
      });
      res.setDone(`${r.message} Записани контирания: ${r.accountings}.`);
      await invalidate('entries', 'reports', 'partners');
    } catch (e) {
      res.setMessages(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-auto p-3" data-testid="text-import">
      <div className="flex max-w-[900px] flex-col gap-3">
        <Panel title="Импорт на операции от текстов файл">
          <div className="flex flex-col gap-3 p-3">
            <Field label="Файл (по един запис на ред, полета разделени с |)">
              <FileInput file={file} onChange={setFile} accept=".txt,.csv,text/plain" testId="text-file" />
            </Field>
            <div className="flex flex-wrap items-end gap-3">
              <Checkbox label="Само операциите в периода" checked={usePeriod} onChange={setUsePeriod} />
              <Field label="От дата"><TextInput type="date" value={from} disabled={!usePeriod} onChange={(e) => setFrom(e.target.value)} className="w-36" /></Field>
              <Field label="До дата"><TextInput type="date" value={to} disabled={!usePeriod} onChange={(e) => setTo(e.target.value)} className="w-36" /></Field>
              <Field label="Основание за всички редове" className="min-w-64 flex-1"><TextInput value={term} maxLength={255} onChange={(e) => setTerm(e.target.value)} /></Field>
            </div>
          </div>
        </Panel>
        <Panel title="Сметки по категории">
          <CategoryGrid rows={cats.data ?? []} value={map} onChange={setMap} />
        </Panel>
        <MessageList messages={res.messages} />
        {res.done && <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800" data-testid="import-done">{res.done}</div>}
        <div className="flex justify-end"><Button variant="primary" disabled={!file || busy} onClick={run}>Импорт</Button></div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* XML (04a 3)                                                         */
/* ------------------------------------------------------------------ */

interface XmlValidate { accounts: number; partners: number; products: number; accountings: number; operations: number; needsCategories: boolean }
interface XmlSettings { isDocumentsClosingEnabled: boolean; selectedWayOfSearching: 'document' | 'amount' | 'optionalReference'; ways: { id: string; label: string }[] }

export function XmlImport() {
  const invalidate = useInvalidate();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<XmlValidate | null>(null);
  const cats = useQuery({ queryKey: ['exchange', 'xml-categories'], queryFn: () => api.get<CategoryRow[]>('/exchange/xml/categories') });
  const [map, setMap] = useState<Record<number, number | null>>({});
  const settings = useQuery({ queryKey: ['exchange', 'xml-settings'], queryFn: () => api.get<XmlSettings>('/exchange/xml/settings') });
  const [closing, setClosing] = useState<{ enabled: boolean; way: XmlSettings['selectedWayOfSearching'] }>({ enabled: false, way: 'document' });
  const [busy, setBusy] = useState(false);
  const res = useResult();
  useEffect(() => {
    if (cats.data) setMap(Object.fromEntries(cats.data.map((c) => [c.categoryId, c.accountId])));
  }, [cats.data]);
  useEffect(() => {
    if (settings.data) setClosing({ enabled: settings.data.isDocumentsClosingEnabled, way: settings.data.selectedWayOfSearching });
  }, [settings.data]);
  const validate = async () => {
    if (!file) return;
    setBusy(true);
    res.reset();
    try {
      const v = await upload<XmlValidate>('/exchange/xml/validate', file);
      setInfo(v);
      setStep(v.needsCategories ? 1 : 2);
    } catch (e) {
      res.setMessages(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    res.reset();
    try {
      const r = await upload<{ accounts: number; partners: number; products: number; accountings: number; closedPairs?: number; warnings: Message[]; message: string }>('/exchange/xml/import', file, {
        categoryMap: info?.needsCategories ? map : undefined, isDocumentsClosingEnabled: closing.enabled, selectedWayOfSearching: closing.way,
      });
      res.setMessages(r.warnings ?? []);
      res.setDone(`${r.message} Сметки: ${r.accounts}, партньори: ${r.partners}, СМЗ: ${r.products}, контирания: ${r.accountings}.${r.closedPairs !== undefined ? ` Закрити двойки документи: ${r.closedPairs}.` : ''}`);
      await invalidate('entries', 'reports', 'partners', 'accounts', 'payments', 'exchange');
    } catch (e) {
      res.setMessages(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Wizard
      steps={['Избор на файл', 'Сметки по категории', 'Импорт']}
      step={step}
      footer={
        <>
          {step > 0 && <Button onClick={() => { setStep(0); res.reset(); }}>Назад</Button>}
          {step === 0 && <Button variant="primary" disabled={!file || busy} onClick={validate}>Напред</Button>}
          {step === 1 && <Button variant="primary" onClick={() => setStep(2)}>Напред</Button>}
          {step === 2 && <Button variant="primary" disabled={busy || !!res.done} onClick={run}>Импорт</Button>}
        </>
      }
    >
      <div className="flex max-w-[800px] flex-col gap-3">
        {step === 0 && (
          <Field label="XML файл (urn:Transfer)"><FileInput file={file} onChange={setFile} accept=".xml" testId="xml-file" /></Field>
        )}
        {step === 1 && <CategoryGrid rows={cats.data ?? []} value={map} onChange={setMap} />}
        {step === 2 && info && (
          <table className="grid-table w-auto">
            <tbody>
              <tr><td>Сметки</td><td className="text-right">{info.accounts}</td></tr>
              <tr><td>Партньори</td><td className="text-right">{info.partners}</td></tr>
              <tr><td>СМЗ</td><td className="text-right">{info.products}</td></tr>
              <tr><td>Контирания</td><td className="text-right">{info.accountings}</td></tr>
              <tr><td>Операции</td><td className="text-right">{info.operations}</td></tr>
            </tbody>
          </table>
        )}
        {step === 2 && info && (
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox label="Закриване на документи след импорта" checked={closing.enabled} onChange={(v) => setClosing({ ...closing, enabled: v })} />
            <Select value={closing.way} disabled={!closing.enabled} onChange={(e) => setClosing({ ...closing, way: e.target.value as XmlSettings['selectedWayOfSearching'] })} className="w-64" aria-label="Начин на търсене">
              {(settings.data?.ways ?? []).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </Select>
          </div>
        )}
        <MessageList messages={res.messages} />
        {res.done && <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">{res.done}</div>}
      </div>
    </Wizard>
  );
}

export function XmlExport() {
  const s = useSession();
  const dialogs = useDialogs();
  const [from, setFrom] = useState(`${s.year.year}-01-01`);
  const [to, setTo] = useState(`${s.year.year}-12-31`);
  const [startNumber, setStart] = useState('');
  const [endNumber, setEnd] = useState('');
  const [fileName, setFileName] = useState('Transfer.xml');
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const run = async () => {
    setMsgs([]);
    setDone(null);
    try {
      const h = await download('/exchange/xml/export', { from, to, startNumber: startNumber.trim() || null, endNumber: endNumber.trim() || null, fileName });
      const w = h.get('x-export-warning');
      setDone(`Експортирани контирания: ${h.get('x-export-count')}.`);
      if (w) await dialogs.alert(decodeURIComponent(w));
    } catch (e) {
      setMsgs(errorMessages(e));
    }
  };
  return (
    <div className="h-full overflow-auto p-3">
      <Panel title="Експорт към XML" className="max-w-[640px]">
        <div className="flex flex-col gap-3 p-3">
          <div className="flex gap-3">
            <Field label="От дата"><TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" /></Field>
            <Field label="До дата"><TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" /></Field>
          </div>
          <div className="flex gap-3">
            <Field label="От документ №"><TextInput value={startNumber} onChange={(e) => setStart(e.target.value)} className="w-36" /></Field>
            <Field label="До документ №"><TextInput value={endNumber} onChange={(e) => setEnd(e.target.value)} className="w-36" /></Field>
          </div>
          <Field label="Име на файла"><TextInput value={fileName} onChange={(e) => setFileName(e.target.value)} /></Field>
          <MessageList messages={msgs} />
          {done && <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">{done}</div>}
          <div className="flex justify-end"><Button variant="primary" icon={<FileDown className="size-3.5" />} onClick={run}>Експорт</Button></div>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Excel (04a 5)                                                       */
/* ------------------------------------------------------------------ */

type Entity = 'operations' | 'partners' | 'chart' | 'products' | 'initialBalances';
interface EntityDef { entity: Entity; title: string; setupSheet: string; columns: { key: string; caption: string; ica?: boolean }[]; mapping: Mapping | null }
interface Mapping { sheetName: string; startingRow: number; endingRow: number; columns: Record<string, string>; hasIcaColumns?: boolean; conflictMode?: 'insert' | 'update' | 'ignore' | 'error' }

const emptyMapping = (): Mapping => ({ sheetName: '', startingRow: 2, endingRow: 1000, columns: {} });

export function ExcelImport() {
  const invalidate = useInvalidate();
  const entities = useQuery({ queryKey: ['exchange', 'excel-entities'], queryFn: () => api.get<EntityDef[]>('/exchange/excel/entities') });
  const [step, setStep] = useState(0);
  const [entity, setEntity] = useState<Entity>('operations');
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<{ name: string; rows: number }[]>([]);
  const [m, setM] = useState<Mapping>(emptyMapping());
  const [busy, setBusy] = useState(false);
  const res = useResult();
  const def = entities.data?.find((e) => e.entity === entity);
  const inspect = async () => {
    if (!file) return;
    setBusy(true);
    res.reset();
    try {
      const r = await upload<{ sheets: { name: string; rows: number }[]; setup: Partial<Mapping> | null }>('/exchange/excel/inspect', file, { entity });
      setSheets(r.sheets);
      const base = def?.mapping ?? emptyMapping();
      const merged: Mapping = { ...base, ...(r.setup ?? {}), columns: { ...base.columns, ...(r.setup?.columns ?? {}) } };
      if (!r.sheets.some((sh) => sh.name === merged.sheetName)) merged.sheetName = r.sheets[0]?.name ?? '';
      setM(merged);
      setStep(1);
    } catch (e) {
      res.setMessages(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    res.reset();
    try {
      const r = await upload<{ rows: number; created: number; updated: number; message: string }>('/exchange/excel/import', file, { entity, mapping: m });
      res.setDone(`${r.message} Обработени редове: ${r.rows}, записани: ${r.created}${r.updated ? `, обновени: ${r.updated}` : ''}.`);
      await invalidate('entries', 'reports', 'partners', 'accounts', 'exchange');
    } catch (e) {
      res.setMessages(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Wizard
      steps={['Вид данни и файл', 'Съответствие на колоните', 'Импорт']}
      step={step}
      footer={
        <>
          {step === 0 && <Button disabled={!def} icon={<FileDown className="size-3.5" />} onClick={() => def && download('/exchange/excel/template', { entity, mapping: def.mapping ?? { ...emptyMapping(), columns: Object.fromEntries(def.columns.filter((c) => !c.ica).map((c, i) => [c.key, String.fromCharCode(65 + i)])) } })}>Празен шаблон</Button>}
          {step > 0 && <Button onClick={() => { setStep(step - 1); res.reset(); }}>Назад</Button>}
          {step === 0 && <Button variant="primary" disabled={!file || busy} onClick={inspect}>Напред</Button>}
          {step === 1 && <Button variant="primary" onClick={() => setStep(2)}>Напред</Button>}
          {step === 2 && <Button variant="primary" disabled={busy || !!res.done} onClick={run}>Импорт</Button>}
        </>
      }
    >
      <div className="flex max-w-[860px] flex-col gap-3">
        {step === 0 && (
          <>
            <Field label="Вид данни">
              <Select value={entity} onChange={(e) => setEntity(e.target.value as Entity)} className="w-72">
                {entities.data?.map((e) => <option key={e.entity} value={e.entity}>{e.title}</option>)}
              </Select>
            </Field>
            <Field label="Файл на Excel (*.xlsx, *.xls)"><FileInput file={file} onChange={setFile} accept=".xlsx,.xls" /></Field>
          </>
        )}
        {step === 1 && def && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Лист">
                <Select value={m.sheetName} onChange={(e) => setM({ ...m, sheetName: e.target.value })} className="w-56">
                  {sheets.map((sh) => <option key={sh.name} value={sh.name}>{sh.name} ({sh.rows} реда)</option>)}
                </Select>
              </Field>
              <Field label="Начален ред"><TextInput type="number" min={1} value={m.startingRow} onChange={(e) => setM({ ...m, startingRow: Number(e.target.value) })} className="w-24" /></Field>
              <Field label="Краен ред"><TextInput type="number" min={1} value={m.endingRow} onChange={(e) => setM({ ...m, endingRow: Number(e.target.value) })} className="w-24" /></Field>
              {entity === 'operations' && <Checkbox label="Колони за ВОП" checked={!!m.hasIcaColumns} onChange={(v) => setM({ ...m, hasIcaColumns: v })} />}
              {entity !== 'operations' && entity !== 'initialBalances' && (
                <Field label="При съществуващ запис">
                  <Select value={m.conflictMode === 'update' ? 'update' : 'error'} onChange={(e) => setM({ ...m, conflictMode: e.target.value as Mapping['conflictMode'] })} className="w-48" aria-label="При съществуващ запис">
                    <option value="error">{entity === 'chart' ? 'Грешка' : 'Без промяна'}</option>
                    <option value="update">Обновяване</option>
                  </Select>
                </Field>
              )}
            </div>
            <table className="grid-table">
              <thead><tr><th>Поле</th><th className="w-32">Колона</th></tr></thead>
              <tbody>
                {def.columns.filter((c) => !c.ica || m.hasIcaColumns).map((c) => (
                  <tr key={c.key}>
                    <td>{c.caption}</td>
                    <td><TextInput value={m.columns[c.key] ?? ''} maxLength={3} className="uppercase" onChange={(e) => setM({ ...m, columns: { ...m.columns, [c.key]: e.target.value.toUpperCase() } })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {step === 2 && <p>Ще бъдат импортирани редове {m.startingRow}-{m.endingRow} от лист „{m.sheetName}“ ({def?.title}). При грешка в който и да е ред нищо не се записва.</p>}
        <MessageList messages={res.messages} />
        {res.done && <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">{res.done}</div>}
      </div>
    </Wizard>
  );
}

/* ------------------------------------------------------------------ */
/* ТРЗ Pro (04a 6)                                                     */
/* ------------------------------------------------------------------ */

interface TrzRow { key: string; departmentCode: string; departmentName: string; itemId: number; itemName: string; amount: string; debit: string; credit: string }
interface TrzPreview { months: string[]; month?: string; accountingDate?: string; term?: string; grid: TrzRow[]; total?: string; warning?: string }

export function TrzImport() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const accounts = useQuery({ queryKey: ['exchange', 'trz-accounts'], queryFn: () => api.get<{ missing: { number: string; description: string }[]; message: string }>('/exchange/trz/accounts') });
  const [file, setFile] = useState<File | null>(null);
  const [level, setLevel] = useState(0);
  const [byDetails, setByDetails] = useState(false);
  const [p, setP] = useState<TrzPreview | null>(null);
  const [date, setDate] = useState('');
  const [term, setTerm] = useState('');
  const [docType, setDocType] = useState<number>(0);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    const d = lookups.data?.documentTypes.find((x) => x.shortName.trim().toLowerCase() === 'вж') ?? lookups.data?.documentTypes[0];
    if (d && !docType) setDocType(d.id);
  }, [lookups.data, docType]);
  const preview = async (month?: string) => {
    if (!file) return;
    setMsgs([]);
    setDone(null);
    try {
      const r = await upload<TrzPreview>('/exchange/trz/preview', file, { month, level, byDetails });
      setP(r);
      setDate(r.accountingDate ?? '');
      setTerm(r.term ?? '');
      if (r.warning) setMsgs([{ key: 'w', text: r.warning, severity: 'warning' }]);
    } catch (e) {
      setMsgs(errorMessages(e));
    }
  };
  const run = async (confirmReimport = false): Promise<void> => {
    if (!p?.month) return;
    setMsgs([]);
    try {
      const r = await api.post<{ accountings: number; message: string }>('/exchange/trz/import', {
        month: p.month, accountingDate: date, term, documentTypeId: docType, confirmReimport,
        rows: p.grid.map((g) => ({ itemId: g.itemId, itemName: g.itemName, departmentName: g.departmentName, amount: g.amount, debit: g.debit, credit: g.credit })),
      });
      setDone(`${r.message} Контирания: ${r.accountings}.`);
      await invalidate('entries', 'reports');
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 409 && (await dialogs.confirm(err.message ?? ''))) return run(true);
      setMsgs(errorMessages(e));
    }
  };
  const define = async () => {
    try {
      const r = await api.post<{ message: string }>('/exchange/trz/accounts');
      await dialogs.alert(r.message);
      await accounts.refetch();
      await invalidate('accounts');
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const setRow = (key: string, patch: Partial<TrzRow>) => p && setP({ ...p, grid: p.grid.map((g) => (g.key === key ? { ...g, ...patch } : g)) });
  return (
    <div className="h-full overflow-auto p-3">
      <div className="flex flex-col gap-3">
        <Panel title="Импорт от ТРЗ Pro" actions={<Button variant="ghost" className="-my-1 h-6" onClick={define}>Дефиниране на сметки</Button>}>
          <div className="flex flex-col gap-3 p-3">
            {accounts.data && <div className="text-[13px] text-slate-600">{accounts.data.message}{accounts.data.missing.length ? `: ${accounts.data.missing.map((a) => a.number).join(', ')}` : ''}</div>}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Файл с ведомостта (CSV, експорт от ТРЗ Pro)"><FileInput file={file} onChange={setFile} accept=".csv,.txt" /></Field>
              <Field label="Ниво на отделите"><TextInput type="number" min={0} max={10} value={level} onChange={(e) => setLevel(Number(e.target.value))} className="w-20" /></Field>
              <Checkbox label="Детайлно по пера" checked={byDetails} onChange={setByDetails} />
              <Button disabled={!file} onClick={() => preview(p?.month)}>Зареждане</Button>
            </div>
            {p && p.months.length > 0 && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Месец">
                  <Select value={p.month} onChange={(e) => preview(e.target.value)} className="w-32">
                    {p.months.map((mm) => <option key={mm} value={mm}>{mm.slice(5, 7)}.{mm.slice(0, 4)}</option>)}
                  </Select>
                </Field>
                <Field label="Дата на контиране"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-36" /></Field>
                <Field label="Вид документ">
                  <Select value={docType} onChange={(e) => setDocType(Number(e.target.value))} className="w-48">
                    {lookups.data?.documentTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </Select>
                </Field>
                <Field label="Основание" className="min-w-72 flex-1"><TextInput value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
              </div>
            )}
          </div>
        </Panel>
        {p && p.grid.length > 0 && (
          <Panel title="Контировки">
            <table className="grid-table">
              <thead><tr><th>Отдел</th><th>Перо</th><th className="text-right">Сума</th><th className="w-28">Дебит</th><th className="w-28">Кредит</th></tr></thead>
              <tbody>
                {p.grid.map((g) => (
                  <tr key={g.key}>
                    <td>{g.departmentName}</td>
                    <td>{g.itemName}</td>
                    <td className="text-right tabular-nums">{money(g.amount)}</td>
                    <td><TextInput value={g.debit} onChange={(e) => setRow(g.key, { debit: e.target.value })} /></td>
                    <td><TextInput value={g.credit} onChange={(e) => setRow(g.key, { credit: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2}>Общо</td><td className="text-right">{money(p.total)}</td><td colSpan={2} /></tr></tfoot>
            </table>
          </Panel>
        )}
        <MessageList messages={msgs} />
        {done && <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">{done}</div>}
        {p?.month && <div className="flex justify-end"><Button variant="primary" onClick={() => run()}>Импорт</Button></div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Microinvest Delta (04a 7)                                           */
/* ------------------------------------------------------------------ */

type DeltaType = 'partners' | 'chartAndPartners' | 'all';
interface DeltaInfo { defaultFile: string; warning: string; types: { id: DeltaType; label: string }[]; blockers: Record<DeltaType, Message[]> }
interface DeltaResult {
  type: DeltaType; myCompany: boolean; accounts: number; partners: number; partnersMatched: number; accountings: number; openingBalances: number;
  years: { year: number; table: string; accountings: number; openingBalances: number; skipped: number }[]; warnings: Message[]; message: string;
}

export function DeltaConversion() {
  const invalidate = useInvalidate();
  const dialogs = useDialogs();
  const info = useQuery({ queryKey: ['exchange', 'delta'], queryFn: () => api.get<DeltaInfo>('/exchange/delta') });
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<DeltaType>('all');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [result, setResult] = useState<DeltaResult | null>(null);
  const blockers = info.data?.blockers[type] ?? [];
  const run = async () => {
    if (!file || !info.data) return;
    if (!(await dialogs.confirm(info.data.warning, 'Импорт от Microinvest Делта'))) return;
    setBusy(true);
    setMessages([]);
    setResult(null);
    try {
      const r = await upload<DeltaResult>('/exchange/delta/import', file, { type });
      setResult(r);
      await invalidate('entries', 'reports', 'partners', 'accounts', 'years', 'my-company', 'exchange');
    } catch (e) {
      setMessages(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-auto p-3" data-testid="delta-conversion">
      <div className="flex max-w-[760px] flex-col gap-3">
        <Panel title="Импорт от Microinvest Делта">
          <div className="flex flex-col gap-3 p-3">
            <Field label="База данни на Microinvest Делта (*.mdb)" hint={info.data ? `Обичайно местоположение: ${info.data.defaultFile}` : undefined}>
              <FileInput file={file} onChange={setFile} accept=".mdb,.MDB" testId="delta-file" />
            </Field>
            <Field label="Вид на импорта">
              <Select value={type} onChange={(e) => setType(e.target.value as DeltaType)} className="w-80" data-testid="delta-type">
                {(info.data?.types ?? []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </Select>
            </Field>
            <p className="text-[12px] text-slate-500">Данните се прехвърлят в активната фирма, която трябва да е празна. Операциите до 2025 г. се записват в лева, всяка в своята счетоводна година.</p>
          </div>
        </Panel>
        <MessageList messages={[...blockers, ...messages]} />
        {result && (
          <Panel title="Резултат">
            <div className="flex flex-col gap-2 p-3" data-testid="delta-result">
              <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800" data-testid="import-done">{result.message}</div>
              <table className="grid-table">
                <tbody>
                  <tr><td className="w-72">Данни за фирмата</td><td>{result.myCompany ? 'прехвърлени' : 'няма'}</td></tr>
                  <tr><td>Сметки</td><td className="tabular-nums">{result.accounts}</td></tr>
                  <tr><td>Партньори (нови / съществуващи)</td><td className="tabular-nums">{result.partners} / {result.partnersMatched}</td></tr>
                  <tr><td>Контирания</td><td className="tabular-nums">{result.accountings}</td></tr>
                  <tr><td>Начални салда</td><td className="tabular-nums">{result.openingBalances}</td></tr>
                </tbody>
              </table>
              {result.years.length > 0 && (
                <table className="grid-table">
                  <thead><tr><th>Таблица</th><th className="w-24">Година</th><th className="w-28 text-right">Контирания</th><th className="w-28 text-right">Начални салда</th><th className="w-28 text-right">Пропуснати</th></tr></thead>
                  <tbody>
                    {result.years.map((y) => (
                      <tr key={y.table}><td>{y.table}</td><td>{y.year}</td><td className="text-right tabular-nums">{y.accountings}</td><td className="text-right tabular-nums">{y.openingBalances}</td><td className="text-right tabular-nums">{y.skipped}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <MessageList messages={result.warnings} />
            </div>
          </Panel>
        )}
        <div className="flex justify-end"><Button variant="primary" disabled={!file || busy || blockers.length > 0} onClick={run} data-testid="delta-run">{busy ? 'Прехвърляне...' : 'Импорт'}</Button></div>
      </div>
    </div>
  );
}
