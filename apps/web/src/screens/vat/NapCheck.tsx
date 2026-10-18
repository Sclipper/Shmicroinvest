import { useState } from 'react';
import { Import, Play } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, CommandBar, Empty, Field, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { PeriodFields } from '../../reports/common.tsx';
import { useCan, useInvalidate, useSession } from '../../session.tsx';
import { fileToBase64, prevMonth } from './common.tsx';

/**
 * "Проверка на документи с файл от НАП" (UI_Reporting_Validation_AccountingsNAPFileValidation;
 * spec 05 7.7): compares a POKUPKI/PRODAGBI-format file with the booked documents.
 */

interface Row { partnerId: string; partnerName: string; documentCode: string; documentNumber: string; documentDate: string; base: string; vat: string; source?: string }
interface Result { missing: Row[]; absent: Row[]; different: { file: Row; booked: Row }[]; fileStartDate: string | null; fileEndDate: string | null }

function Table({ title, rows, source }: { title: string; rows: Row[]; source?: boolean }) {
  return (
    <section>
      <h3 className="mb-1 font-semibold">{title}</h3>
      <table className="grid-table">
        <thead>
          <tr><th>ЕИК Номер</th><th>Име на контрагент</th><th>Вид на документ</th><th>Номер на документ</th><th>Дата на документ</th><th className="text-right">Данъчна основа</th><th className="text-right">ДДС</th><th className="text-right">Сума на документ</th>{source && <th>Източник</th>}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.partnerId}</td><td>{r.partnerName}</td><td>{r.documentCode}</td><td>{r.documentNumber}</td><td>{bgDate(r.documentDate)}</td>
              <td className="num">{money(r.base)}</td><td className="num">{money(r.vat)}</td><td className="num">{money((Number(r.base) + Number(r.vat)).toFixed(2))}</td>
              {source && <td>{r.source}</td>}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={source ? 9 : 8} className="text-center text-slate-500">Няма.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

export function NapCheck() {
  const session = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [f, setF] = useState({ ...prevMonth(session.workingDate), kind: 'purchase' as 'purchase' | 'sale' });
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const body = async () => ({ from: f.from, to: f.to, kind: f.kind, file: { name: file!.name, data: await fileToBase64(file!) } });
  const run = async () => {
    if (!file) return void dialogs.alert('Изберете файл.');
    setBusy(true);
    try {
      setRes(await api.post<Result>('/vat/nap-check', await body()));
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setBusy(false);
    }
  };
  const importMissing = async () => {
    if (!file || !res?.missing.length || !(await dialogs.confirm(`Желаете ли импорт на ${res.missing.length} липсващи документа?`))) return;
    try {
      const r = await api.post<{ imported: number }>('/vat/nap-check/import', await body());
      await invalidate('entries', 'reports', 'accounts');
      await dialogs.alert(`Импортирани са ${r.imported} контирания.`);
      await run();
    } catch (e) {
      await dialogs.error(e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Play className="size-3.5" />} onClick={run} disabled={busy}>Справка</Button>
        <Button icon={<Import className="size-3.5" />} onClick={importMissing} disabled={!res?.missing.length || !can('UI_Operations_Import_VATDiaryImport')}>Импорт на липсващите документи</Button>
      </CommandBar>
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
        <Field label="Дневник">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'purchase' | 'sale' })}>
            <option value="purchase">Покупки (POKUPKI)</option>
            <option value="sale">Продажби (PRODAGBI)</option>
          </Select>
        </Field>
        <Field label="Файл от НАП">
          <TextInput type="file" accept=".txt,.TXT" className="w-72" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Файл от НАП" />
        </Field>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {busy ? <Empty><Spinner /></Empty> : !res ? <Empty>Изберете файл и натиснете „Справка“.</Empty> : (
          <div className="flex flex-col gap-4">
            {res.fileStartDate && <div className="text-[12px] text-slate-600">Файл: от {bgDate(res.fileStartDate)} до {bgDate(res.fileEndDate)}</div>}
            <Table title={`Липсващи документи на ${session.company.name}`} rows={res.missing} />
            <Table title={`Съществуващи документи на ${session.company.name}, липсващи в справката от НАП`} rows={res.absent} source />
            <section>
              <h3 className="mb-1 font-semibold">Несъответстващи данни в документи на {session.company.name}</h3>
              <table className="grid-table">
                <thead><tr><th>ЕИК Номер</th><th>Име на контрагент</th><th>Номер на документ</th><th>Дата</th><th className="text-right">ДО (НАП)</th><th className="text-right">ДДС (НАП)</th><th className="text-right">ДО (книги)</th><th className="text-right">ДДС (книги)</th></tr></thead>
                <tbody>
                  {res.different.map((x, i) => (
                    <tr key={i}><td>{x.file.partnerId}</td><td>{x.file.partnerName}</td><td>{x.file.documentNumber}</td><td>{bgDate(x.file.documentDate)}</td><td className="num">{money(x.file.base)}</td><td className="num">{money(x.file.vat)}</td><td className="num">{money(x.booked.base)}</td><td className="num">{money(x.booked.vat)}</td></tr>
                  ))}
                  {!res.different.length && <tr><td colSpan={8} className="text-center text-slate-500">Няма.</td></tr>}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
