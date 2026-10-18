import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, Copy, FileOutput, FilePlus2, Printer, Save, Trash2, Undo2 } from 'lucide-react';
import { NAME_HEADERS, PAYMENT_DOCUMENT_MESSAGES as M, PAYMENT_DOCUMENT_TYPES_DEF, listColumns, parseAmount, type PaymentDocumentFields, type PaymentDocumentTypeId } from '@shmi/core';
import { api, ApiError, qs } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, ErrorText, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { bgDate, money } from '../format.ts';
import { useLookups, useSession } from '../session.tsx';
import { useWorkspace, type ScreenProps } from '../shell/workspace.tsx';
import { DiaryDialog } from './paymentDocuments/DiaryDialog.tsx';
import { DocumentForm } from './paymentDocuments/DocumentForm.tsx';
import {
  newRow, periodEnd, PERIODS, postForFile, rowFromDto, saveBlob, type DocRow, type PaymentDocumentDto, type PeriodKind, type Suggestions,
} from './paymentDocuments/model.ts';
import { PaymentDocumentPrint, PrintPortal, usePrint } from './paymentDocuments/PrintForms.tsx';

interface Filter {
  period: PeriodKind;
  from: string;
  to: string;
  text: string;
  bankId: number | null;
  all: boolean;
}

