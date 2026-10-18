import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { isCompanyCategory, parseAmount } from '@shmi/core';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { AccountPicker, PartnerPicker } from '../../components/pickers.tsx';
import { Button, CommandBar, Empty, Field, Panel, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useAccounts, useInvalidate, useLookups, useSession } from '../../session.tsx';

interface CorrRow {
  id: number; date: string; document_type: string | null; document_number: string | null;
  debit_account: string; debit_company: string | null; credit_account: string; credit_company: string | null; amount: string;
}
interface AccountTotal { account: string; description: string; debit: string; credit: string; partners: { name: string; debit: string; credit: string }[] }

interface Form {
  debitAccountId: number | null;
  debitCompanyId: number | null;
  debitCompanyName: string | null;
  creditAccountId: number | null;
  creditCompanyId: number | null;
  creditCompanyName: string | null;
  amount: string;
  documentTypeId: number | null;
  documentNumber: string;
  documentDate: string;
}

const blank = (): Form => ({ debitAccountId: null, debitCompanyId: null, debitCompanyName: null, creditAccountId: null, creditCompanyId: null, creditCompanyName: null, amount: '', documentTypeId: null, documentNumber: '', documentDate: '' });

/** Начални кореспонденции (Alt+Y, spec 01b 7 / 06 views): opening balances entered as account pairs. */
export function InitialCorrespondences() {
  const s = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const accounts = useAccounts();
  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const q = useQuery({ queryKey: ['entries', 'initial-correspondences', s.year.id], queryFn: () => api.get<{ date: string; rows: CorrRow[]; accounts: AccountTotal[] }>('/initial-correspondences') });
  const [date, setDate] = useState(s.year.startDate);
  const [f, setF] = useState<Form | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<Form>) => setF((x) => (x ? { ...x, ...p } : x));
  const partnerAccount = (id: number | null) => !!id && isCompanyCategory(byId.get(id)?.categoryId);

  const save = async () => {
    if (!f) return;
    setSaving(true);
    try {
      await api.post('/initial-correspondences', {
        date, debitAccountId: f.debitAccountId, creditAccountId: f.creditAccountId, amount: parseAmount(f.amount)?.toString() ?? '0',
        debitCompanyId: partnerAccount(f.debitAccountId) ? f.debitCompanyId : null, creditCompanyId: partnerAccount(f.creditAccountId) ? f.creditCompanyId : null,
        documentTypeId: f.documentTypeId, documentNumber: f.documentNumber || null, documentDate: f.documentDate || null,
      });
      await invalidate('entries', 'reports');
      setF(blank());
    } catch (e) {
      await dialogs.error(e, 'Начални кореспонденции');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!sel || !(await dialogs.confirm('Желаете ли да изтриете избраната кореспонденция?'))) return;
    try {
      await api.del(`/initial-correspondences/${sel}`);
      setSel(null);
      await invalidate('entries', 'reports');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setF(blank())}>
          Нова кореспонденция
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!sel} onClick={remove}>
          Изтриване
        </Button>
        <Field label="Към дата" className="ml-4 flex-row items-center gap-2">
          <TextInput type="date" value={date} min={`${s.year.year}-01-01`} max={`${s.year.year}-12-31`} onChange={(e) => setDate(e.target.value)} className="w-36" aria-label="Към дата" />
        </Field>
      </CommandBar>
      {f && (
        <div className="grid grid-cols-12 items-end gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <Field label="Дебит сметка" className="col-span-2">
            <AccountPicker value={f.debitAccountId} onChange={(a) => set({ debitAccountId: a?.id ?? null })} />
          </Field>
          <Field label="Партньор (Дт)" className="col-span-2">
            {partnerAccount(f.debitAccountId) ? <PartnerPicker value={f.debitCompanyId} valueName={f.debitCompanyName} onChange={(p) => set({ debitCompanyId: p?.id ?? null, debitCompanyName: p?.name ?? null })} /> : <TextInput disabled />}
          </Field>
          <Field label="Кредит сметка" className="col-span-2">
            <AccountPicker value={f.creditAccountId} onChange={(a) => set({ creditAccountId: a?.id ?? null })} />
          </Field>
          <Field label="Партньор (Кт)" className="col-span-2">
            {partnerAccount(f.creditAccountId) ? <PartnerPicker value={f.creditCompanyId} valueName={f.creditCompanyName} onChange={(p) => set({ creditCompanyId: p?.id ?? null, creditCompanyName: p?.name ?? null })} /> : <TextInput disabled />}
          </Field>
          <Field label="Сума" className="col-span-1">
            <TextInput className="num" value={f.amount} inputMode="decimal" onChange={(e) => set({ amount: e.target.value })} aria-label="Сума" />
          </Field>
          <Field label="Тип документ" className="col-span-1">
            <Select value={f.documentTypeId ?? ''} onChange={(e) => set({ documentTypeId: e.target.value ? Number(e.target.value) : null })} aria-label="Тип документ">
              <option value="" />
              {lookups.data?.documentTypes.filter((t) => t.isVisible).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shortName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="№ документ" className="col-span-1">
            <TextInput value={f.documentNumber} onChange={(e) => set({ documentNumber: e.target.value })} aria-label="№ документ" />
          </Field>
          <div className="col-span-1 flex gap-1">
            <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={saving || !f.debitAccountId || !f.creditAccountId}>
              Запис
            </Button>
          </div>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden bg-slate-50 p-3">
        <Panel title="Кореспонденции" className="min-h-0 overflow-auto">
          {q.isLoading ? (
            <Empty>
              <Spinner />
            </Empty>
          ) : !q.data?.rows.length ? (
            <Empty>Няма въведени начални кореспонденции.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Дебит</th>
                  <th>Кредит</th>
                  <th>Документ</th>
                  <th className="text-right">Сума</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.id} aria-selected={sel === r.id} onClick={() => setSel(r.id)}>
                    <td>{bgDate(r.date)}</td>
                    <td>
                      {r.debit_account}
                      {r.debit_company ? ` · ${r.debit_company}` : ''}
                    </td>
                    <td>
                      {r.credit_account}
                      {r.credit_company ? ` · ${r.credit_company}` : ''}
                    </td>
                    <td>{[r.document_type, r.document_number].filter(Boolean).join(' ')}</td>
                    <td className="num">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Салда по сметки" className="min-h-0 overflow-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Сметка</th>
                <th>Описание</th>
                <th className="text-right">Дебит</th>
                <th className="text-right">Кредит</th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.accounts ?? []).map((a) => (
                <Fragment key={a.account}>
                  <tr className="font-medium">
                    <td>{a.account}</td>
                    <td>{a.description}</td>
                    <td className="num">{money(a.debit)}</td>
                    <td className="num">{money(a.credit)}</td>
                  </tr>
                  {a.partners.map((p) => (
                    <tr key={`${a.account}-${p.name}`} className="text-slate-600">
                      <td />
                      <td className="pl-6">{p.name}</td>
                      <td className="num">{money(p.debit)}</td>
                      <td className="num">{money(p.credit)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
