import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Link2, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { bankRecalc, bankRowDifference, bankTotals, isCompanyCategory, msg } from '@shmi/core';
import { api, ApiError, qs, type Message } from '../../api.ts';
import { AccountPicker, PartnerPicker } from '../../components/pickers.tsx';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Select, TextInput, cx } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { BindingDocumentsDialog } from '../../payments/PaymentsShared.tsx';
import { useAccounts, useInvalidate, useSession } from '../../session.tsx';
import { FileInput, MessageList, errorMessages, upload } from './common.tsx';

interface OwnAccount { id: number; account: string; bankId: number | null; accountId: number | null; bankName: string | null; accountNumber: string | null; currencyIso: string | null }
interface BankProp { name: string; caption: string; kind: string }
interface Bank { id: number; name: string; code: string; properties: BankProp[] }
interface Doc { accountingId: number; documentNumber: string; amount: string; isInvoice: boolean; selected: boolean; bindAmount?: string | null }
interface Row {
  index: number; date: string; isInflow: boolean; amount: string; baseAmount?: string; partnerIban: string; partnerName: string; reason: string; reference: string; props: Record<string, string>;
  templateId: number | null; templateName: string; debitAccountId: number | null; creditAccountId: number | null; companyId: number | null; companyName: string;
  term: string; docReference: string; postAmount: string; currencyAmount: string | null; exchangeRate: string | null; isOwnAccounts: boolean; warnings: string[]; documents: Doc[];
  rowKeys: string[]; duplicate: boolean; ibanCompanyId: number | null; ibanExcluded: boolean;
  feeAmount?: string; feeCurrencyAmount?: string;
}
interface Parsed {
  header: string; format: string; currency: string | null; from: string | null; to: string | null; openingBalance: string | null; closingBalance: string | null; lastAccountingDate: string | null;
  isForeignCurrency: boolean; bindingEnabled: boolean; templates: { id: number; name: string; priority: number }[]; rows: Row[];
}
interface Keyword { id: number; word: string }
const warningText = (k: string) => {
  try {
    return msg(k as Parameters<typeof msg>[0]);
  } catch {
    return k;
  }
};
type RowState = { status: 'posted' | 'skipped' | 'error'; messages: Message[] };
const PAGE_SIZES = [50, 100, 200, 300];

const useOwnAccounts = () => useQuery({ queryKey: ['bank', 'accounts'], queryFn: () => api.get<OwnAccount[]>('/bank-statements/accounts') });
const useBanks = () => useQuery({ queryKey: ['bank', 'banks'], queryFn: () => api.get<Bank[]>('/bank-statements/banks') });

