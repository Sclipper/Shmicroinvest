import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BookCheck } from 'lucide-react';
import { api, qs, type Message } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, CommandBar, Empty, Field, Spinner, TextInput } from '../components/ui.tsx';
import { money } from '../format.ts';
import { useInvalidate, useSession } from '../session.tsx';
import { MONTH_NAMES } from './common.tsx';

interface RequestRow {
  id: number;
  type: string;
  month: string;
  year: number;
  monthNumber: number;
  amount: string;
  assetId: number;
  inventoryNumber: string;
  name: string;
  debitAccount: string | null;
  creditAccount: string | null;
}
interface Result {
  defaults: { from: string; to: string };
  from: string;
  to: string;
  rows: RequestRow[];
  total: string;
}

/** Заявки за осчетоводяване (Ctrl+Q): pending monthly depreciation, "Контиране" posts the selection (spec 02a 11, 03b 12). */
export function AccountingRequests() {
  const session = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [f, setF] = useState<{ from: string; to: string; inventoryNumber: string; name: string } | null>(null);
  const query = f ? qs(f) : '';
  const list = useQuery({ queryKey: ['accountingRequests', session.year.id, query], queryFn: () => api.get<Result>(`/accounting-requests${query}`), placeholderData: keepPreviousData });
  useEffect(() => {
    if (!f && list.data) setF({ from: list.data.defaults.from, to: list.data.defaults.to, inventoryNumber: '', name: '' });
  }, [f, list.data]);
  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const [selected, setSelected] = useState<Set<number> | null>(null);
  // All rows are selected by default; a refresh keeps only the rows still listed.
  const sel = useMemo(() => (selected ? new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.id)) : new Set(rows.map((r) => r.id))), [rows, selected]);
  const selTotal = rows.filter((r) => sel.has(r.id)).reduce((a, r) => a + Number(r.amount), 0);
  const [posting, setPosting] = useState(false);

  const toggle = (id: number) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  const post = async () => {
    if (!sel.size) return;
    setPosting(true);
    try {
      const r = await api.post<{ posted: { number: string }[]; failed: number[]; skippedOtherYear: number; warnings: Message[] }>('/accounting-requests/post', { ids: [...sel] });
      setSelected(null);
      await invalidate('accountingRequests', 'assets', 'asset', 'assetPreview', 'entries', 'journal', 'reports');
      const lines = [`Създадени контирания: ${r.posted.length}.`];
      if (r.failed.length) lines.push(`Неосчетоводени (заключен или приключен период): ${r.failed.length}.`);
      if (r.warnings.length) await dialogs.messages(lines.join('\n'), r.warnings);
      else await dialogs.alert(lines.join('\n'));
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{list.isFetching && <Spinner className="mr-2 inline-block size-3.5" />}Общо: {money(list.data?.total ?? 0)}; избрани {sel.size} за {money(selTotal)}</span>}>
        <Button variant="primary" icon={<BookCheck className="size-3.5" />} onClick={() => void post()} disabled={!sel.size || posting}>
          Контиране
        </Button>
      </CommandBar>
      {f && (
        <form className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2" onSubmit={(e) => e.preventDefault()}>
          <Field label="От дата"><TextInput type="date" className="w-36" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="До дата"><TextInput type="date" className="w-36" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Инв. №"><TextInput className="w-32" value={f.inventoryNumber} onChange={(e) => setF({ ...f, inventoryNumber: e.target.value })} /></Field>
          <Field label="Име"><TextInput className="w-56" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {list.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : rows.length === 0 ? (
          <Empty>Няма заявки за осчетоводяване за избрания период.</Empty>
        ) : (
          <table className="grid-table" aria-label="Заявки за осчетоводяване">
            <thead>
              <tr>
                <th className="w-6"><input type="checkbox" aria-label="Избор на всички" checked={sel.size === rows.length} onChange={(e) => setSelected(e.target.checked ? null : new Set())} /></th>
                <th>Тип</th>
                <th>Инв. №</th>
                <th>Наименование</th>
                <th>Месец</th>
                <th>Година</th>
                <th>Дебит</th>
                <th>Кредит</th>
                <th className="text-right">Ст-ст</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} aria-selected={sel.has(r.id)} onClick={() => toggle(r.id)} className="cursor-default">
                  <td><input type="checkbox" aria-label={`Избор ${r.inventoryNumber} ${r.month}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td>Амортизация</td>
                  <td>{r.inventoryNumber}</td>
                  <td className="max-w-80 truncate" title={r.name}>{r.name}</td>
                  <td>{MONTH_NAMES[r.monthNumber - 1]}</td>
                  <td className={r.year !== session.year.year ? 'text-amber-700' : ''}>{r.year}</td>
                  <td>{r.debitAccount}</td>
                  <td>{r.creditAccount}</td>
                  <td className="num">{money(r.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={8}>Общо:</td><td className="num">{money(list.data?.total ?? 0)}</td></tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
