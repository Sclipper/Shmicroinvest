import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BookCheck, RefreshCw } from 'lucide-react';
import { SCHEDULE_MESSAGES } from '@shmi/core';
import { api, qs, type Message } from '../../api.ts';
import { bgDate } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Spinner, TextInput } from '../../components/ui.tsx';
import { useCan, useInvalidate, useSession } from '../../session.tsx';
import { useWorkspace } from '../../shell/workspace.tsx';

interface ScheduleRow {
  id: number;
  date: string;
  templateId: number;
  templateName: string;
  isProcessed: boolean;
  accountingId: number | null;
  accountingNumber: number | null;
}

/** График за изпълнение на шаблони (spec 02a 9.3, 07 TemplateSchedulesView). */
export function TemplateSchedules() {
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [f, setF] = useState({ q: '', from: `${s.year.year}-01-01`, to: `${s.year.year}-12-31`, processed: false });
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ['template-schedules', f],
    queryFn: () => api.get<ScheduleRow[]>(`/template-schedules${qs({ q: f.q.trim(), from: f.from, to: f.to, processed: f.processed ? 'all' : undefined })}`),
    placeholderData: keepPreviousData,
  });
  const open = useMemo(() => (list.data ?? []).filter((r) => !r.isProcessed), [list.data]);
  const selected = open.filter((r) => checked.has(r.id));
  const allChecked = open.length > 0 && selected.length === open.length;

  const toggle = (id: number) => setChecked((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const process = async () => {
    if (!selected.length || busy || !(await dialogs.confirm(SCHEDULE_MESSAGES.strProcessTemplateSchedulesPrompt))) return;
    setBusy(true);
    try {
      const r = await api.post<{ processed: number; message: string; warnings: Message[] }>('/template-schedules/process', { ids: selected.map((x) => x.id) });
      setChecked(new Set());
      await invalidate('template-schedules', 'entries', 'reports');
      if (r.warnings.length) await dialogs.messages(r.message || 'Осчетоводяване на графика', r.warnings);
      else await dialogs.alert(r.message);
    } catch (e) {
      await dialogs.error(e, 'Осчетоводяването не е извършено');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={list.data ? <span className="text-[12px] text-slate-500">{selected.length ? `Избрани ${selected.length} от ` : ''}{list.data.length} реда</span> : undefined}>
        <Button variant="primary" icon={<BookCheck className="size-3.5" />} disabled={!selected.length || busy || !can('UI_Operations_TemplateSchedules')} onClick={process}>
          Контиране
        </Button>
        <Button icon={<RefreshCw className="size-3.5" />} onClick={() => list.refetch()}>
          Обнови
        </Button>
      </CommandBar>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-300 bg-slate-50 px-3 py-2">
        <Field label="Шаблон">
          <TextInput className="w-56" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </Field>
        <Field label="От дата">
          <TextInput type="date" className="w-36" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="До дата">
          <TextInput type="date" className="w-36" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Checkbox className="mb-1" label="Показване на осчетоводените" checked={f.processed} onChange={(processed) => setF({ ...f, processed })} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {list.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : !list.data?.length ? (
          <Empty>Няма редове в графика за избрания период. Графикът се генерира от екран „Шаблони“.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-8 text-center">
                  <input type="checkbox" aria-label="Избор на всички" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(open.map((r) => r.id)))} className="accent-brand-500" />
                </th>
                <th className="w-28">Дата</th>
                <th>Шаблон</th>
                <th className="w-48">Статус</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id} aria-selected={checked.has(r.id)} onClick={() => !r.isProcessed && toggle(r.id)} className="cursor-default">
                  <td className="text-center">
                    {!r.isProcessed && <input type="checkbox" aria-label={`Избор ${r.templateName} ${bgDate(r.date)}`} checked={checked.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} className="accent-brand-500" />}
                  </td>
                  <td className="nowrap">{bgDate(r.date)}</td>
                  <td>{r.templateName}</td>
                  <td>
                    {r.isProcessed ? (
                      r.accountingId ? (
                        <button type="button" className="text-brand-700 hover:underline" onClick={(e) => (e.stopPropagation(), ws.open('entry', { key: `entry:${r.accountingId}`, title: `Контиране ${r.accountingNumber ?? ''}`, params: { id: r.accountingId } }))}>
                          Осчетоводен, № {r.accountingNumber}
                        </button>
                      ) : (
                        'Осчетоводен'
                      )
                    ) : (
                      <span className="text-slate-500">Неосчетоводен</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
