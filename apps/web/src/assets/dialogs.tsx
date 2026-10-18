import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseAmount } from '@shmi/core';
import { api } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { AccountPicker } from '../components/pickers.tsx';
import { Button, Checkbox, Dialog, Field, Select, Spinner, TextInput } from '../components/ui.tsx';
import { bgDate, money, monthLabel } from '../format.ts';
import { DocHeader, PrintableDoc, Signatures, useAssetLookups, type AssetRow, type Location } from './common.tsx';

const num = (v: string) => {
  const d = parseAmount(v.trim() || '0');
  return d ? d.toString() : null;
};

/* ------------------------------------------------------------------ */
/* Location group (Нова група / Редакция)                              */
/* ------------------------------------------------------------------ */

export function LocationDialog({ location, parent, onClose, onSaved }: { location?: Location; parent?: Location; onClose: () => void; onSaved: () => void }) {
  const dialogs = useDialogs();
  const [name, setName] = useState(location?.name ?? '');
  const save = async () => {
    try {
      if (location) await api.put(`/asset-locations/${location.id}`, { name });
      else await api.post('/asset-locations', { name, parentId: parent?.id ?? 1 });
      onSaved();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <Dialog title={location ? 'Редакция на местоположение' : 'Ново местоположение'} onClose={onClose} width={400}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()}>Запис</Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      {!location && parent && <div className="mb-2 text-[12px] text-slate-600">Подгрупа на: {parent.name}</div>}
      <Field label="Наименование">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </Field>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Отписване на актив (11)                                             */
/* ------------------------------------------------------------------ */

interface TerminateInfo {
  sapDate: string;
  dapDate: string;
  operation: number;
  sapEndDate: string | null;
  isRevalued: boolean;
  reserve: string;
  accrued: string;
  name: string;
  inventoryNumber: string;
}

export function TerminateDialog({ asset, onClose, onDone }: { asset: AssetRow; onClose: () => void; onDone: (r: { accountingId: number | null; number: string | null }) => void }) {
  const dialogs = useDialogs();
  const lookups = useAssetLookups();
  const info = useQuery({ queryKey: ['assetTerminate', asset.id], queryFn: () => api.get<TerminateInfo>(`/assets/${asset.id}/terminate`), staleTime: 0 });
  const [f, setF] = useState<{ type: number; sapDate: string; dapDate: string; operationAccountId: number | null; revaluationAccountId: number | null; profitAmount: string } | null>(null);
  useEffect(() => {
    if (info.data && !f) setF({ type: info.data.operation, sapDate: info.data.sapDate, dapDate: info.data.dapDate, operationAccountId: null, revaluationAccountId: null, profitAmount: '' });
  }, [info.data, f]);
  const submit = async () => {
    if (!f) return;
    const profit = num(f.profitAmount);
    try {
      const r = await api.post<{ accountingId: number | null; number: string | null }>(`/assets/${asset.id}/terminate`, { ...f, profitAmount: f.type === 4 ? profit : null });
      onDone(r);
    } catch (e) {
      await dialogs.error(e, 'Активът не може да бъде отписан');
    }
  };
  const posting = f && f.type !== 2;
  return (
    <Dialog title={`Отписване на актив ${asset.inventoryNumber}`} onClose={onClose} width={520}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={!f}>Отписване</Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      {!f || !info.data ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-slate-600">
            {asset.name}; начислени амортизации: {money(info.data.accrued)}; дата на изхабяване: {info.data.sapEndDate ? bgDate(info.data.sapEndDate) : '—'}
            {info.data.isRevalued && `; преоценъчен резерв: ${money(info.data.reserve)}`}
          </div>
          <Field label="Операция за отписване">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: Number(e.target.value) })}>
              {lookups.data?.terminationTypes.filter((t) => t.id > 1).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Дата на отписване (САП)">
              <TextInput type="date" value={f.sapDate} onChange={(e) => setF({ ...f, sapDate: e.target.value })} />
            </Field>
            <Field label="Дата на отписване (ДАП)">
              <TextInput type="date" value={f.dapDate} onChange={(e) => setF({ ...f, dapDate: e.target.value })} />
            </Field>
          </div>
          {posting && (
            <Field label={f.type === 4 ? 'Сметка за приход от продажба' : f.type === 5 ? 'Сметка за остатъчната стойност' : 'Сметка за разхода'}>
              <AccountPicker value={f.operationAccountId} onChange={(a) => setF({ ...f, operationAccountId: a?.id ?? null })} />
            </Field>
          )}
          {posting && info.data.isRevalued && (
            <Field label="Сметка за преоценъчния резерв">
              <AccountPicker value={f.revaluationAccountId} onChange={(a) => setF({ ...f, revaluationAccountId: a?.id ?? null })} />
            </Field>
          )}
          {f.type === 4 && (
            <Field label="Продажна цена">
              <TextInput className="num" value={f.profitAmount} onChange={(e) => setF({ ...f, profitAmount: e.target.value })} />
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Промяна на дълготраен актив по МСС (9)                              */
/* ------------------------------------------------------------------ */

interface IasInfo {
  name: string;
  inventoryNumber: string;
  isLand: boolean;
  improvementAmount: string;
  newAmount: string;
  lastProcessedDate: string;
  operationDate: string;
  acquisitionDate: string;
  reserve: string;
  accountsDefined: boolean;
  reserves: { date: string; amount: string }[];
}

export function IasDialog({ asset, onClose, onDone }: { asset: AssetRow; onClose: () => void; onDone: () => void }) {
  const dialogs = useDialogs();
  const info = useQuery({ queryKey: ['assetIas', asset.id], queryFn: () => api.get<IasInfo>(`/assets/${asset.id}/ias`), staleTime: 0 });
  const [mode, setMode] = useState<'revaluation' | 'improvement'>('revaluation');
  const [amount, setAmount] = useState('');
  const [withPosting, setWithPosting] = useState(true);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  useEffect(() => {
    if (!info.data) return;
    setAmount((mode === 'improvement' ? info.data.improvementAmount : info.data.newAmount).replace('.', ','));
    setDate((d) => d || info.data!.operationDate);
  }, [info.data, mode]);
  const submit = async () => {
    const a = num(amount);
    if (a === null) return void dialogs.alert('Невалидна сума.');
    if (mode === 'revaluation' && !(await dialogs.confirm(`Желаете ли преоценка на актив ${asset.inventoryNumber} до ${money(a)}${withPosting ? ' с контиране' : ' без операция'}?`))) return;
    try {
      await api.post(`/assets/${asset.id}/ias`, { mode, amount: a, withPosting: mode === 'revaluation' ? withPosting : false, accountId: mode === 'revaluation' && withPosting ? accountId : null, date: info.data?.isLand ? date : null });
      onDone();
    } catch (e) {
      await dialogs.error(e, 'Операцията не може да бъде извършена');
    }
  };
  const d = info.data;
  return (
    <Dialog title="Промяна на дълготраен актив по МСС" onClose={onClose} width={560}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={!d}>Запис</Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      {!d ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 text-[12.5px]">
            <div>Инв. №: <b>{d.inventoryNumber}</b> {d.name}</div>
            <div>Последен обработен месец: <b>{monthLabel(d.lastProcessedDate)}</b></div>
            <div>Дата на операцията: <b>{bgDate(d.isLand ? date : d.operationDate)}</b></div>
            <div>Преоценъчен резерв: <b>{money(d.reserve)}</b></div>
          </div>
          {d.isLand && <div className="rounded-sm bg-amber-50 px-2 py-1 text-[12px] text-amber-800">Активът е земя/гора: преоценката се извършва към избрана дата.</div>}
          {!d.accountsDefined && <div className="rounded-sm bg-red-50 px-2 py-1 text-[12px] text-red-800">Няма дефинирани сметки за разходи и приходи от преоценки.</div>}
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'revaluation'} onChange={() => setMode('revaluation')} /> Преоценка / обезценка</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'improvement'} onChange={() => setMode('improvement')} /> Подобрение (по цена на придобиване)</label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={mode === 'improvement' ? 'Нова отчетна стойност' : 'Нова балансова стойност'}>
              <TextInput className="num" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            {d.isLand && (
              <Field label="Дата на преоценка">
                <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            )}
          </div>
          {mode === 'revaluation' && (
            <>
              <Checkbox label="С контиране" checked={withPosting} onChange={setWithPosting} />
              {withPosting && (
                <Field label="Сметка за преоценъчния резерв">
                  <AccountPicker value={accountId} onChange={(a) => setAccountId(a?.id ?? null)} />
                </Field>
              )}
            </>
          )}
          <div>
            <div className="mb-1 text-[12px] text-slate-600">Предишни преоценки</div>
            <table className="grid-table">
              <thead>
                <tr><th>Дата</th><th className="text-right">Сума</th></tr>
              </thead>
              <tbody>
                {d.reserves.length === 0 ? <tr><td colSpan={2} className="text-slate-500">Няма</td></tr> : d.reserves.map((r, i) => (
                  <tr key={i}><td>{bgDate(r.date)}</td><td className="num">{money(r.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Промяна на общи данни на ДА (14.3) + protocols                       */
/* ------------------------------------------------------------------ */

interface CommonDataResult {
  applied: boolean;
  warnings: { text: string; items: string[] }[];
  confirmations: string[];
  protocol: { kind: 'mol' | 'sap' | 'dap'; inventoryNumber: string; name: string; from: string; to: string; cost: string; accrued: string; bookValue: string; inventoryAccount: string | null }[];
}

export function CommonDataDialog({ assets, onClose, onDone }: { assets: AssetRow[]; onClose: () => void; onDone: () => void }) {
  const dialogs = useDialogs();
  const lookups = useAssetLookups();
  const [mol, setMol] = useState('');
  const [sapRate, setSapRate] = useState('');
  const [dapRate, setDapRate] = useState('');
  const [result, setResult] = useState<CommonDataResult | null>(null);
  const body = () => ({ ids: assets.map((a) => a.id), mol: mol.trim() || null, sapRate: sapRate ? num(sapRate) : null, dapRate: dapRate ? num(dapRate) : null });
  const submit = async () => {
    try {
      const dry = await api.post<CommonDataResult>('/assets/common-data', body());
      for (const w of dry.warnings) await dialogs.alert(<>{w.text}<ul className="mt-1 list-disc pl-5">{w.items.map((i) => <li key={i}>{i}</li>)}</ul></>, 'Внимание');
      for (const c of dry.confirmations) if (!(await dialogs.confirm(c))) return;
      const done = await api.post<CommonDataResult>('/assets/common-data', { ...body(), confirm: true });
      setResult(done);
      onDone();
    } catch (e) {
      await dialogs.error(e, 'Промяната не може да бъде извършена');
    }
  };
  if (result) return <ChangeProtocolDialog result={result} onClose={onClose} />;
  const presets = lookups.data?.ratePresets ?? [];
  return (
    <Dialog title="Промяна на общи данни на ДА" onClose={onClose} width={480}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={!mol.trim() && !sapRate && !dapRate}>Запис</Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="mb-2 text-[12px] text-slate-600">Избрани активи: {assets.length}</div>
      <div className="flex flex-col gap-2">
        <Field label="Нов МОЛ">
          <TextInput value={mol} onChange={(e) => setMol(e.target.value)} />
        </Field>
        <RateField label="Нова годишна норма в счетоводния план (%)" value={sapRate} onChange={setSapRate} presets={presets} />
        <RateField label="Нова годишна норма в данъчния план (%)" value={dapRate} onChange={setDapRate} presets={presets} />
      </div>
    </Dialog>
  );
}

function RateField({ label, value, onChange, presets }: { label: string; value: string; onChange: (v: string) => void; presets: number[] }) {
  return (
    <Field label={label}>
      <div className="flex gap-1">
        <TextInput className="num" value={value} onChange={(e) => onChange(e.target.value)} />
        <Select className="w-20" value="" onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="Стандартни норми">
          <option value="">…</option>
          {presets.map((r) => <option key={r} value={r}>{r}%</option>)}
        </Select>
      </div>
    </Field>
  );
}

function ChangeProtocolDialog({ result, onClose }: { result: CommonDataResult; onClose: () => void }) {
  const [number, setNumber] = useState('1');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const molRows = result.protocol.filter((p) => p.kind === 'mol');
  const rateRows = result.protocol.filter((p) => p.kind !== 'mol');
  return (
    <Dialog title="Протокол за промяна" onClose={onClose} width={900} footer={<Button onClick={onClose}>Затвори</Button>}>
      {result.protocol.length === 0 ? (
        <div>Няма променени активи.</div>
      ) : (
        <PrintableDoc
          toolbar={
            <>
              <Field label="Протокол №"><TextInput className="w-24" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
              <Field label="от дата"><TextInput type="date" className="w-36" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            </>
          }
        >
          {molRows.length > 0 && (
            <>
              <DocHeader title={`ПРОТОКОЛ № ${number} от ${bgDate(date)}`} subtitle="За промяна на Материално отговорно лице" />
              <table className="grid-table">
                <thead><tr><th>Инвентарен номер</th><th>Наименование</th><th>От МОЛ</th><th>На МОЛ</th><th className="text-right">Отчетна стойност</th><th className="text-right">Начислени амортизации</th><th className="text-right">Балансова стойност</th><th>Инвентарна сметка</th></tr></thead>
                <tbody>
                  {molRows.map((r, i) => (
                    <tr key={i}><td>{r.inventoryNumber}</td><td>{r.name}</td><td>{r.from}</td><td>{r.to}</td><td className="num">{money(r.cost)}</td><td className="num">{money(r.accrued)}</td><td className="num">{money(r.bookValue)}</td><td>{r.inventoryAccount}</td></tr>
                  ))}
                </tbody>
              </table>
              <Signatures labels={['Предал:', 'Приел:']} />
            </>
          )}
          {rateRows.length > 0 && (
            <div className={molRows.length ? 'mt-10' : ''}>
              <DocHeader title={`ПРОТОКОЛ № ${number} от ${bgDate(date)}`} subtitle="За промяна на годишната амортизационна норма" />
              <table className="grid-table">
                <thead><tr><th>План</th><th>Инвентарен номер</th><th>Наименование</th><th className="text-right">Отчетна стойност</th><th className="text-right">Стар %</th><th className="text-right">Нов %</th></tr></thead>
                <tbody>
                  {rateRows.map((r, i) => (
                    <tr key={i}><td>{r.kind === 'sap' ? 'САП' : 'ДАП'}</td><td>{r.inventoryNumber}</td><td>{r.name}</td><td className="num">{money(r.cost)}</td><td className="num">{r.from}</td><td className="num">{r.to}</td></tr>
                  ))}
                </tbody>
              </table>
              <Signatures labels={['Съставил:', 'Одобрил:']} />
            </div>
          )}
        </PrintableDoc>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Проверка за въведени активи и амортизации (14.4)                     */
/* ------------------------------------------------------------------ */

export function CheckDialog({ year, onClose }: { year: number; onClose: () => void }) {
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [run, setRun] = useState(0);
  const q = useQuery({ queryKey: ['assetCheck', from, to, run], queryFn: () => api.get<{ ok: boolean; lines: string[] }>(`/assets/check?from=${from}&to=${to}`), enabled: run > 0, staleTime: 0 });
  return (
    <Dialog title="Проверка за въведени активи и амортизации" onClose={onClose} width={600}
      footer={
        <>
          <Button variant="primary" onClick={() => setRun((n) => n + 1)}>Проверка</Button>
          <Button onClick={onClose}>Затвори</Button>
        </>
      }
    >
      <div className="mb-3 flex gap-2">
        <Field label="От дата"><TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="До дата"><TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {q.isFetching ? <Spinner /> : q.data && (
        <div className={q.data.ok ? 'rounded-sm bg-emerald-50 p-2 text-emerald-800' : 'rounded-sm bg-amber-50 p-2 text-amber-900'}>
          {q.data.lines.map((l, i) => <div key={i} className={l.endsWith(':') ? 'font-semibold' : ''}>{l}</div>)}
        </div>
      )}
    </Dialog>
  );
}
