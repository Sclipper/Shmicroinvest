import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Copy, FileDown, FilePlus2, FileText, Paperclip, Pencil, Printer, RefreshCw, SplitSquareHorizontal, Trash2, Undo2 } from 'lucide-react';
import { ENTRY_FOLLOW_UP_MESSAGES as FM, formatMessage, JOURNAL_EXTRA_MESSAGES as XM } from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, CommandBar, Dialog, Empty, Spinner, cx } from '../components/ui.tsx';
import { useCan, useInvalidate, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import { fromServer } from './EntryEditor.tsx';
import { ExpensesDialog, type ExpensesChoice } from './entry/EntryPanels.tsx';
import { printEntryCards, type EntryCard } from './entry/print.ts';
import { exportProtocol, printProtocol, type PrintData } from './vat/ProtocolDialog.tsx';
import { confirmVoid } from './entry/saveFlow.ts';
import { useShortcuts } from './entry/shortcuts.ts';
import { sum } from '../reports/common.tsx';
import { EntryFilterForm, emptyFilter, filterParams, type EntryFilterValues } from './journal/EntryFilter.tsx';

interface Row {
  id: number; number: string; accounting_date: string; document_number: string | null; document_date: string | null; document_type: string | null;
  term: string | null; reference: string | null; company: string | null; amount: string; debit_accounts: string | null; credit_accounts: string | null;
  user_name: string | null; is_initial_balance: boolean; source: string; attachments: number;
}

const PAGE = 200;
const LIST_COMMANDS = ['NewAccountingFromSelected', 'Print', 'SelectAllItems'] as const;

/** Редакция на контиране (Ctrl+F2): list, AccountingFilter and the list commands (spec 02a 5 and 7). */
export function Journal({ initial = false }: { initial?: boolean; tab?: unknown }) {
  const s = useSession();
  const ws = useWorkspace();
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const shortcuts = useShortcuts();
  const [applied, setApplied] = useState<EntryFilterValues>(emptyFilter(s.year.year, initial ? '1' : ''));
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<number[]>([]);
  const [reversalOf, setReversalOf] = useState<Row | null>(null);
  const [expensesFor, setExpensesFor] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['entries', 'list', applied, page, s.year.id],
    queryFn: () => api.get<{ rows: Row[]; total: number }>(`/entries${qs({ ...filterParams(applied), limit: PAGE, offset: page * PAGE })}`),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rows = q.data?.rows ?? [];
  const one = sel.length === 1 ? rows.find((r) => r.id === sel[0]) : undefined;
  const showAttachments = s.settings.IsAllowAccountingAttachments === 'True' && s.settings.IsShowAccountingAttachmentsInList === 'True';

  const edit = (id: number) => ws.open('entry', { key: `entry:${id}`, title: `Контиране ${rows.find((r) => r.id === id)?.number ?? ''}`.trim(), params: { id } });
  const total = sum(rows, (r) => r.amount);
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE)) : 1;
  const listRef = useRef<HTMLDivElement>(null);
  /** Another page: the selection was of the rows of this one. */
  const goto = (p: number) => {
    setPage(p);
    setSel([]);
  };
  // Another page starts at its top row.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [page, applied]);
  const toggle = (id: number, multi: boolean) => setSel((cur) => (multi ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));

  const voidSelected = async () => {
    try {
      if (!(await confirmVoid(dialogs, sel))) return;
      await api.post('/journal/void', { ids: sel });
      setSel([]);
      await invalidate('entries', 'reports', 'accounts');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  /** ReversalMessageBox: Преглед = open for review, Директен запис = save now, Отказ (5.2). */
  const reverse = async (how: 'preview' | 'direct') => {
    const r = reversalOf!;
    setReversalOf(null);
    try {
      if (how === 'preview') {
        const draft = await api.get<Record<string, unknown>>(`/entries/${r.id}/reversal`);
        ws.open('entry', { title: 'Сторно', params: { draft: fromServer(draft) } });
      } else {
        const saved = await api.post<{ id: number; number: string; warnings: { key: string; text: string; severity: 'warning' }[] }>(`/journal/entries/${r.id}/reversal`);
        await invalidate('entries', 'reports', 'accounts');
        if (saved.warnings?.length) await dialogs.messages(`Контиране ${saved.number} е записано с предупреждения`, saved.warnings);
        else await dialogs.alert(`Сторно записът е записан с номер ${saved.number}.`);
      }
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const copySelected = async () => {
    if (!one) return;
    try {
      const draft = await api.get<Record<string, unknown>>(`/journal/entries/${one.id}/copy`);
      ws.open('entry', { title: XM.strNewAccountingFromSelected, params: { draft: fromServer(draft) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const distribute = async (c: ExpensesChoice) => {
    const id = expensesFor!;
    setExpensesFor(null);
    try {
      const draft = await api.post<Record<string, unknown>>(`/journal/entries/${id}/expenses-draft`, c);
      ws.open('entry', { title: 'Разпределяне на разходи', params: { draft: fromServer(draft) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  /** Печат (Ctrl+P): the entry cards of the selected entries, not the page (05 7.11). */
  const printSelected = async () => {
    const ids = rows.filter((r) => sel.includes(r.id)).map((r) => r.id);
    if (!ids.length) return dialogs.alert(FM.strSelectAccountingToPrint);
    try {
      printEntryCards(await Promise.all(ids.map((id) => api.get<EntryCard>(`/journal/entries/${id}/print`))));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  /** "Печат / Експорт на протокол по ЗДДС" (02a 7): the VAT protocol of the selected entry. */
  const protocol = async (how: 'print' | 'export') => {
    if (!one) return;
    try {
      const d = await api.get<PrintData>(`/journal/entries/${one.id}/protocol`);
      if (how === 'print') printProtocol(d);
      else exportProtocol(d);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cmd = shortcuts.match(e, LIST_COMMANDS);
    if (!cmd || (e.target as HTMLElement).closest('input,select,textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    if (cmd === 'NewAccountingFromSelected') void copySelected();
    else if (cmd === 'Print') void printSelected();
    else if (cmd === 'SelectAllItems') setSel(rows.map((r) => r.id));
  };

  const listError = q.error as Error | null;
  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown} tabIndex={-1}>
      <CommandBar right={<span className="text-[12px] text-slate-500">{q.data ? `${q.data.total} контировки${sel.length > 1 ? `, избрани ${sel.length}` : ''}` : ''}</span>}>
        <Button variant="primary" icon={<FilePlus2 className="size-3.5" />} onClick={() => ws.open('entry', initial ? { title: 'Начално салдо', params: { initial: true } } : undefined)} disabled={!can(initial ? 'UI_Operations_ChartOfAccounts_ChartOfAccountsBalance' : 'UI_Operations_Accounting')}>
          {initial ? 'Ново начално салдо' : 'Ново (F2)'}
        </Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!one} onClick={() => one && edit(one.id)}>
          Редакция
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!sel.length || !can('UI_Edit_Accountings_DeleteAccounting')} onClick={voidSelected}>
          Изтриване
        </Button>
        {!initial && (
          <>
            <Button icon={<Undo2 className="size-3.5" />} disabled={!one || !can('UI_Operations_Accounting')} onClick={() => one && setReversalOf(one)}>
              Сторно
            </Button>
            <Button icon={<Copy className="size-3.5" />} disabled={!one || !can('UI_Operations_Accounting')} onClick={copySelected} title={shortcuts.gesture('NewAccountingFromSelected')}>
              {XM.strNewAccountingFromSelected}
            </Button>
            <Button icon={<SplitSquareHorizontal className="size-3.5" />} disabled={!one || !can('UI_Operations_Accounting')} onClick={() => one && setExpensesFor(one.id)}>
              Разпределяне на допълнителни разходи
            </Button>
          </>
        )}
        <Button icon={<Printer className="size-3.5" />} onClick={printSelected} disabled={!sel.length} title={shortcuts.gesture('Print')}>
          Печат
        </Button>
        {!initial && (
          <>
            <Button icon={<FileText className="size-3.5" />} disabled={!one} onClick={() => protocol('print')}>
              Печат на протокол по ЗДДС
            </Button>
            <Button icon={<FileDown className="size-3.5" />} disabled={!one} onClick={() => protocol('export')}>
              Експорт на протокол по ЗДДС
            </Button>
          </>
        )}
        <Button icon={<RefreshCw className="size-3.5" />} onClick={() => q.refetch()}>
          Обнови
        </Button>
      </CommandBar>
      <EntryFilterForm
        value={applied}
        compact
        onApply={(f) => {
          setPage(0);
          setSel([]);
          setApplied(f);
        }}
      />
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {listError ? (
          <Empty>{listError.message}</Empty>
        ) : q.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : !rows.length ? (
          <Empty>Няма контировки за избрания период.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-7">
                  <input type="checkbox" aria-label="Избор на всички" className="size-3.5" checked={sel.length > 0 && sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((r) => r.id) : [])} />
                </th>
                <th>Номер</th>
                <th>Дата</th>
                <th>Документ</th>
                <th>№ док.</th>
                <th>Дата док.</th>
                <th>Партньор</th>
                <th>Основание</th>
                <th>Забележка</th>
                <th>Дебит</th>
                <th>Кредит</th>
                <th className="text-right">Сума</th>
                {showAttachments && <th title="Прикачени файлове"><Paperclip className="size-3.5" /></th>}
                <th>Потребител</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} aria-selected={sel.includes(r.id)} onClick={(e) => toggle(r.id, e.ctrlKey || e.metaKey)} onDoubleClick={() => edit(r.id)} className="cursor-default">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Избор ${r.number}`} className="size-3.5" checked={sel.includes(r.id)} onChange={() => toggle(r.id, true)} />
                  </td>
                  <td className={cx('font-medium', r.is_initial_balance && 'text-amber-700')}>{r.number || (r.is_initial_balance ? 'Н.С.' : '')}</td>
                  <td>{bgDate(r.accounting_date)}</td>
                  <td>{r.document_type}</td>
                  <td>{r.document_number}</td>
                  <td>{bgDate(r.document_date)}</td>
                  <td className="max-w-56 truncate">{r.company}</td>
                  <td className="max-w-72 truncate">{r.term}</td>
                  <td className="max-w-56 truncate">{r.reference}</td>
                  <td>{r.debit_accounts}</td>
                  <td>{r.credit_accounts}</td>
                  <td className="num">{money(r.amount)}</td>
                  {showAttachments && <td className="text-center">{r.attachments > 0 ? r.attachments : ''}</td>}
                  <td>{r.user_name}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={11}>Общо на страницата</td>
                <td className="num">{money(total)}</td>
                <td colSpan={showAttachments ? 2 : 1} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      {q.data && q.data.total > PAGE && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1" data-testid="journal-pager">
          {q.isFetching && <Spinner className="size-3.5" />}
          <span className="text-[12px] text-slate-500">
            {page * PAGE + 1}–{Math.min((page + 1) * PAGE, q.data.total)} от {q.data.total}
          </span>
          <Button disabled={page === 0} onClick={() => goto(0)} title="Първа страница" aria-label="Първа страница">
            «
          </Button>
          <Button disabled={page === 0} onClick={() => goto(page - 1)}>
            ‹ Предишна
          </Button>
          <span className="flex items-center gap-1">
            <input
              key={page}
              className="field-input num w-14"
              aria-label="Страница"
              defaultValue={page + 1}
              inputMode="numeric"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const n = Number(e.currentTarget.value);
                if (Number.isInteger(n)) goto(Math.min(pages, Math.max(1, n)) - 1);
              }}
            />
            / {pages}
          </span>
          <Button disabled={page + 1 >= pages} onClick={() => goto(page + 1)}>
            Следваща ›
          </Button>
          <Button disabled={page + 1 >= pages} onClick={() => goto(pages - 1)} title="Последна страница" aria-label="Последна страница">
            »
          </Button>
        </div>
      )}
      {reversalOf && (
        <Dialog
          title="Сторно"
          onClose={() => setReversalOf(null)}
          footer={
            <>
              <Button variant="primary" data-autofocus onClick={() => reverse('preview')}>
                Преглед
              </Button>
              <Button onClick={() => reverse('direct')}>Директен запис</Button>
              <Button onClick={() => setReversalOf(null)}>Отказ</Button>
            </>
          }
        >
          {formatMessage(XM.strReversalMessage, reversalOf.number)}
        </Dialog>
      )}
      {expensesFor && <ExpensesDialog onClose={() => setExpensesFor(null)} onOk={distribute} />}
    </div>
  );
}
