import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { msg } from '@shmi/core';
import { api, ApiError, qs, type Message } from '../../api.ts';
import { AccountPicker, PartnerPicker } from '../../components/pickers.tsx';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Select, TextInput, cx } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useInvalidate } from '../../session.tsx';
import { FileInput, MessageList, errorMessages, upload } from './common.tsx';

interface OwnAccount { id: number; account: string; bankId: number | null; accountId: number | null; bankName: string | null; accountNumber: string | null; currencyIso: string | null }
interface BankProp { name: string; caption: string; kind: string }
interface Bank { id: number; name: string; code: string; properties: BankProp[] }
interface Doc { accountingId: number; documentNumber: string; amount: string; isInvoice: boolean; selected: boolean }
interface Row {
  index: number; date: string; isInflow: boolean; amount: string; partnerIban: string; partnerName: string; reason: string; reference: string;
  templateId: number | null; templateName: string; debitAccountId: number | null; creditAccountId: number | null; companyId: number | null; companyName: string;
  term: string; docReference: string; postAmount: string; currencyAmount: string | null; exchangeRate: string | null; isOwnAccounts: boolean; warnings: string[]; documents: Doc[];
}
interface Parsed { header: string; format: string; currency: string | null; from: string | null; to: string | null; openingBalance?: string; closingBalance?: string; lastAccountingDate: string | null; rows: Row[] }
const warningText = (k: string) => {
  try {
    return msg(k as Parameters<typeof msg>[0]);
  } catch {
    return k;
  }
};
type RowState = { status: 'posted' | 'skipped' | 'error'; messages: Message[] };

const useOwnAccounts = () => useQuery({ queryKey: ['bank', 'accounts'], queryFn: () => api.get<OwnAccount[]>('/bank-statements/accounts') });
const useBanks = () => useQuery({ queryKey: ['bank', 'banks'], queryFn: () => api.get<Bank[]>('/bank-statements/banks') });

/* ------------------------------------------------------------------ */
/* Import wizard and preview (04b 1.4-1.10)                            */
/* ------------------------------------------------------------------ */

