import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FilePlus2, Pencil, RefreshCw, Search } from 'lucide-react';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { Button, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useCan, useLookups, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';

interface Row {
  id: number; number: string; accounting_date: string; document_number: string | null; document_date: string | null; document_type: string | null;
  term: string | null; reference: string | null; company: string | null; amount: string; debit_accounts: string | null; credit_accounts: string | null;
  user_name: string | null; is_initial_balance: boolean; source: string;
}

const PAGE = 200;

/** Редакция на контиране (Ctrl+F2): list with period/text filters (spec 02a 7). */
export function Journal() {
  const s = useSession();
  const ws = useWorkspace();
  const can = useCan();
  const lookups = useLookups();
  const [f, setF] = useState({ from: `${s.year.year}-01-01`, to: `${s.year.year}-12-31`, text: '', account: '', documentTypeId: '', initial: '' });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['entries', 'list', applied, page, s.year.id],
    queryFn: () => api.get<{ rows: Row[]; total: number }>(`/entries${qs({ ...applied, limit: PAGE, offset: page * PAGE })}`),
    placeholderData: keepPreviousData,
  });
  const apply = () => {
    setPage(0);
    setApplied(f);
  };
  const edit = (id: number) => ws.open('entry', { key: `entry:${id}`, title: `Контиране ${q.data?.rows.find((r) => r.id === id)?.number ?? ''}`.trim(), params: { id } });
  const total = q.data?.rows.reduce((a, r) => a + Number(r.amount ?? 0), 0) ?? 0;
  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{q.data ? `${q.data.total} контировки` : ''}</span>}>
        <Button variant="primary" icon={<FilePlus2 className="size-3.5" />} onClick={() => ws.open('entry')} disabled={!can('UI_Operations_Accounting')}>
          Ново (F2)
        </Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!sel} onClick={() => sel && edit(sel)}>
          Редакция
        </Button>
        <Button icon={<RefreshCw className="size-3.5" />} onClick={() => q.refetch()}>
          Обнови
        </Button>
      </CommandBar>
      <form
        className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Field label="От дата">
          <TextInput type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="w-36" />
        </Field>
        <Field label="До дата">
          <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" />
        </Field>
        <Field label="Сметка">
          <TextInput value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} className="w-24" />
        </Field>
        <Field label="Тип документ">
          <Select value={f.documentTypeId} onChange={(e) => setF({ ...f, documentTypeId: e.target.value })} className="w-44">
            <option value="">Всички</option>
            {lookups.data?.documentTypes.filter((t) => t.visible).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Вид">
          <Select value={f.initial} onChange={(e) => setF({ ...f, initial: e.target.value })} className="w-36">
            <option value="">Операции</option>
            <option value="1">Начални салда</option>
            <option value="all">Всички</option>
          </Select>
        </Field>
        <Field label="Търсене" className="min-w-48 flex-1">
          <TextInput value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="номер, основание, документ, партньор" />
        </Field>
        <Button type="submit" icon={<Search className="size-3.5" />}>
          Филтриране
        </Button>
      </form>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : !q.data?.rows.length ? (
          <Empty>Няма контировки за избрания период.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Дата</th>
                <th>Документ</th>
                <th>№ док.</th>
                <th>Дата док.</th>
                <th>Партньор</th>
                <th>Основание</th>
                <th>Дебит</th>
                <th>Кредит</th>
                <th className="text-right">Сума</th>
                <th>Потребител</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.id} aria-selected={sel === r.id} onClick={() => setSel(r.id)} onDoubleClick={() => edit(r.id)} className="cursor-default">
                  <td className={cx('font-medium', r.is_initial_balance && 'text-amber-700')}>{r.number || (r.is_initial_balance ? 'Н.С.' : '')}</td>
                  <td>{bgDate(r.accounting_date)}</td>
                  <td>{r.document_type}</td>
                  <td>{r.document_number}</td>
                  <td>{bgDate(r.document_date)}</td>
                  <td className="max-w-56 truncate">{r.company}</td>
                  <td className="max-w-72 truncate" title={r.reference ?? undefined}>
                    {r.term}
                  </td>
                  <td>{r.debit_accounts}</td>
                  <td>{r.credit_accounts}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td>{r.user_name}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={9}>Общо на страницата</td>
                <td className="num">{money(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      {q.data && q.data.total > PAGE && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1">
          <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
            ‹ Предишна
          </Button>
          <span>
            {page + 1} / {Math.ceil(q.data.total / PAGE)}
          </span>
          <Button disabled={(page + 1) * PAGE >= q.data.total} onClick={() => setPage(page + 1)}>
            Следваща ›
          </Button>
        </div>
      )}
    </div>
  );
}
