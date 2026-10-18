import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListChecks, Plus, Save, Trash2, X } from 'lucide-react';
import { ACCOUNT_CATEGORIES, isCompanyCategory } from '@shmi/core';
import { api, ApiError } from '../api.ts';
import { compareAccountNumbers as cmp, money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { PartnerPicker } from '../components/pickers.tsx';
import { Button, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import type { Account } from '../types.ts';

interface BalanceRow {
  accountingId: number;
  accountId: number;
  date: string;
  companyId: number | null;
  company: string | null;
  documentTypeId: number | null;
  documentNumber: string | null;
  documentDate: string | null;
  debit: string;
  credit: string;
  currencyDebit: string;
  currencyCredit: string;
  exchangeRate: string | null;
  quantityDebit: string;
  quantityCredit: string;
}
interface Data { rows: BalanceRow[]; totals: { accountId: number; debit: string; credit: string }[] }

interface EditRow {
  key: number;
  companyId: number | null;
  company: string | null;
  documentTypeId: number | null;
  documentNumber: string;
  documentDate: string;
  debit: string;
  credit: string;
  currencyDebit: string;
  currencyCredit: string;
  quantityDebit: string;
  quantityCredit: string;
}

let keySeq = 1;
const blank = (): EditRow => ({ key: keySeq++, companyId: null, company: null, documentTypeId: null, documentNumber: '', documentDate: '', debit: '', credit: '', currencyDebit: '', currencyCredit: '', quantityDebit: '', quantityCredit: '' });
const z = (v: string) => (Number(v) === 0 ? '' : v);
const num = (v: string) => v.replace(',', '.').replace(/\s/g, '');

/** Начални салда (Alt+U; 01b 7, 07 3.5): opening balance per account, by partner and document for partner accounts. */
export function InitialBalances() {
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const { data: accounts = [], isLoading } = useAccounts();
  const data = useQuery({ queryKey: ['initialBalances', s.year.id], queryFn: () => api.get<Data>('/initial-balances') });
  const [filter, setFilter] = useState('');
  const [onlyWithBalance, setOnlyWithBalance] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  // Opening totals rolled up the tree.
  const rolled = useMemo(() => {
    const m = new Map<number, { d: number; c: number }>();
    for (const t of data.data?.totals ?? []) {
      let a = byId.get(t.accountId);
      while (a && a.number !== '0') {
        const cur = m.get(a.id) ?? { d: 0, c: 0 };
        m.set(a.id, { d: cur.d + Number(t.debit), c: cur.c + Number(t.credit) });
        a = a.parentId != null ? byId.get(a.parentId) : undefined;
      }
    }
    return m;
  }, [data.data, byId]);
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return accounts
      .filter((a) => a.number !== '0' && a.level >= 4)
      .filter((a) => !q || a.number.startsWith(q) || a.description.toLowerCase().includes(q))
      .filter((a) => !onlyWithBalance || rolled.has(a.id))
      .sort((x, y) => cmp(x.number, y.number));
  }, [accounts, filter, onlyWithBalance, rolled]);
  const total = useMemo(() => {
    let d = 0, c = 0;
    for (const t of data.data?.totals ?? []) {
      d += Number(t.debit);
      c += Number(t.credit);
    }
    return { d, c };
  }, [data.data]);
  const selected = selId != null ? byId.get(selId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <CommandBar
        right={
          <span className="text-[12px] text-slate-600" data-testid="ib-totals">
            Общо: Дебит <b>{money(total.d)}</b> · Кредит <b>{money(total.c)}</b>
            {Math.abs(total.d - total.c) > 0.005 && <span className="ml-2 text-red-700">Разлика {money(total.d - total.c)}</span>}
          </span>
        }
      >
        <Field label="Търсене" className="w-56">
          <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Номер или име на сметка" />
        </Field>
        <label className="flex items-center gap-1.5 self-end pb-1.5 text-[12.5px]">
          <input type="checkbox" checked={onlyWithBalance} onChange={(e) => setOnlyWithBalance(e.target.checked)} /> Само със салда
        </label>
        <Button className="self-end" icon={<ListChecks className="size-3.5" />} onClick={() => ws.open('initialBalanceEntries')}>
          Контировки с начални салда
        </Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="w-[46%] min-w-96 overflow-auto border-r border-slate-200">
          {isLoading || data.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Сметка</th>
                  <th>Наименование</th>
                  <th className="text-right">Дебит</th>
                  <th className="text-right">Кредит</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const t = rolled.get(a.id);
                  return (
                    <tr key={a.id} onClick={() => setSelId(a.id)} aria-selected={a.id === selId} className={cx('cursor-pointer', !a.isLeaf && 'font-semibold')}>
                      <td style={{ paddingLeft: 8 + (a.level - 4) * 12 }}>{a.number}</td>
                      <td className="w-full">{a.description}</td>
                      <td className="num">{t && t.d ? money(t.d) : ''}</td>
                      <td className="num">{t && t.c ? money(t.c) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {selected ? (
            <BalanceEditor
              key={selected.id}
              account={selected}
              rows={(data.data?.rows ?? []).filter((r) => r.accountId === selected.id)}
              otherTotal={(data.data?.totals ?? []).find((t) => t.accountId === selected.id)}
              editable={can('UI_Operations_ChartOfAccounts_ChartOfAccountsBalance') && !s.year.isLocked}
              documentTypes={lookups.data?.documentTypes ?? []}
              currencyIso={lookups.data?.currencies.find((c) => c.id === selected.currencyId)?.isoCode ?? ''}
              onSaved={() => invalidate('initialBalances', 'reports')}
              dialogs={dialogs}
              yearStart={s.year.startDate.slice(0, 10)}
            />
          ) : (
            <Empty>Изберете сметка, за да въведете началното ѝ салдо.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function BalanceEditor({ account, rows, otherTotal, editable, documentTypes, currencyIso, onSaved, dialogs, yearStart }: {
  account: Account;
  rows: BalanceRow[];
  otherTotal?: { debit: string; credit: string };
  editable: boolean;
  documentTypes: { id: number; name: string; isVisible: boolean }[];
  currencyIso: string;
  onSaved: () => void;
  dialogs: ReturnType<typeof useDialogs>;
  yearStart: string;
}) {
  const isPartner = isCompanyCategory(account.categoryId);
  const isCurrency = account.isForeignCurrency;
  const isMaterial = account.isMaterial;
  const toEdit = (r: BalanceRow): EditRow => ({
    key: keySeq++, companyId: r.companyId, company: r.company, documentTypeId: r.documentTypeId, documentNumber: r.documentNumber ?? '', documentDate: r.documentDate ?? '',
    debit: z(r.debit), credit: z(r.credit), currencyDebit: z(r.currencyDebit), currencyCredit: z(r.currencyCredit), quantityDebit: z(r.quantityDebit), quantityCredit: z(r.quantityCredit),
  });
  const [date, setDate] = useState(rows[0]?.date ?? yearStart);
  const [edit, setEdit] = useState<EditRow[]>(() => (rows.length ? rows.map(toEdit) : [blank()]));
  const [busy, setBusy] = useState(false);
  useEffect(() => setEdit(rows.length ? rows.map(toEdit) : [blank()]), [rows.map((r) => r.accountingId).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (key: number, p: Partial<EditRow>) => setEdit((e) => e.map((r) => (r.key === key ? { ...r, ...p } : r)));
  // Postings from the journal (opening entries between two accounts) are not edited here.
  const ownD = rows.reduce((s, r) => s + Number(r.debit), 0);
  const ownC = rows.reduce((s, r) => s + Number(r.credit), 0);
  const fromJournal = otherTotal ? { d: Number(otherTotal.debit) - ownD, c: Number(otherTotal.credit) - ownC } : { d: 0, c: 0 };

  const save = async (force = false): Promise<void> => {
    setBusy(true);
    try {
      const body = {
        date,
        force,
        rows: edit.map((r) => ({
          companyId: isPartner ? r.companyId : null,
          documentTypeId: isPartner ? r.documentTypeId : null,
          documentNumber: isPartner ? r.documentNumber || null : null,
          documentDate: isPartner ? r.documentDate || null : null,
          debit: num(r.debit) || null, credit: num(r.credit) || null,
          currencyDebit: isCurrency ? num(r.currencyDebit) || null : null, currencyCredit: isCurrency ? num(r.currencyCredit) || null : null,
          quantityDebit: isMaterial ? num(r.quantityDebit) || null : null, quantityCredit: isMaterial ? num(r.quantityCredit) || null : null,
        })),
      };
      await api.put(`/initial-balances/${account.id}`, body);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'warnings' && e.messages) {
        setBusy(false);
        if (await dialogs.messages('Предупреждение', e.messages, true)) return save(true);
        return;
      }
      await dialogs.error(e, 'Началните салда не могат да бъдат записани');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await dialogs.confirm(`Желаете ли изтриване на началните салда на сметка ${account.number}?`))) return;
    await api.del(`/initial-balances/${account.id}`);
    onSaved();
  };

  const category = ACCOUNT_CATEGORIES.find((c) => c.id === account.categoryId);
  const amountInput = (r: EditRow, k: keyof EditRow, label: string) => (
    <TextInput aria-label={label} className="num" disabled={!editable} value={r[k] as string} onChange={(e) => patch(r.key, { [k]: e.target.value })} />
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <div className="text-[15px] font-semibold text-slate-800">
          {account.number} {account.description}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11.5px]">
          <span className="rounded-sm bg-slate-100 px-1.5 py-0.5">{isCurrency ? `Валутна (${currencyIso})` : isMaterial ? 'Материална' : 'Стандартна'}</span>
          {isPartner && <span className="rounded-sm bg-brand-50 px-1.5 py-0.5 text-brand-700">С партньори</span>}
          {category && <span className="rounded-sm bg-slate-100 px-1.5 py-0.5">{category.description}</span>}
          {!account.isLeaf && <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-amber-900">Синтетична</span>}
        </div>
      </div>
      <Field label="Към дата" className="w-40">
        <TextInput type="date" value={date} disabled={!editable} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <div className="overflow-x-auto">
        <table className="grid-table">
          <thead>
            <tr>
              {isPartner && <th>Партньор</th>}
              {isPartner && <th>Тип документ</th>}
              {isPartner && <th>Номер</th>}
              {isPartner && <th>Дата</th>}
              {isCurrency && <th className="text-right">Валута дебит</th>}
              {isCurrency && <th className="text-right">Валута кредит</th>}
              {isMaterial && <th className="text-right">Количество дебит</th>}
              {isMaterial && <th className="text-right">Количество кредит</th>}
              <th className="text-right">Дебит</th>
              <th className="text-right">Кредит</th>
              {isPartner && <th />}
            </tr>
          </thead>
          <tbody>
            {edit.map((r) => (
              <tr key={r.key}>
                {isPartner && (
                  <td className="min-w-56">
                    <PartnerPicker value={r.companyId} valueName={r.company} onChange={(p) => patch(r.key, { companyId: p?.id ?? null, company: p?.name ?? null })} />
                  </td>
                )}
                {isPartner && (
                  <td className="min-w-40">
                    <Select aria-label="Тип документ" disabled={!editable} value={r.documentTypeId ?? ''} onChange={(e) => patch(r.key, { documentTypeId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">—</option>
                      {documentTypes.filter((d) => d.isVisible).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                  </td>
                )}
                {isPartner && <td className="w-28"><TextInput aria-label="Номер на документ" disabled={!editable} value={r.documentNumber} onChange={(e) => patch(r.key, { documentNumber: e.target.value })} /></td>}
                {isPartner && <td className="min-w-36"><TextInput type="date" aria-label="Дата на документ" disabled={!editable} value={r.documentDate} onChange={(e) => patch(r.key, { documentDate: e.target.value })} /></td>}
                {isCurrency && <td className="w-28">{amountInput(r, 'currencyDebit', 'Валута дебит')}</td>}
                {isCurrency && <td className="w-28">{amountInput(r, 'currencyCredit', 'Валута кредит')}</td>}
                {isMaterial && <td className="w-28">{amountInput(r, 'quantityDebit', 'Количество дебит')}</td>}
                {isMaterial && <td className="w-28">{amountInput(r, 'quantityCredit', 'Количество кредит')}</td>}
                <td className="w-32">{amountInput(r, 'debit', 'Дебит')}</td>
                <td className="w-32">{amountInput(r, 'credit', 'Кредит')}</td>
                {isPartner && (
                  <td className="w-8">
                    <button aria-label="Изтриване на реда" disabled={!editable} className="p-1 text-slate-400 hover:text-red-600" onClick={() => setEdit((e) => (e.length > 1 ? e.filter((x) => x.key !== r.key) : [blank()]))}>
                      <X className="size-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(Math.abs(fromJournal.d) > 0.005 || Math.abs(fromJournal.c) > 0.005) && (
        <div className="text-[12px] text-slate-500">
          Начални салда, въведени с контировки: Дебит {money(fromJournal.d)} · Кредит {money(fromJournal.c)}
        </div>
      )}
      {editable && (
        <div className="flex gap-2">
          {isPartner && <Button icon={<Plus className="size-3.5" />} onClick={() => setEdit((e) => [...e, blank()])}>Нов ред</Button>}
          <Button variant="primary" icon={<Save className="size-3.5" />} disabled={busy} onClick={() => save()}>Запис</Button>
          <Button icon={<Trash2 className="size-3.5" />} disabled={!rows.length} onClick={remove}>{isPartner ? 'Изтриване на всички' : 'Изтриване'}</Button>
        </div>
      )}
      {!editable && <div className="text-[12px] text-slate-500">Нямате права или годината е заключена за редакция.</div>}
    </div>
  );
}