export function BankImport() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const own = useOwnAccounts();
  const banks = useBanks();
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
  useEffect(() => {
    if (own.data?.length && bankAccountId == null) setBankAccountId(own.data[0]!.id);
  }, [own.data, bankAccountId]);
  const acct = own.data?.find((a) => a.id === bankAccountId);
  const props = banks.data?.find((b) => b.id === acct?.bankId)?.properties.filter((p) => p.kind === 'text') ?? [];

  const parse = async () => {
    if (!file || !bankAccountId) return;
    setBusy(true);
    setMsgs([]);
    try {
      const r = await upload<Parsed>('/bank-statements/parse', file, { bankAccountId, termProperty: termProperty || undefined, referenceProperty: referenceProperty || undefined, mergeCriteria, autoBind });
      setParsed(r);
      setRows(r.rows);
      setState({});
    } catch (e) {
      setMsgs(errorMessages(e));
    } finally {
      setBusy(false);
    }
  };
  const setRow = (index: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  const pending = rows.filter((r) => state[r.index]?.status !== 'posted');

  const post = async (force = false): Promise<void> => {
    if (!pending.length) return;
    setBusy(true);
    setMsgs([]);
    try {
      const r = await api.post<{ results: ({ index: number } & RowState)[]; posted: number }>('/bank-statements/post', {
        customDocumentNumber: customNumber.trim() || undefined, ownAccountsTransfer: ownTransfer, force,
        rows: pending.map((x) => ({
          index: x.index, date: x.date, debitAccountId: x.debitAccountId, creditAccountId: x.creditAccountId, companyId: x.companyId, companyName: x.companyName,
          term: x.term, reference: x.docReference, postAmount: x.postAmount, currencyAmount: x.currencyAmount, exchangeRate: x.exchangeRate, templateId: x.templateId,
          isOwnAccounts: x.isOwnAccounts, documents: x.documents.filter((d) => d.selected).map((d) => d.accountingId),
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

  const bindIban = async (r: Row) => {
    if (!r.companyId || !r.partnerIban) return;
    try {
      const x = await api.post<{ message: string }>('/bank-statements/bind-iban', { companyId: r.companyId, iban: r.partnerIban });
      await dialogs.alert(x.message);
    } catch (e) {
      await dialogs.error(e);
    }
  };

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
            <Field label="Файл с извлечението (MT940, camt.053 XML, CSV, XLSX)"><FileInput file={file} onChange={setFile} accept=".sta,.mt940,.txt,.xml,.csv,.xlsx" testId="bank-file" /></Field>
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
            <Checkbox label="Автоматично свързване с документи" checked={autoBind} onChange={setAutoBind} />
            <MessageList messages={msgs} />
            <div className="flex justify-end"><Button variant="primary" disabled={!file || !bankAccountId || busy} onClick={parse}>Напред</Button></div>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bank-preview">
      <CommandBar right={<span className="text-[12px] text-slate-600">{parsed.format}{parsed.lastAccountingDate ? ` · последно контиране по сметката ${bgDate(parsed.lastAccountingDate)}` : ''}</span>}>
        <Button onClick={() => { setParsed(null); setRows([]); }}>Назад</Button>
        <Field label="Номер на документ" className="ml-2 flex-row items-center gap-2"><TextInput value={customNumber} onChange={(e) => setCustomNumber(e.target.value)} className="w-32" placeholder="месецът" /></Field>
        <Checkbox label="Контиране на преводи между собствени сметки" checked={ownTransfer} onChange={setOwnTransfer} />
        <Button variant="primary" disabled={busy || !pending.length} onClick={() => post()}>Запис</Button>
      </CommandBar>
      <div className="border-b border-slate-200 px-3 py-1.5 text-[13px]">{parsed.header}</div>
      <MessageList messages={msgs} />
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead>
            <tr><th>№</th><th>Дата</th><th className="text-right">Сума</th><th>Контрагент / IBAN</th><th>Шаблон</th><th className="w-44">Дебит</th><th className="w-44">Кредит</th><th className="w-52">Партньор</th><th className="w-64">Основание</th><th>Документи</th><th>Статус</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = state[r.index];
              return (
                <tr key={r.index} className={cx(st?.status === 'posted' && 'opacity-60')} data-testid="bank-row">
                  <td>{r.index + 1}</td>
                  <td>{bgDate(r.date)}</td>
                  <td className={cx('text-right tabular-nums', r.isInflow ? 'text-emerald-700' : 'text-red-700')}>{r.isInflow ? '' : '-'}{money(r.postAmount)}{r.currencyAmount ? ` (${money(r.currencyAmount)} ${parsed.currency ?? ''})` : ''}</td>
                  <td className="max-w-56 truncate" title={`${r.partnerName}\n${r.partnerIban}\n${r.reason}`}>
                    <div>{r.partnerName || <span className="text-slate-500">{r.reason}</span>}</div>
                    <div className="text-[11px] text-slate-500">{r.partnerIban}{r.companyId && r.partnerIban ? <button className="ml-1 text-brand-600 underline" onClick={() => bindIban(r)}>свържи</button> : null}</div>
                  </td>
                  <td>{r.templateName}</td>
                  <td><AccountPicker value={r.debitAccountId} onChange={(a) => setRow(r.index, { debitAccountId: a?.id ?? null })} /></td>
                  <td><AccountPicker value={r.creditAccountId} onChange={(a) => setRow(r.index, { creditAccountId: a?.id ?? null })} /></td>
                  <td><PartnerPicker value={r.companyId} valueName={r.companyName} onChange={(p) => setRow(r.index, { companyId: p?.id ?? null, companyName: p?.name ?? '' })} /></td>
                  <td><TextInput value={r.term} maxLength={255} onChange={(e) => setRow(r.index, { term: e.target.value })} /></td>
                  <td>
                    {r.documents.map((d) => (
                      <Checkbox key={d.accountingId} label={`${d.documentNumber} (${money(d.amount)})`} checked={d.selected} onChange={(v) => setRow(r.index, { documents: r.documents.map((x) => (x.accountingId === d.accountingId ? { ...x, selected: v } : x)) })} />
                    ))}
                  </td>
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
