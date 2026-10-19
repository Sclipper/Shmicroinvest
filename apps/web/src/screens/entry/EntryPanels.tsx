import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Paperclip, ScanLine, Trash2 } from 'lucide-react';
import { JOURNAL_EXTRA_MESSAGES as X, validateAttachment } from '@shmi/core';
import { api, ApiError } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Dialog, Field, Select, TextInput } from '../../components/ui.tsx';
import { money } from '../../format.ts';
import type { Account } from '../../types.ts';
import { ScanDialog } from './ScanDialog.tsx';

interface Attachment {
  id: number;
  fileName: string;
  description: string;
  mimeType: string;
  size: number;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Прикачени файлове (02a 4.6): add from file (10 MB, no .exe/.bat/.dll) or from the scanner (camera), open, delete. */
export function AttachmentsPanel({ entryId, readOnly }: { entryId: number; readOnly?: boolean }) {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const key = ['entries', 'attachments', entryId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ rows: Attachment[] }>(`/journal/entries/${entryId}/attachments`) });
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  /** Uploads one file; false when it was refused or the upload failed. */
  const upload = async (file: File): Promise<boolean> => {
    const errs = validateAttachment(file.name, file.size);
    if (errs.length) {
      await dialogs.alert(errs.map((m) => m.text).join('\n'), 'Прикачени файлове');
      return false;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/journal/entries/${entryId}/attachments?fileName=${encodeURIComponent(file.name)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; messages?: never };
        throw new ApiError(res.status, data.error ?? X.strIOErrorReadingFile, data.messages);
      }
      await qc.invalidateQueries({ queryKey: ['entries'] });
      return true;
    } catch (e) {
      await dialogs.error(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Attachment) => {
    if (!(await dialogs.confirm(`Желаете ли да премахнете файла „${a.fileName}“?`))) return;
    try {
      await api.del(`/journal/attachments/${a.id}`);
      await qc.invalidateQueries({ queryKey: ['entries'] });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const rows = q.data?.rows ?? [];
  return (
    <div className="mt-3 rounded-sm border border-slate-300 bg-white" data-testid="attachments">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-2 py-1">
        <span className="font-semibold text-slate-700">Прикачени файлове ({rows.length})</span>
        <input ref={input} type="file" className="hidden" onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="h-6 px-2" icon={<Paperclip className="size-3.5" />} disabled={readOnly || busy} onClick={() => input.current?.click()}>
            {X.strAddAttachmentFromFile}
          </Button>
          <Button variant="ghost" className="h-6 px-2" icon={<ScanLine className="size-3.5" />} disabled={readOnly || busy} onClick={() => setScanning(true)}>
            {X.strAddAttachmentFromScan}
          </Button>
        </div>
      </div>
      {scanning && <ScanDialog onSave={upload} onClose={() => setScanning(false)} />}
      {rows.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-2 py-1">
              <a className="flex-1 truncate text-brand-700 hover:underline" href={`/api/journal/attachments/${a.id}/download`} target="_blank" rel="noreferrer">
                {a.fileName}
              </a>
              <span className="text-[12px] text-slate-500">{kb(a.size)}</span>
              <a className="rounded p-1 text-slate-500 hover:bg-slate-100" href={`/api/journal/attachments/${a.id}/download`} download={a.fileName} aria-label="Изтегли">
                <Download className="size-3.5" />
              </a>
              {!readOnly && (
                <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove(a)} aria-label="Премахни файла">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Текущо салдо (IsAccountingBalanceEnabled): balances of the accounts used in the entry, before it. */
export function BalancePanel({ accountIds, date, excludeId, byId }: { accountIds: number[]; date: string; excludeId?: number; byId: Map<number, Account> }) {
  const ids = [...new Set(accountIds)].sort((a, b) => a - b);
  const q = useQuery({
    queryKey: ['entries', 'balances', ids.join(','), date, excludeId ?? 0],
    queryFn: () => api.get<{ rows: { accountId: number; debit: string; credit: string; balance: string }[] }>(`/journal/account-balances?ids=${ids.join(',')}&date=${date}&excludeId=${excludeId ?? 0}`),
    enabled: ids.length > 0,
  });
  if (!ids.length) return null;
  const byAcc = new Map((q.data?.rows ?? []).map((r) => [r.accountId, r]));
  return (
    <div className="mt-3 rounded-sm border border-slate-300 bg-white" data-testid="balances">
      <div className="border-b border-slate-200 bg-slate-100 px-2 py-1 font-semibold text-slate-700">Текущо салдо към {date.split('-').reverse().join('.')}</div>
      <table className="grid-table">
        <thead>
          <tr>
            <th>Сметка</th>
            <th className="text-right">Оборот Дт</th>
            <th className="text-right">Оборот Кт</th>
            <th className="text-right">Салдо</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const r = byAcc.get(id);
            const bal = Number(r?.balance ?? 0);
            return (
              <tr key={id}>
                <td>
                  {byId.get(id)?.number} {byId.get(id)?.description}
                </td>
                <td className="num">{money(r?.debit ?? '0')}</td>
                <td className="num">{money(r?.credit ?? '0')}</td>
                <td className="num">{bal === 0 ? money(0) : `${money(Math.abs(bal))} ${bal > 0 ? 'Дт' : 'Кт'}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface ExpensesChoice {
  amount: string;
  side: 'debit' | 'credit';
  base: 'amount' | 'quantity';
}

/** Разпределяне на допълнителни разходи (02a 4.7): amount, by amount / by quantity, over debit or credit lines. */
export function ExpensesDialog({ onOk, onClose }: { onOk: (c: ExpensesChoice) => void; onClose: () => void }) {
  const [c, setC] = useState<ExpensesChoice>({ amount: '', side: 'debit', base: 'amount' });
  const amount = c.amount.replace(',', '.').trim();
  const valid = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  return (
    <Dialog
      title="Разпределяне на допълнителни разходи"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="primary" disabled={!valid} onClick={() => onOk({ ...c, amount })}>
            OK
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Сума за разпределяне" className="col-span-2">
          <TextInput value={c.amount} inputMode="decimal" onChange={(e) => setC({ ...c, amount: e.target.value })} aria-label="Сума за разпределяне" />
        </Field>
        <Field label="Разпределяне по">
          <Select value={c.base} onChange={(e) => setC({ ...c, base: e.target.value as ExpensesChoice['base'] })}>
            <option value="amount">Стойност</option>
            <option value="quantity">Количество</option>
          </Select>
        </Field>
        <Field label="Върху редовете в">
          <Select value={c.side} onChange={(e) => setC({ ...c, side: e.target.value as ExpensesChoice['side'] })}>
            <option value="debit">Дебит</option>
            <option value="credit">Кредит</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
