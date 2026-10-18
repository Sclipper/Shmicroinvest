import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SCHEDULE_MESSAGES } from '@shmi/core';
import { api, qs } from '../../api.ts';
import { money } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Dialog, Empty, Field, Spinner, TextInput } from '../../components/ui.tsx';
import { useInvalidate } from '../../session.tsx';

/** API line shape (decimal strings with "."), as in the entry POST body. */
export interface TemplateLine {
  accountId: number;
  amount: string;
  companyId?: number | null;
  description?: string | null;
  vatTermId?: number | null;
  currencyAmount?: string | null;
  exchangeRate?: string | null;
  quantity?: string | null;
  price?: string | null;
}

/** Entry data saved as a template ("Запис като шаблон", F5). */
export interface TemplatePayload {
  documentTypeId: number | null;
  documentNumber?: string | null;
  companyId: number | null;
  term: string;
  reference: string | null;
  optionalReference: string | null;
  paragraph: string | null;
  transactionTypeId: number;
  viesId: number | null;
  debits: TemplateLine[];
  credits: TemplateLine[];
}

export interface TemplateRow {
  id: number;
  name: string;
  documentTypeId: number | null;
  documentTypeName: string | null;
  termText: string | null;
  referenceText: string | null;
  companyId: number | null;
  companyName: string | null;
  debitAccounts: string;
  creditAccounts: string;
  amount: string;
  isFast: boolean;
  debitAccountId: number | null;
  creditAccountId: number | null;
  hasSchedule: boolean;
}

/** Template list query (name / account filter). */
export function useTemplates(filter: { q: string; account: string; fast?: boolean }) {
  return useQuery({
    queryKey: ['templates', 'list', filter],
    queryFn: () => api.get<TemplateRow[]>(`/templates${qs({ q: filter.q.trim(), account: filter.account.trim(), fast: filter.fast })}`),
    placeholderData: keepPreviousData,
  });
}

/** Name prompt + partner question, then POST /templates (TemplateEditViewModel / SaveTemplate). */
export function SaveTemplateDialog({ payload, onClose, onSaved }: { payload: TemplatePayload; onClose: () => void; onSaved?: (id: number) => void }) {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    if (!name.trim()) {
      await dialogs.alert(SCHEDULE_MESSAGES.strTemplateNameError);
      return;
    }
    let body: TemplatePayload = payload;
    const hasPartner = !!payload.companyId || [...payload.debits, ...payload.credits].some((l) => l.companyId);
    if (hasPartner && !(await dialogs.confirm(SCHEDULE_MESSAGES.strSaveCompanyWithTemplatePrompt))) {
      const strip = (l: TemplateLine) => ({ ...l, companyId: null });
      body = { ...payload, companyId: null, debits: payload.debits.map(strip), credits: payload.credits.map(strip) };
    }
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>('/templates', { ...body, name: name.trim() });
      await invalidate('templates');
      onSaved?.(r.id);
      onClose();
    } catch (e) {
      await dialogs.error(e, 'Шаблонът не може да бъде записан');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Запис като шаблон"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="primary" onClick={save} disabled={busy}>
            Запис
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <Field label="Име на шаблон">
        <TextInput value={name} maxLength={255} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </Field>
    </Dialog>
  );
}

/** Template picker ("Зареждане на шаблон", Ctrl+T): returns the editor draft for `date`. */
export function LoadTemplateDialog({ date, onPick, onClose }: { date: string; onPick: (serverDraft: Record<string, unknown>) => void; onClose: () => void }) {
  const dialogs = useDialogs();
  const [f, setF] = useState({ q: '', account: '' });
  const [sel, setSel] = useState<number | null>(null);
  const list = useTemplates(f);
  const load = async (id: number | null) => {
    if (!id) return;
    try {
      const d = await api.get<Record<string, unknown>>(`/templates/${id}/draft${qs({ date })}`);
      onPick(d);
      onClose();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <Dialog
      title="Шаблони"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="primary" onClick={() => load(sel)} disabled={!sel}>
            Зареждане
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="mb-2 flex gap-2">
        <Field label="Име" className="flex-1">
          <TextInput value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </Field>
        <Field label="Сметка" className="w-32">
          <TextInput value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />
        </Field>
      </div>
      <div className="h-72 overflow-auto border border-slate-300">
        {list.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : !list.data?.length ? (
          <Empty>Няма шаблони.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Име</th>
                <th>Документ</th>
                <th>Дебит</th>
                <th>Кредит</th>
                <th className="text-right">Сума</th>
                <th>Основание</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id} aria-selected={sel === r.id} onClick={() => setSel(r.id)} onDoubleClick={() => load(r.id)} className="cursor-default">
                  <td className="font-medium">{r.name}</td>
                  <td>{r.documentTypeName}</td>
                  <td>{r.debitAccounts}</td>
                  <td>{r.creditAccounts}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td className="max-w-48 truncate">{r.termText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
