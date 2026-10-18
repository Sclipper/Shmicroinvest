import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Import } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { AccountPicker } from '../../components/pickers.tsx';
import { Button, CommandBar, Field, Panel, TextInput } from '../../components/ui.tsx';
import { useInvalidate } from '../../session.tsx';
import { fileToBase64 } from './common.tsx';

/** "Импорт от ДДС Дневници" (UI_Operations_Import_VATDiaryImport; spec 04a 2). */

type Accounts = { expense?: number; vatPurchases?: number | null; suppliers?: number; customers?: number; revenue?: number; vatSales?: number | null };
const LABELS: [keyof Accounts, string][] = [
  ['expense', 'Разходи за външни услуги'], ['vatPurchases', 'ДДС покупки'], ['suppliers', 'Доставчици'],
  ['customers', 'Клиенти'], ['revenue', 'Продажби'], ['vatSales', 'ДДС продажби'],
];

export function VatImport() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const defaults = useQuery({ queryKey: ['vat', 'import-defaults'], queryFn: () => api.get<Accounts>('/vat/import/defaults') });
  const [acc, setAcc] = useState<Accounts>({});
  const [files, setFiles] = useState<{ purchases: File | null; sales: File | null }>({ purchases: null, sales: null });
  const [period, setPeriod] = useState({ from: '1900-01-01', to: '2100-01-01' });
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (defaults.data) setAcc(defaults.data);
  }, [defaults.data]);

  const run = async () => {
    if (!files.purchases || !files.sales) return void dialogs.alert('Файлът не е намерен! Изберете POKUPKI.TXT и PRODAGBI.TXT.');
    setBusy(true);
    try {
      const r = await api.post<{ purchases: number; sales: number; accountings: number; partnersCreated: number }>('/vat/import', {
        purchases: { name: files.purchases.name, data: await fileToBase64(files.purchases) },
        sales: { name: files.sales.name, data: await fileToBase64(files.sales) },
        from: period.from, to: period.to, accounts: acc,
      });
      await invalidate('entries', 'reports', 'accounts', 'partners');
      setResult(`Импортирани: ${r.purchases} реда покупки, ${r.sales} реда продажби, ${r.accountings} контирания, ${r.partnersCreated} нови партньора.`);
    } catch (e) {
      await dialogs.error(e, 'Грешка при импорта');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Import className="size-3.5" />} onClick={run} disabled={busy}>Импорт</Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
        <div className="grid max-w-4xl grid-cols-1 gap-3 md:grid-cols-2">
          <Panel title="Файлове">
            <div className="flex flex-col gap-2 p-3">
              <Field label="Дневник покупки (POKUPKI.TXT)">
                <TextInput type="file" accept=".txt,.TXT" onChange={(e) => setFiles({ ...files, purchases: e.target.files?.[0] ?? null })} aria-label="POKUPKI.TXT" />
              </Field>
              <Field label="Дневник продажби (PRODAGBI.TXT)">
                <TextInput type="file" accept=".txt,.TXT" onChange={(e) => setFiles({ ...files, sales: e.target.files?.[0] ?? null })} aria-label="PRODAGBI.TXT" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Документи от дата"><TextInput type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} /></Field>
                <Field label="до дата"><TextInput type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} /></Field>
              </div>
              <p className="text-[12px] text-slate-500">Файловете са във формата на НАП (Windows-1251). Редовете с протоколи за ВОП (код 10) се пропускат.</p>
            </div>
          </Panel>
          <Panel title="Сметки">
            <div className="flex flex-col gap-2 p-3">
              {LABELS.map(([k, label]) => (
                <Field key={k} label={label}>
                  <AccountPicker value={acc[k] ?? null} onChange={(a) => setAcc({ ...acc, [k]: a?.id ?? null })} />
                </Field>
              ))}
            </div>
          </Panel>
        </div>
        {result && <div className="mt-3 max-w-4xl rounded-sm border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900">{result}</div>}
      </div>
    </div>
  );
}
