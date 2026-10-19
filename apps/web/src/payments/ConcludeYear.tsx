import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { YEAR_END_MESSAGES, isCompanyCategory } from '@shmi/core';
import { api } from '../api.ts';
import { AccountPicker } from '../components/pickers.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Empty, Field, Panel, Select, Spinner } from '../components/ui.tsx';
import { useCan, useSession } from '../session.tsx';
import type { Account } from '../types.ts';

interface FinancialYear { id: number; year: number; isConcluded: boolean; isLocked: boolean }
interface ConcludeInfo {
  yearId: number;
  year: number;
  nextYear: number;
  nextExists: boolean;
  nextLocked: boolean;
  isConcluded: boolean;
  isEuroChangeover: boolean;
  differencesAccountId: number | null;
  canConclude: boolean;
  reason: string | null;
  warning: string;
}

const differencesFilter = (a: Account) => !isCompanyCategory(a.categoryId);

/** "Приключване" tab of Счетоводна година: transfer of the closing balances (spec 01b 6.4, euro changeover 04b 4). */
export function ConcludeYearPanel({ initialYearId }: { initialYearId?: number } = {}) {
  const s = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const years = useQuery({ queryKey: ['years'], queryFn: () => api.get<FinancialYear[]>('/years') });
  const [yearId, setYearId] = useState<number>(initialYearId ?? s.year.id);
  const info = useQuery({ queryKey: ['years', 'conclude-info', yearId], queryFn: () => api.get<ConcludeInfo>(`/years/${yearId}/conclude-info`) });
  const [diffId, setDiffId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const i = info.data;

  const run = async () => {
    if (!i) return;
    if (!(await dialogs.confirm(i.warning, 'Приключване на счетоводна година'))) return;
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>(`/years/${i.yearId}/conclude`, { differencesAccountId: i.isEuroChangeover ? diffId ?? i.differencesAccountId : null });
      await qc.invalidateQueries();
      await dialogs.alert(r.message, 'Приключване на счетоводна година');
    } catch (e) {
      await dialogs.error(e, YEAR_END_MESSAGES.strConcludeFinancialYearFailed);
    } finally {
      setBusy(false);
    }
  };

  if (years.isLoading || info.isLoading) return <Empty><Spinner /></Empty>;
  return (
    <Panel title="Прехвърляне на салда" className="w-[560px] self-start">
      <div className="flex flex-col gap-3 p-3">
        <Field label="Счетоводна година" className="w-48">
          <Select value={yearId} onChange={(e) => setYearId(Number(e.target.value))} aria-label="Счетоводна година">
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.year}
              </option>
            ))}
          </Select>
        </Field>
        {i && (
          <>
            <div className="text-[15px]">
              <span className="font-semibold">{i.year}</span> &gt;&gt; <span className="font-semibold">{i.nextYear}</span>
              {!i.nextExists && <span className="ml-2 text-[12px] text-slate-500">(ще бъде създадена)</span>}
              {i.isConcluded && <span className="ml-2 text-[12px] text-slate-600">Приключена – повторното прехвърляне заменя началните салда.</span>}
            </div>
            <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">{i.warning}</div>
            {i.isEuroChangeover && (
              <Field label="Сметка за обиране на разлики" hint="Разликите от закръгляването при превалутирането BGN → EUR (1.95583) се отнасят по тази сметка.">
                <AccountPicker value={diffId ?? i.differencesAccountId} onChange={(a) => setDiffId(a?.id ?? null)} filter={differencesFilter} className="w-80" />
              </Field>
            )}
            {i.reason && <div className="text-[12.5px] text-red-700">{i.reason}</div>}
            <div>
              <Button variant="primary" icon={<ArrowRightLeft className="size-3.5" />} disabled={busy || !i.canConclude || !can('UI_Edit_ChangeActiveFinancialYear')} title={i.reason ?? undefined} onClick={run}>
                Прехвърляне на салда
              </Button>
              {busy && <Spinner className="ml-2 inline-block" />}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