const nowNaive = (workingDate: string) => {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${workingDate}T${t}`;
};
const toPayload = (r: DocRow) => ({ id: r.id, ...r.doc });

/**
 * Registry of one payment-document type (DocumentsListViewModel, 02c 1.6):
 * filter bar, grid of the documents, edit form of the selected one, save in
 * batch without a validation gate, copy, soft delete, print, UBB export, diary.
 */
export function PaymentDocuments({ tab, type }: ScreenProps & { type: number }) {
  const s = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const lookups = useLookups();
  const banks = useMemo(() => (lookups.data?.banks ?? []).map((b) => ({ id: b.id, name: b.name, code: b.code })), [lookups.data]);
  const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];

  const monthStart = `${s.workingDate.slice(0, 8)}01`;
  const [filter, setFilter] = useState<Filter>({ period: 'month', from: monthStart, to: periodEnd('month', monthStart), text: '', bankId: null, all: false });
  const [text, setText] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => ({ ...f, text })), 300);
    return () => clearTimeout(t);
  }, [text]);

  const listQuery = useQuery({
    queryKey: ['payment-documents', type, filter],
    queryFn: () => api.get<PaymentDocumentDto[]>(`/payment-documents${qs({
      type,
      from: filter.period === 'all' ? undefined : filter.from,
      to: filter.period === 'all' ? undefined : filter.to,
      text: filter.text,
      bankId: filter.bankId,
      deleted: filter.all,
    })}`),
  });
  const suggestions = useQuery({ queryKey: ['payment-documents', 'suggestions', type], queryFn: () => api.get<Suggestions>(`/payment-documents/suggestions?type=${type}`) });

  const [edited, setEdited] = useState<Map<string, DocRow>>(new Map());
  const [added, setAdded] = useState<DocRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [diaryIds, setDiaryIds] = useState<number[] | null>(null);
  const [printDocs, setPrintDocs] = useState<PaymentDocumentFields[]>([]);
  const { printing, print } = usePrint();

  const rows = useMemo(() => [...(listQuery.data ?? []).map((d) => edited.get(`id-${d.id}`) ?? rowFromDto(d)), ...added], [listQuery.data, edited, added]);
  const current = rows.find((r) => r.key === selected) ?? null;
  const dirty = edited.size > 0 || added.length > 0;
  useEffect(() => {
    if (!selected && rows.length) setSelected(rows[rows.length - 1]!.key);
  }, [rows, selected]);
  useEffect(() => {
    ws.update(tab.key, { dirty });
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const refetch = () => listQuery.refetch();
  const clearLocal = () => {
    setEdited(new Map());
    setAdded([]);
  };

  /* ---------------- commands ---------------- */

  const add = (doc: Partial<PaymentDocumentFields> = {}) => {
    const r = newRow(nowNaive(s.workingDate), doc);
    setAdded((a) => [...a, r]);
    setSelected(r.key);
  };

  const copy = async () => {
    if (!current) return;
    if (current.id === null) return add({ ...current.doc });
    try {
      const draft = await api.post<PaymentDocumentDto>(`/payment-documents/${current.id}/copy`);
      const { id: _i, date: _d, isDeleted: _x, documentType: _t, ...doc } = draft;
      add(doc);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const change = (patch: Partial<PaymentDocumentFields>) => {
    if (!current || current.isDeleted) return;
    const next = { ...current, doc: { ...current.doc, ...patch }, dirty: true };
    if (current.id === null) setAdded((a) => a.map((r) => (r.key === current.key ? next : r)));
    else setEdited((m) => new Map(m).set(current.key, next));
  };

  /** ApplyChanges: every changed, non-deleted document; no validation gate. */
  const save = async (silent = false): Promise<Map<string, string> | null> => {
    const changed = rows.filter((r) => r.dirty && !r.isDeleted);
    if (!changed.length) return new Map();
    setBusy(true);
    try {
      const res = await api.post<{ documents: PaymentDocumentDto[]; message: string }>('/payment-documents/batch', { type, documents: changed.map(toPayload) });
      // Keep the selection and the check marks on the saved copies of new rows.
      const keyMap = new Map(changed.map((r, i) => [r.key, `id-${res.documents[i]!.id}`]));
      setSelected((k) => (k && keyMap.get(k)) ?? k);
      setChecked((c) => new Set([...c].map((k) => keyMap.get(k) ?? k)));
      clearLocal();
      await refetch();
      void suggestions.refetch();
      if (!silent) await dialogs.alert(res.message);
      return keyMap;
    } catch (e) {
      await dialogs.error(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** The checked rows, else the selected one. */
  const targets = () => {
    const list = rows.filter((r) => checked.has(r.key));
    return list.length ? list : current ? [current] : [];
  };

  const doPrint = async (list: DocRow[]) => {
    if (!list.length) return;
    if (list.some((r) => r.isDeleted)) return dialogs.alert(M.strCannotPrintDeletedDocuments);
    const ids = list.map((r) => r.id).filter((x): x is number => x !== null);
    try {
      if (ids.length) await api.post('/payment-documents/print', { ids });
    } catch (e) {
      return dialogs.error(e);
    }
    setPrintDocs(list.map((r) => r.doc));
    print();
  };

  const saveAndPrint = async () => {
    const keys = targets().map((r) => r.key);
    const keyMap = await save(true);
    if (keyMap === null) return;
    const fresh = keyMap.size ? ((await refetch()).data ?? []).map(rowFromDto) : rows;
    const wanted = new Set(keys.map((k) => keyMap.get(k) ?? k));
    await doPrint(fresh.filter((r) => wanted.has(r.key)));
  };

  const remove = async () => {
    const list = targets();
    if (!list.length) return;
    if (!(await dialogs.confirm(M.strDeletePaymentDocumentConfirmation))) return;
    const keys = new Set(list.map((r) => r.key));
    setAdded((a) => a.filter((r) => !keys.has(r.key)));
    const ids = list.filter((r) => r.id !== null && !r.isDeleted).map((r) => r.id!);
    setEdited((m) => {
      const n = new Map(m);
      for (const k of keys) n.delete(k);
      return n;
    });
    setChecked(new Set());
    setSelected(null);
    if (!ids.length) return;
    try {
      await api.post('/payment-documents/delete', { type, ids });
      await refetch();
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const discard = async () => {
    if (!dirty) return;
    if (!(await dialogs.confirm(M.strDiscardChangesConfirmation))) return;
    clearLocal();
    setSelected(null);
  };

  const exportUbb = async () => {
    setExportMenu(false);
    if (dirty) {
      if (!(await dialogs.confirm(M.strSaveChangesConfirmation))) return;
      const keyMap = await save(true);
      if (keyMap === null) return;
      const fresh = ((await refetch()).data ?? []).map(rowFromDto);
      const wanted = new Set([...checked].map((k) => keyMap.get(k) ?? k));
      return runExport(fresh.filter((r) => wanted.has(r.key)));
    }
    return runExport(rows.filter((r) => checked.has(r.key)));
  };

  const runExport = async (list: DocRow[]) => {
    const ids = list.filter((r) => r.id !== null).map((r) => r.id!);
    try {
      const { blob, fileName } = await postForFile('/payment-documents/export', { type, ids, bankId: filter.bankId });
      saveBlob(blob, fileName);
      if (await dialogs.confirm(M.strExecutePaymentDocumentsLogConfirmation)) setDiaryIds(list.filter((r) => !r.isDeleted && r.id !== null).map((r) => r.id!));
    } catch (e) {
      if (e instanceof ApiError && e.messages?.length) await dialogs.messages(M.strExportPaymentDocument, e.messages);
      else await dialogs.error(e);
    }
  };

  const diary = () => {
    const list = rows.filter((r) => checked.has(r.key));
    const src = list.length ? list : rows;
    setDiaryIds(src.filter((r) => r.id !== null && !r.isDeleted).map((r) => r.id!));
  };

  // Ctrl+F2 inside the screen adds a document (the shell binds it to the journal otherwise).
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    if (ws.active !== tab.key) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'F2') {
        e.preventDefault();
        e.stopImmediatePropagation();
        addRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ws.active, tab.key]);

  /* ---------------- view ---------------- */

  const setPeriod = (period: PeriodKind) => setFilter((f) => ({ ...f, period, to: period === 'custom' || period === 'all' ? f.to : periodEnd(period, f.from) }));
  const nameHeader = NAME_HEADERS[def?.nameHeader ?? 'beneficiary'];
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.key));
  const toggle = (key: string, v: boolean) => setChecked((c) => {
    const n = new Set(c);
    if (v) n.add(key);
    else n.delete(key);
    return n;
  });
  const amount = (q: string | null) => (q && parseAmount(q) ? money(parseAmount(q)!.toFixed(2)) : q ?? '');

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="flex items-center gap-2 text-[12px] text-slate-500">{(listQuery.isFetching || busy) && <Spinner className="size-3.5" />}{rows.length} док.{dirty && <span className="text-amber-700">· незаписани промени</span>}</span>}>
        <Button variant="primary" icon={<FilePlus2 className="size-3.5" />} title="Ctrl+F2" onClick={() => add()}>
          Добавяне
        </Button>
        <Button icon={<Copy className="size-3.5" />} disabled={!current} onClick={() => void copy()}>
          Нов документ от избрания
        </Button>
        <Button icon={<Save className="size-3.5" />} disabled={!dirty || busy} onClick={() => void save()}>
          Запис
        </Button>
        <Button icon={<Printer className="size-3.5" />} disabled={!current || busy} onClick={() => void saveAndPrint()}>
          Запис и печат
        </Button>
        <Button icon={<Printer className="size-3.5" />} disabled={!current} onClick={() => void doPrint(targets())}>
          Печат
        </Button>
        <div className="relative">
          <Button icon={<FileOutput className="size-3.5" />} onClick={() => setExportMenu((v) => !v)} aria-haspopup="menu" aria-expanded={exportMenu}>
            Експорт <ChevronDown className="size-3" />
          </Button>
          {exportMenu && (
            <div role="menu" className="absolute top-full left-0 z-20 mt-0.5 min-w-40 rounded-sm border border-slate-300 bg-white py-0.5 shadow-lg" onMouseLeave={() => setExportMenu(false)}>
              <button role="menuitem" className="block w-full px-3 py-1 text-left hover:bg-brand-50" onClick={() => void exportUbb()}>
                към ОББ
              </button>
            </div>
          )}
        </div>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!current && checked.size === 0} onClick={() => void remove()}>
          Изтриване
        </Button>
        <Button icon={<Undo2 className="size-3.5" />} disabled={!dirty} onClick={() => void discard()}>
          Отказ от промените
        </Button>
        <Button icon={<BookOpen className="size-3.5" />} onClick={diary}>
          Дневник
        </Button>
      </CommandBar>

      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <Field label="Период">
          <Select className="w-32" value={filter.period} onChange={(e) => setPeriod(e.target.value as PeriodKind)}>
            {PERIODS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="От дата">
          <TextInput
            type="date"
            className="w-36"
            disabled={filter.period === 'all'}
            value={filter.from}
            onChange={(e) => e.target.value && setFilter((f) => ({ ...f, from: e.target.value, to: f.period === 'custom' ? f.to : periodEnd(f.period, e.target.value) }))}
          />
        </Field>
        <Field label="До дата">
          <TextInput
            type="date"
            className="w-36"
            disabled={filter.period === 'all'}
            value={filter.to}
            onChange={(e) => e.target.value && setFilter((f) => ({ ...f, to: e.target.value, period: 'custom' }))}
          />
        </Field>
        <Field label="Търсене">
          <TextInput className="w-56" value={text} placeholder="име, IBAN, основание" onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="Банка">
          <Select className="w-64" value={filter.bankId ?? ''} onChange={(e) => setFilter((f) => ({ ...f, bankId: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">Всички</option>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.code})
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox className="mb-1.5" label="Покажи всички документи" checked={filter.all} onChange={(v) => setFilter((f) => ({ ...f, all: v }))} />
      </div>

      <div className="h-[34%] min-h-32 shrink-0 overflow-auto border-b border-slate-300">
        {listQuery.isLoading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : listQuery.error ? (
          <div className="p-3">
            <ErrorText error={listQuery.error} />
          </div>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" aria-label="Избери всички" className="size-3.5 accent-brand-500" checked={allChecked} onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())} />
                </th>
                <th className="w-36">Дата</th>
                <th>{nameHeader}</th>
                <th>IBAN</th>
                <th>{type === 1 ? 'Упълномощено лице' : 'Основание / пояснения'}</th>
                <th className="w-32 text-right">Сума</th>
                <th className="w-14">Вал.</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = listColumns(type, r.doc);
                return (
                  <tr key={r.key} aria-selected={r.key === selected} onClick={() => setSelected(r.key)} className={cx('cursor-default', r.isDeleted && 'text-slate-400 line-through')}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Избор" className="size-3.5 accent-brand-500" checked={checked.has(r.key)} onChange={(e) => toggle(r.key, e.target.checked)} />
                    </td>
                    <td>{bgDate(r.date.slice(0, 10))} {r.date.slice(11, 16)}</td>
                    <td className="max-w-64 truncate">{c.name}</td>
                    <td className="font-mono">{c.iban}</td>
                    <td className="max-w-80 truncate">{c.reason}</td>
                    <td className="num">{amount(r.doc.qtty)}</td>
                    <td>{r.doc.currency || 'EUR'}</td>
                    <td className="no-underline">
                      {r.isDeleted ? <span className="rounded-sm bg-red-100 px-1 text-[11px] text-red-700 no-underline">Изтрит</span> : r.dirty ? <span className="text-[11px] text-amber-700">{r.id === null ? 'нов' : 'променен'}</span> : null}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-slate-500">
                    Няма документи за избрания период. Натиснете „Добавяне“ (Ctrl+F2).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
        {current ? (
          <>
            <div className="mb-2 flex items-baseline gap-3">
              <h2 className="text-[14px] font-semibold text-slate-800">{def?.description}</h2>
              <span className="text-[12px] text-slate-500">
                {current.id === null ? 'Нов документ' : `Документ ${current.id}`} · {bgDate(current.date.slice(0, 10))}
                {current.isDeleted && <span className="ml-2 font-semibold text-red-700">Изтрит</span>}
              </span>
            </div>
            <DocumentForm key={current.key} type={type} doc={current.doc} onChange={change} banks={banks} suggestions={suggestions.data} readOnly={current.isDeleted} />
          </>
        ) : (
          <Empty>Изберете документ от списъка или натиснете „Добавяне“.</Empty>
        )}
      </div>

      {diaryIds && <DiaryDialog ids={diaryIds} onClose={() => setDiaryIds(null)} />}
      {printing && (
        <PrintPortal>
          {printDocs.map((d, i) => (
            <PaymentDocumentPrint key={i} type={type} doc={d} />
          ))}
        </PrintPortal>
      )}
    </div>
  );
}