/** "Ключови полета": invoice-number keywords, added and removed as chips; saved at once (04b 1.8, 03a 8.2). */
function KeywordChips() {
  const dialogs = useDialogs();
  const q = useQuery({ queryKey: ['bank', 'keywords'], queryFn: () => api.get<Keyword[]>('/bank-statements/keywords') });
  const [word, setWord] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const add = () => {
    const w = word.trim();
    setWord('');
    if (w) void act(() => api.post('/bank-statements/keywords', { word: w }));
  };
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 px-3 py-1 text-[12px]" data-testid="bank-keywords">
      <span className="mr-1 text-slate-600">Ключови полета:</span>
      {q.data?.map((k) => (
        <span key={k.id} className="inline-flex items-center gap-0.5 rounded-sm border border-slate-300 bg-slate-50 px-1.5" data-testid="keyword-chip">
          {k.word}
          <button className="text-slate-500 hover:text-red-700" title="Изтриване" aria-label={`Изтриване на ${k.word}`} onClick={() => act(() => api.del(`/bank-statements/keywords/${k.id}`))}><X className="size-3" /></button>
        </span>
      ))}
      <TextInput value={word} maxLength={255} onChange={(e) => setWord(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="h-6 w-32" placeholder="нова дума" aria-label="Нова ключова дума" />
      <Button onClick={add} disabled={!word.trim()}>Добави</Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Import wizard and preview (04b 1.4-1.10)                            */
/* ------------------------------------------------------------------ */

export function BankImport() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const session = useSession();
  const accounts = useAccounts();
  const own = useOwnAccounts();
  const banks = useBanks();
  const bindingSetting = session.settings.IsBindingDocumentsInBankImportEnabled !== 'False';
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [termProperty, setTermProperty] = useState('');
  const [referenceProperty, setReferenceProperty] = useState('');
  const [mergeCriteria, setMerge] = useState<'none' | 'all' | 'date' | 'month'>('none');
  const [autoBind, setAutoBind] = useState(true);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<Record<number, RowState>>({});
  const [customNumber, setCustomNumber] = useState('');
  const [ownTransfer, setOwnTransfer] = useState(true);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [binding, setBinding] = useState<Row | null>(null);
  useEffect(() => {
    if (own.data?.length && bankAccountId == null) setBankAccountId(own.data[0]!.id);
  }, [own.data, bankAccountId]);
  const acct = own.data?.find((a) => a.id === bankAccountId);
  const props = banks.data?.find((b) => b.id === acct?.bankId)?.properties.filter((p) => p.kind === 'text') ?? [];
  const categoryOf = (id: number | null) => (id ? accounts.data?.find((a) => a.id === id)?.categoryId ?? null : null);
  const partnerAccountOf = (r: Row) => [r.debitAccountId, r.creditAccountId].find((id) => id && isCompanyCategory(categoryOf(id))) ?? null;

  const parse = async () => {
    if (!file || !bankAccountId) return;
    setBusy(true);
    setMsgs([]);
    try {
      const r = await upload<Parsed>('/bank-statements/parse', file, { bankAccountId, termProperty: termProperty || undefined, referenceProperty: referenceProperty || undefined, mergeCriteria, autoBind: bindingSetting && autoBind });
      setParsed(r);
      setRows(r.rows);
      setState({});
      setPage(1);
    } catch (e) {
      setMsgs(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  const setRow = (index: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  // Apply and the footer totals work on the current page only (1.8); posted rows stay greyed out.
  const visible = useMemo(() => rows.slice((current - 1) * pageSize, current * pageSize), [rows, current, pageSize]);
  const pageRows = visible.filter((r) => state[r.index]?.status !== 'posted');
  const totals = bankTotals(pageRows);

  const post = async (force = false): Promise<void> => {
    if (!pageRows.length) return;
    setBusy(true);
    setMsgs([]);
    try {
      const r = await api.post<{ results: ({ index: number } & RowState)[]; posted: number }>('/bank-statements/post', {
        bankAccountId, customDocumentNumber: customNumber.trim() || undefined, ownAccountsTransfer: ownTransfer, force,
        rows: pageRows.map((x) => ({
          index: x.index, date: x.date, debitAccountId: x.debitAccountId, creditAccountId: x.creditAccountId, companyId: x.companyId, companyName: x.companyName,
          term: x.term, reference: x.docReference, postAmount: x.postAmount, currencyAmount: x.currencyAmount, exchangeRate: x.exchangeRate, templateId: x.templateId,
          feeAmount: x.feeAmount || null, feeCurrencyAmount: x.feeCurrencyAmount || null, rowKeys: x.rowKeys,
          isOwnAccounts: x.isOwnAccounts, documents: x.documents.filter((d) => d.selected).map((d) => ({ accountingId: d.accountingId, amount: d.bindAmount ?? null })),
        })),
      });
      setState((st) => ({ ...st, ...Object.fromEntries(r.results.map((x) => [x.index, { status: x.status, messages: x.messages }])) }));
      await invalidate('entries', 'reports');
      const errors = r.results.filter((x) => x.status === 'error').length;
      await dialogs.alert(`Записани контирания: ${r.posted}.${errors ? ` Редове с грешки: ${errors}.` : ''}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !force) {
        setBusy(false);
        if (await dialogs.messages('Предупреждение', e.messages ?? [], true)) return post(true);
        return;
      }
      setMsgs(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };

  /** strBindIbanToPartnerConfirm: asked before the IBAN is added to the partner (1.7). */
  const bindIban = async (r: Pick<Row, 'partnerIban' | 'index'>, companyId: number, companyName: string) => {
    if (!r.partnerIban) return;
    if (!(await dialogs.confirm(msg('strBindIbanToPartnerConfirm', r.partnerIban, companyName)))) return;
    try {
      const x = await api.post<{ message: string }>('/bank-statements/bind-iban', { companyId, iban: r.partnerIban });
      setRows((rs) => rs.map((y) => (y.partnerIban === r.partnerIban ? { ...y, ibanCompanyId: companyId } : y)));
      await dialogs.alert(x.message);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const pickPartner = async (r: Row, p: { id: number; name: string } | null) => {
    setRow(r.index, { companyId: p?.id ?? null, companyName: p?.name ?? '', documents: [] });
    if (p && r.partnerIban && !r.ibanExcluded && r.ibanCompanyId !== p.id) await bindIban(r, p.id, p.name);
  };

  /** MapStatementToAccountingWithTemplate: re-maps the row with the chosen rule. */
  const applyTemplate = async (r: Row, templateId: number | null) => {
    try {
      const raw = { index: r.index, date: r.date, isInflow: r.isInflow, amount: r.amount, baseAmount: r.baseAmount, partnerIban: r.partnerIban, partnerName: r.partnerName, reason: r.reason, reference: r.reference, props: r.props };
      const x = await api.post<Row>('/bank-statements/apply-template', { bankAccountId, templateId, row: raw, termProperty: termProperty || undefined, referenceProperty: referenceProperty || undefined, autoBind: bindingSetting && autoBind });
      setRows((rs) => rs.map((y) => (y.index === r.index ? { ...x, rowKeys: y.rowKeys, duplicate: y.duplicate } : y)));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  // Recompute rules (1.10): currency or rate -> base; base -> rate.
  const editCurrency = (r: Row, v: string) => setRow(r.index, { currencyAmount: v, postAmount: r.exchangeRate && v ? bankRecalc.base(v, r.exchangeRate) : r.postAmount });
  const editRate = (r: Row, v: string) => setRow(r.index, { exchangeRate: v, postAmount: r.currencyAmount && v ? bankRecalc.base(r.currencyAmount, v) : r.postAmount });
  // A typed base amount keeps the rate (the difference is a currency difference); without a rate it gives the rate.
  const editBase = (r: Row, v: string) => setRow(r.index, { postAmount: v, exchangeRate: parsed?.isForeignCurrency && !Number(r.exchangeRate) && r.currencyAmount && v ? bankRecalc.rate(v, r.currencyAmount) : r.exchangeRate });
  const num = (v: string) => v.replace(',', '.');

  if (!parsed) {
    return (
      <div className="h-full overflow-auto p-3" data-testid="bank-import">
        <Panel title="Импорт на банкови извлечения" className="max-w-[760px]">
          <div className="flex flex-col gap-3 p-3">
            {own.data && !own.data.length && <div className="text-amber-700">Няма въведени банкови сметки в „Моята фирма“.</div>}
            <Field label="Банкова сметка">
              <Select value={bankAccountId ?? ''} onChange={(e) => setBankAccountId(Number(e.target.value))} data-testid="bank-account">
                {own.data?.map((a) => <option key={a.id} value={a.id}>{a.account} - {a.bankName ?? 'неизвестна банка'} ({a.accountNumber ?? 'без сметка'}{a.currencyIso ? `, ${a.currencyIso}` : ''})</option>)}
              </Select>
            </Field>
            <Field label="Файл с извлечението (MT940, camt.053, XML на банката, CSV, XLSX)"><FileInput file={file} onChange={setFile} accept=".sta,.mt940,.txt,.xml,.csv,.xlsx" testId="bank-file" /></Field>
            <div className="flex flex-wrap gap-3">
              <Field label="Основание от">
                <Select value={termProperty} onChange={(e) => setTermProperty(e.target.value)} className="w-56">
                  <option value="">По подразбиране</option>
                  {props.map((p) => <option key={p.name} value={p.name}>{p.caption}</option>)}
                </Select>
              </Field>
              <Field label="Забележка от">
                <Select value={referenceProperty} onChange={(e) => setReferenceProperty(e.target.value)} className="w-56">
                  <option value="">Без</option>
                  {props.map((p) => <option key={p.name} value={p.name}>{p.caption}</option>)}
                </Select>
              </Field>
              <Field label="Обединяване на редове">
                <Select value={mergeCriteria} onChange={(e) => setMerge(e.target.value as typeof mergeCriteria)} className="w-48">
                  <option value="none">Без обединяване</option>
                  <option value="all">Всички</option>
                  <option value="date">По дата</option>
                  <option value="month">По месец</option>
                </Select>
              </Field>
            </div>
            {bindingSetting && <Checkbox label="Автоматично свързване с документи" checked={autoBind} onChange={setAutoBind} />}
            <MessageList messages={msgs} />
            <div className="flex justify-end"><Button variant="primary" disabled={!file || !bankAccountId || busy} onClick={parse}>Напред</Button></div>
          </div>
        </Panel>
      </div>
    );
  }

  const foreign = parsed.isForeignCurrency;
  const showDocs = parsed.bindingEnabled;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bank-preview">
      <CommandBar right={<span className="text-[12px] text-slate-600">{parsed.format}{parsed.lastAccountingDate ? ` · последно контиране по сметката ${bgDate(parsed.lastAccountingDate)}` : ''}</span>}>
        <Button onClick={() => { setParsed(null); setRows([]); }}>Назад</Button>
        <Field label={msg('strCustomDocumentNumber')} className="ml-2 flex-row items-center gap-2"><TextInput value={customNumber} onChange={(e) => setCustomNumber(e.target.value)} className="w-32" placeholder="месецът" /></Field>
        <Checkbox label="Контиране на преводи между собствени сметки" checked={ownTransfer} onChange={setOwnTransfer} />
        <Button variant="primary" disabled={busy || !pageRows.length} onClick={() => post()}>Запис</Button>
      </CommandBar>
      <div className="flex flex-wrap items-center gap-x-4 border-b border-slate-200 px-3 py-1.5 text-[13px]">
        <span>{parsed.header}</span>
        {(parsed.openingBalance || parsed.closingBalance) && (
          <span className="text-slate-700" data-testid="bank-balances">
            Начално салдо: <b className="tabular-nums">{money(parsed.openingBalance ?? '0')}</b> · Крайно салдо: <b className="tabular-nums">{money(parsed.closingBalance ?? '0')}</b>{parsed.currency ? ` ${parsed.currency}` : ''}
          </span>
        )}
      </div>
      <KeywordChips />
      <MessageList messages={msgs} />
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead>
            <tr>
              <th>№</th><th>Дата</th><th className="text-right">Сума</th>
              {foreign && <><th className="text-right">Сума {parsed.currency}</th><th className="text-right">Курс</th><th className="text-right">Разлика</th></>}
              <th className="text-right">Такса</th>
              <th>Контрагент / IBAN</th><th>Шаблон</th><th className="w-44">Дебит</th><th className="w-44">Кредит</th><th className="w-52">Партньор</th><th className="w-64">Основание</th>
              {showDocs && <th>Документи</th>}<th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const st = state[r.index];
              const diff = bankRowDifference(r);
              const partnerAcc = partnerAccountOf(r);
              return (
                <tr key={r.index} className={cx(st?.status === 'posted' && 'opacity-60', r.duplicate && !st && 'bg-amber-50')} data-testid="bank-row">
                  <td>{r.index + 1}</td>
                  <td>{bgDate(r.date)}</td>
                  <td className={cx('text-right', r.isInflow ? 'text-emerald-700' : 'text-red-700')}>
                    <span className="mr-0.5">{r.isInflow ? '' : '-'}</span>
                    <TextInput value={r.postAmount} onChange={(e) => editBase(r, num(e.target.value))} className="w-24 text-right tabular-nums" aria-label="Сума" />
                  </td>
                  {foreign && (
                    <>
                      <td><TextInput value={r.currencyAmount ?? ''} onChange={(e) => editCurrency(r, num(e.target.value))} className="w-24 text-right tabular-nums" aria-label="Валутна сума" /></td>
                      <td><TextInput value={r.exchangeRate ?? ''} onChange={(e) => editRate(r, num(e.target.value))} className="w-20 text-right tabular-nums" aria-label="Курс" /></td>
                      <td className={cx('text-right tabular-nums', Number(diff) !== 0 && 'text-amber-700')} data-testid="row-difference">{Number(diff) !== 0 ? money(diff) : ''}</td>
                    </>
                  )}
                  <td>
                    {foreign
                      ? <TextInput value={r.feeCurrencyAmount ?? ''} onChange={(e) => setRow(r.index, { feeCurrencyAmount: num(e.target.value) })} className="w-16 text-right tabular-nums" aria-label="Такса" title={`Банкова такса в ${parsed.currency ?? 'валута'}`} />
                      : <TextInput value={r.feeAmount ?? ''} onChange={(e) => setRow(r.index, { feeAmount: num(e.target.value) })} className="w-16 text-right tabular-nums" aria-label="Такса" title="Банкова такса" />}
                  </td>
                  <td className="max-w-56 truncate" title={`${r.partnerName}\n${r.partnerIban}\n${r.reason}`}>
                    <div>{r.partnerName || <span className="text-slate-500">{r.reason}</span>}</div>
                    <div className="text-[11px] text-slate-500">
                      {r.partnerIban}
                      {r.companyId && r.partnerIban && !r.ibanExcluded && r.ibanCompanyId !== r.companyId ? (
                        <button className="ml-1 text-brand-600 underline" onClick={() => bindIban(r, r.companyId!, r.companyName)}>свържи</button>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <Select value={r.templateId ?? ''} onChange={(e) => applyTemplate(r, e.target.value ? Number(e.target.value) : null)} className="w-44" aria-label="Шаблон">
                      <option value="">(без шаблон)</option>
                      {parsed.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  </td>
                  <td><AccountPicker value={r.debitAccountId} onChange={(a) => setRow(r.index, { debitAccountId: a?.id ?? null })} /></td>
                  <td><AccountPicker value={r.creditAccountId} onChange={(a) => setRow(r.index, { creditAccountId: a?.id ?? null })} /></td>
                  <td><PartnerPicker value={r.companyId} valueName={r.companyName} onChange={(p) => pickPartner(r, p)} /></td>
                  <td><TextInput value={r.term} maxLength={255} onChange={(e) => setRow(r.index, { term: e.target.value })} /></td>
                  {showDocs && (
                    <td>
                      {r.documents.map((d) => (
                        <Checkbox key={d.accountingId} label={`${d.documentNumber} (${money(d.bindAmount ?? d.amount)})`} checked={d.selected} onChange={(v) => setRow(r.index, { documents: r.documents.map((x) => (x.accountingId === d.accountingId ? { ...x, selected: v } : x)) })} />
                      ))}
                      {r.companyId && partnerAcc && !st ? (
                        <button className="inline-flex items-center gap-0.5 text-[12px] text-brand-600 underline" onClick={() => setBinding(r)}><Link2 className="size-3" />Обвързване</button>
                      ) : null}
                    </td>
                  )}
                  <td className="min-w-72 max-w-96 whitespace-normal">
                    {st ? (
                      <span className={st.status === 'error' ? 'text-red-700' : st.status === 'posted' ? 'text-emerald-700' : 'text-slate-500'}>
                        {st.status === 'posted' ? 'Записан' : st.status === 'skipped' ? 'Пропуснат' : st.messages.map((m) => m.text).join(' ')}
                      </span>
                    ) : r.warnings.length ? <span className="text-amber-700">{r.warnings.map(warningText).join(' ')}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-slate-300 bg-slate-50 px-3 py-1 text-[12px]" data-testid="bank-totals">
        <span>Редове: {totals.count}</span>
        <span>Постъпления: <b className="tabular-nums text-emerald-700">{money(totals.inflow)}</b></span>
        <span>Плащания: <b className="tabular-nums text-red-700">{money(totals.outflow)}</b></span>
        {foreign && <span>{parsed.currency}: +{money(totals.currencyInflow)} / -{money(totals.currencyOutflow)}</span>}
        {foreign && Number(totals.difference) !== 0 && <span>Валутни разлики: <b className="tabular-nums">{money(totals.difference)}</b></span>}
        <span className="ml-auto flex items-center gap-2">
          <Select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="h-6 w-20" aria-label="Редове на страница">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <Button disabled={current <= 1} onClick={() => setPage(current - 1)}>‹</Button>
          <span>{current} от {pages}</span>
          <Button disabled={current >= pages} onClick={() => setPage(current + 1)}>›</Button>
        </span>
      </div>
      {binding && (() => {
        const acc = partnerAccountOf(binding);
        return acc && binding.companyId ? (
          <BindingDocumentsDialog
            accountId={acc}
            companyId={binding.companyId}
            kind="liability"
            onClose={() => setBinding(null)}
            onOk={async (sel) => {
              const docs = await api.get<Doc[]>(`/bank-statements/open-documents${qs({ companyId: binding.companyId, accountId: acc })}`);
              const chosen = new Map(sel.map((x) => [x.accountingId, x.amount]));
              setRow(binding.index, { documents: docs.map((d) => ({ ...d, selected: chosen.has(d.accountingId), bindAmount: chosen.get(d.accountingId) ?? null })) });
              setBinding(null);
            }}
          />
        ) : null;
      })()}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Excluded IBANs of payment intermediaries (04b 1.7)                  */
/* ------------------------------------------------------------------ */

export function BankExcludedIbans() {
  const dialogs = useDialogs();
  const q = useQuery({ queryKey: ['bank', 'excluded-ibans'], queryFn: () => api.get<{ ibans: string[] }>('/bank-statements/excluded-ibans') });
  const [list, setList] = useState<string[] | null>(null);
  const [iban, setIban] = useState('');
  const [msgs, setMsgs] = useState<Message[]>([]);
  useEffect(() => {
    if (q.data && list === null) setList(q.data.ibans);
  }, [q.data, list]);
  const items = list ?? [];
  const changed = q.data && list !== null && items.join() !== q.data.ibans.join();
  const add = () => {
    const v = iban.replace(/[\s\-.]/g, '').toUpperCase();
    setIban('');
    if (v && !items.includes(v)) setList([...items, v]);
  };
  const save = async () => {
    try {
      const r = await api.put<{ ibans: string[]; warnings: Message[] }>('/bank-statements/excluded-ibans', { ibans: items });
      setList(r.ibans);
      setMsgs(r.warnings);
      await q.refetch();
      await dialogs.alert('Данните са записани успешно.');
    } catch (e) {
      setMsgs(errorMessages(e));
    }
  };
  return (
    <div className="h-full overflow-auto p-3" data-testid="bank-excluded-ibans">
      <Panel title="IBAN на платежни посредници" className="max-w-[640px]">
        <div className="flex flex-col gap-2 p-3">
          <div className="text-[12px] text-slate-600">
            Сметки на посредници (напр. Юробанк/Пощенска банка, Изипей, Райфайзенбанк), през които плащат много несвързани партньори. При импорт на банкови извлечения тези IBAN не се използват за намиране на партньор и не се обвързват с партньори.
          </div>
          <div className="flex items-end gap-2">
            <Field label="IBAN"><TextInput value={iban} maxLength={50} onChange={(e) => setIban(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="w-72" /></Field>
            <Button icon={<Plus className="size-3.5" />} disabled={!iban.trim()} onClick={add}>Добави</Button>
          </div>
          {items.length ? (
            <table className="grid-table">
              <thead><tr><th>IBAN</th><th className="w-10" /></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x} data-testid="excluded-iban">
                    <td className="font-mono">{x}</td>
                    <td><button className="text-red-700" aria-label={`Премахване на ${x}`} onClick={() => setList(items.filter((y) => y !== x))}><Trash2 className="size-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Няма въведени IBAN.</Empty>}
          <MessageList messages={msgs} />
          <div className="flex justify-end gap-2">
            <Button disabled={!changed} onClick={() => setList(q.data?.ibans ?? [])}>Отказ</Button>
            <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!changed} onClick={save}>Запис</Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Posting rules editor (03a 9)                                        */
/* ------------------------------------------------------------------ */

interface Template {
  id: number; bankId: number; name: string; termText: string; referenceText: string; companyId: number | null; priority: number; isOwnAccounts: boolean; mergeRowsOnImport: boolean;
  debitAccountId: number | null; creditAccountId: number | null; debitAccountNumber: string | null; creditAccountNumber: string | null; formulaText: string;
}
interface Draft { id: number | null; name: string; debitAccountId: number | null; creditAccountId: number | null; termText: string; referenceText: string; companyId: number | null; priority: number; isOwnAccounts: boolean; mergeRowsOnImport: boolean; formula: string }

const toDraft = (t: Template | null, bankId: number): Draft & { bankId: number } => ({
  id: t?.id ?? null, bankId, name: t?.name ?? '', debitAccountId: t?.debitAccountId ?? null, creditAccountId: t?.creditAccountId ?? null, termText: t?.termText ?? '', referenceText: t?.referenceText ?? '',
  companyId: t?.companyId ?? null, priority: t?.priority ?? 10, isOwnAccounts: !!t?.isOwnAccounts, mergeRowsOnImport: !!t?.mergeRowsOnImport, formula: t?.formulaText ?? '',
});

const OPERATORS = ['или', 'и също', '=', 'започва с', 'не съдържа', 'съдържа', 'е клиент/доставчик', '>', '<', '(', ')'];

export function BankTemplates() {
  const dialogs = useDialogs();
  const banks = useBanks();
  const own = useOwnAccounts();
  const [bankId, setBankId] = useState<number | null>(null);
  useEffect(() => {
    // Default: the bank of the first own bank account (Моята фирма), else the first bank.
    if (banks.data?.length && own.data && bankId == null) setBankId(own.data.find((a) => a.bankId)?.bankId ?? banks.data[0]!.id);
  }, [banks.data, own.data, bankId]);
  const list = useQuery({ queryKey: ['bank', 'templates', bankId], queryFn: () => api.get<Template[]>(`/bank-templates${qs({ bankId })}`), enabled: !!bankId });
  const [sel, setSel] = useState<number | null>(null);
  const [d, setD] = useState<(Draft & { bankId: number }) | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const bank = banks.data?.find((b) => b.id === bankId);
  const pick = (t: Template | null) => {
    setSel(t?.id ?? null);
    setD(bankId ? toDraft(t, bankId) : null);
    setMsgs([]);
  };
  const body = (x: Draft & { bankId: number }) => ({
    bankId: x.bankId, name: x.name, debitAccountId: x.debitAccountId, creditAccountId: x.creditAccountId, termText: x.termText, referenceText: x.referenceText, companyId: x.companyId,
    priority: x.priority, isOwnAccounts: x.isOwnAccounts, mergeRowsOnImport: x.mergeRowsOnImport, formula: x.formula,
  });
  const save = async () => {
    if (!d) return;
    setMsgs([]);
    try {
      const r = d.id ? await api.put<{ id: number; warnings: Message[] }>(`/bank-templates/${d.id}`, body(d)) : await api.post<{ id: number; warnings: Message[] }>('/bank-templates', body(d));
      setMsgs(r.warnings ?? []);
      await list.refetch();
      setSel(r.id);
      setD({ ...d, id: r.id });
    } catch (e) {
      setMsgs(errorMessages(e));
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await list.refetch();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CommandBar>
        <Field label="Банка" className="flex-row items-center gap-2">
          <Select value={bankId ?? ''} onChange={(e) => { setBankId(Number(e.target.value)); pick(null); setD(null); }} className="w-64">
            {banks.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Button icon={<Plus className="size-3.5" />} onClick={() => pick(null)} disabled={!bankId}>Нов</Button>
        <Button icon={<Copy className="size-3.5" />} disabled={!sel} onClick={() => act(() => api.post(`/bank-templates/${sel}/copy`))}>Копие</Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!sel} onClick={async () => { if (await dialogs.confirm('Изтриване на шаблона?')) { await act(() => api.del(`/bank-templates/${sel}`)); pick(null); setD(null); } }}>Изтриване</Button>
        <Button disabled={!bankId} onClick={() => act(async () => { const r = await api.post<{ added: number }>('/bank-templates/defaults', { bankId }); await dialogs.alert(`Добавени шаблони: ${r.added}.`); })}>Стандартни шаблони</Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {list.data && !list.data.length ? <Empty>Няма шаблони за банката.</Empty> : (
            <table className="grid-table">
              <thead><tr><th>Приоритет</th><th>Име</th><th>Дебит</th><th>Кредит</th><th>Условие</th></tr></thead>
              <tbody>
                {list.data?.map((t) => (
                  <tr key={t.id} aria-selected={t.id === sel} onClick={() => pick(t)} className="cursor-pointer">
                    <td>{t.priority}</td><td>{t.name}</td><td>{t.debitAccountNumber}</td><td>{t.creditAccountNumber}</td><td className="max-w-96 truncate" title={t.formulaText}>{t.formulaText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {d && (
          <div className="w-[440px] shrink-0 overflow-auto border-l border-slate-300 bg-white p-3" data-testid="template-editor">
            <div className="flex flex-col gap-2">
              <Field label="Име"><TextInput value={d.name} maxLength={255} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Дебит"><AccountPicker value={d.debitAccountId} onChange={(a) => setD({ ...d, debitAccountId: a?.id ?? null, creditAccountId: a ? null : d.creditAccountId })} /></Field>
                <Field label="Кредит"><AccountPicker value={d.creditAccountId} onChange={(a) => setD({ ...d, creditAccountId: a?.id ?? null, debitAccountId: a ? null : d.debitAccountId })} /></Field>
              </div>
              <div className="text-[11px] text-slate-500">Попълва се само едната страна; на {d.creditAccountId ? 'дебит' : 'кредит'} е сметката на банковата сметка от извлечението.</div>
              <Field label="Основание"><TextInput value={d.termText} onChange={(e) => setD({ ...d, termText: e.target.value })} /></Field>
              <Field label="Забележка"><TextInput value={d.referenceText} onChange={(e) => setD({ ...d, referenceText: e.target.value })} /></Field>
              <Field label="Партньор"><PartnerPicker value={d.companyId} onChange={(p) => setD({ ...d, companyId: p?.id ?? null })} /></Field>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Приоритет (1-10)"><TextInput type="number" min={1} max={10} value={d.priority} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} className="w-20" /></Field>
                <Checkbox label="Собствени сметки" checked={d.isOwnAccounts} onChange={(v) => setD({ ...d, isOwnAccounts: v })} />
                <Checkbox label="Обединяване на редовете" checked={d.mergeRowsOnImport} onChange={(v) => setD({ ...d, mergeRowsOnImport: v })} />
              </div>
              <Field label="Условие" hint='Например: Reason съдържа "такса" или DebitAmount > 0'>
                <textarea className="field-input h-24 py-1 font-mono text-[12px]" value={d.formula} onChange={(e) => setD({ ...d, formula: e.target.value })} data-testid="template-formula" />
              </Field>
              <div className="flex flex-wrap gap-1">
                {bank?.properties.map((p) => <button key={p.name} className="rounded-sm border border-slate-300 px-1.5 text-[11px] hover:bg-brand-50" title={p.caption} onClick={() => setD({ ...d, formula: `${d.formula} ${p.name}`.trim() })}>{p.name}</button>)}
              </div>
              <div className="flex flex-wrap gap-1">
                {OPERATORS.map((o) => <button key={o} className="rounded-sm border border-slate-300 bg-slate-50 px-1.5 text-[11px] hover:bg-brand-50" onClick={() => setD({ ...d, formula: `${d.formula} ${o}`.trim() })}>{o}</button>)}
              </div>
              <MessageList messages={msgs} />
              <div className="flex justify-end gap-2">
                {d.id && <Button icon={<RotateCcw className="size-3.5" />} onClick={async () => { const r = await api.post<{ formula: { type: string; value: string }[] }>(`/bank-templates/${d.id}/restore-condition`); setD({ ...d, formula: r.formula.map((t) => (t.type === 'string' ? `"${t.value}"` : t.value)).join(' ') }); await list.refetch(); }}>Възстановяване на условието</Button>}
                <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save}>Запис</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
