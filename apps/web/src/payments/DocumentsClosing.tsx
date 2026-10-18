import { Fragment, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Save, Search } from 'lucide-react';
import { CLOSING_MODES, type ClosingMode } from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { PartnerPicker } from '../components/pickers.tsx';
import { Button, CommandBar, Empty, Field, Select, Spinner, TextInput } from '../components/ui.tsx';
import { useInvalidate, useSession } from '../session.tsx';
import { sum } from './PaymentsShared.tsx';

interface ClosingRow {
  accountingId: number; accountingNumber: string; operation: string; documentDate: string; accountingDate: string;
  documentType: string; documentNumber: string; optionalReference: string; accountNumber: string; companyName: string; amount: string; currencyAmount: string;
}
interface Proposal { liability: ClosingRow; payment: ClosingRow; amount: string; currencyAmount: string }

const pairKey = (p: Proposal) => `${p.liability.accountingId}:${p.payment.accountingId}`;

/** Закриване на документи (Ctrl+C, spec 02a 10): pairs open liabilities with payments. */
export function DocumentsClosing() {
  const s = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [f, setF] = useState({ companyId: null as number | null, companyName: '', to: `${s.year.year}-12-31`, account: '', number: '', mode: 'amount' as ClosingMode });
  const [applied, setApplied] = useState<typeof f | null>(null);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const q = useQuery({
    queryKey: ['payments', 'closing', applied, s.year.id],
    queryFn: () => api.get<{ pairs: Proposal[] }>(`/documents-closing${qs({ mode: applied!.mode, companyId: applied!.companyId, to: applied!.to, account: applied!.account, number: applied!.number })}`),
    enabled: !!applied,
  });
  const pairs = q.data?.pairs ?? [];
  const isChecked = (p: Proposal) => (checked ? checked.has(pairKey(p)) : true);
  const chosen = pairs.filter(isChecked);
  const save = useMutation({
    mutationFn: () => api.post<{ links: unknown[] }>('/documents-closing', {
      endDate: applied?.to, pairs: chosen.map((p) => ({ liabilityAccountingId: p.liability.accountingId, paymentAccountingId: p.payment.accountingId })),
    }),
    onSuccess: async () => {
      setChecked(null);
      await invalidate('payments', 'reports');
      await dialogs.alert('Документите са закрити успешно.');
    },
    onError: (e) => dialogs.error(e, 'Закриване на документи'),
  });
  const mode = CLOSING_MODES.find((m) => m.id === f.mode);
  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{applied ? `${pairs.length} двойки` : ''}</span>}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!chosen.length || save.isPending} onClick={() => save.mutate()}>
          Запис
        </Button>
      </CommandBar>
      <form
        className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          setChecked(null);
          setApplied({ ...f });
        }}
      >
        <Field label="Фирма" className="w-64">
          <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} />
        </Field>
        <Field label="До дата">
          <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" />
        </Field>
        <Field label="Номер на сметка">
          <TextInput value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} className="w-28" />
        </Field>
        <Field label="№ на документ">
          <TextInput value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} className="w-28" />
        </Field>
        <Field label="Начин на търсене" className="w-80">
          <Select aria-label="Начин на търсене" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as ClosingMode })}>
            {CLOSING_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" icon={<Search className="size-3.5" />}>
          Филтриране
        </Button>
        {mode && <p className="basis-full text-[12px] text-slate-500">{mode.text}</p>}
      </form>
      <div className="min-h-0 flex-1 overflow-auto">
        {!applied ? (
          <Empty>Изберете условия и натиснете „Филтриране“.</Empty>
        ) : q.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : !pairs.length ? (
          <Empty>Няма документи за закриване.</Empty>
        ) : (
          <table className="grid-table" data-testid="closing-grid">
            <thead>
              <tr>
                <th className="w-6">
                  <input type="checkbox" aria-label="Всички" className="size-3.5 accent-brand-500" checked={chosen.length === pairs.length} onChange={(e) => setChecked(e.target.checked ? null : new Set())} />
                </th>
                <th>Операция</th>
                <th>Номер на контиране</th>
                <th>Дата на документ</th>
                <th>Тип документи</th>
                <th>Документ №</th>
                <th>Фирма</th>
                <th>Сметка</th>
                <th className="text-right">Ст-ст</th>
                <th className="text-right">За закриване</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => {
                const k = pairKey(p);
                const toggle = (on: boolean) => {
                  const next = new Set(checked ?? pairs.map(pairKey));
                  if (on) next.add(k);
                  else next.delete(k);
                  setChecked(next);
                };
                return (
                  <Fragment key={k}>
                    {[p.liability, p.payment].map((r, i) => (
                      <tr key={i} className={i === 1 ? 'border-b-2 border-slate-300' : undefined} data-doc={r.documentNumber}>
                        {i === 0 && (
                          <td rowSpan={2} className="align-middle">
                            <input type="checkbox" aria-label={`Двойка ${p.liability.documentNumber}`} className="size-3.5 accent-brand-500" checked={isChecked(p)} onChange={(e) => toggle(e.target.checked)} />
                          </td>
                        )}
                        <td>{r.operation}</td>
                        <td>{r.accountingNumber}</td>
                        <td>{bgDate(r.documentDate)}</td>
                        <td>{r.documentType}</td>
                        <td className="font-medium">{r.documentNumber}</td>
                        <td className="max-w-56 truncate">{r.companyName}</td>
                        <td>{r.accountNumber}</td>
                        <td className="num">{money(r.amount)}</td>
                        {i === 0 && (
                          <td rowSpan={2} className="num align-middle font-medium">
                            {money(p.amount)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={9}>Общо за закриване ({chosen.length})</td>
                <td className="num">{money(sum(chosen.map((p) => p.amount)))}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
