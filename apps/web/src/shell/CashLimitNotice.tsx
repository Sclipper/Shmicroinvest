import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, X } from 'lucide-react';
import { api } from '../api.ts';
import { Button, Checkbox } from '../components/ui.tsx';
import { useCan, useSession } from '../session.tsx';
import { useWorkspace } from './workspace.tsx';

interface LimitCheck {
  total: string;
  limit: string;
  exceeded: boolean;
  hidden: boolean;
  message: string | null;
}

/**
 * CashAndReceivablesExceededView: after the company opens, a pop-up when
 * cash plus receivables of the active year exceed the legal limit, with
 * "Не показвай повече" (per user) and a link to the report. It is a corner
 * notice, not a modal: the work in the tabs goes on underneath.
 */
export function CashLimitNotice() {
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const allowed = can('UI_Reporting_CashReports_CashAndReceivables');
  const check = useQuery({
    queryKey: ['cashLimit', s.company.name, s.year.id],
    queryFn: () => api.get<LimitCheck>('/reports/cash-and-receivables/limit'),
    enabled: allowed,
    staleTime: Infinity,
    retry: false,
  });
  const [closed, setClosed] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const message = check.data?.message;
  if (!allowed || closed || !message) return null;

  const close = () => {
    setClosed(true);
    if (dontShow) void api.put('/reports/cash-and-receivables/limit', { hidden: true }).catch(() => undefined);
  };
  return (
    <div
      role="alertdialog"
      aria-label="Касова наличност и вземания"
      className="absolute right-3 bottom-3 z-30 w-[26rem] rounded-sm border border-amber-300 bg-amber-50 text-[12px] text-amber-950 shadow-lg print:hidden"
    >
      <div className="flex items-center gap-1.5 border-b border-amber-200 px-2.5 py-1 font-semibold">
        <TriangleAlert className="size-3.5 text-amber-600" />
        <span className="flex-1">Касова наличност и вземания</span>
        <button type="button" className="rounded-sm p-0.5 hover:bg-amber-100" aria-label="Затваряне" onClick={close}>
          <X className="size-3.5" />
        </button>
      </div>
      <div className="px-2.5 py-2">{message}</div>
      <div className="flex items-center gap-2 border-t border-amber-200 px-2.5 py-1.5">
        <Checkbox label="Не показвай повече" checked={dontShow} onChange={setDontShow} />
        <button
          type="button"
          className="ml-auto text-brand-700 underline hover:text-brand-900"
          onClick={() => {
            ws.open('cashAndReceivables');
            close();
          }}
        >
          Касова наличност и вземания
        </button>
        <Button className="h-6 px-3" onClick={close}>
          OK
        </Button>
      </div>
    </div>
  );
}
