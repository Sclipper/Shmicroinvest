import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Save } from 'lucide-react';
import { REVALUATION_MESSAGES, canSaveRevaluation, isCompanyCategory, isListedRevaluation, revaluationLegs, revalue, roundRate } from '@shmi/core';
import { api, qs } from '../api.ts';
import { money } from '../format.ts';
import { AccountPicker, PartnerPicker } from '../components/pickers.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useSession } from '../session.tsx';
import { TabStrip, normDecimal } from '../screens/admin/common.tsx';
import type { Account } from '../types.ts';

interface Balance {
  accountId: number;
  accountNumber: string;
  accountDescription: string;
  isActive: boolean | null;
  currencyId: number;
  currencyIso: string;
  companyId: number | null;
  companyName: string | null;
  bookNet: string;
  curNet: string;
}
interface FixingRate { currencyId: number; iso: string; rate: string | null; source: string | null }
interface Setup { income: { id: number; number: string } | null; expense: { id: number; number: string } | null; baseIso: 'EUR' | 'BGN' }

type Tab = 'currency' | 'partner';
/** A grid row; `r` is null while the currency has no rate. */
type Row = { b: Balance; rate: string; r: ReturnType<typeof revalue> | null; legs: ReturnType<typeof revaluationLegs> };

/** Rounds a typed rate to 5 decimals (CurrencyDTO.Value); '' when not a positive number. */
const cleanRate = (s: string) => {
  const v = normDecimal(s);
  return /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? roundRate(v).toString() : '';
};

/** Foreign-currency accounts and their parents (the currency tab may revalue a subtree). */
function useForeignFilter(partner: boolean) {
  const { data = [] } = useAccounts();
  return useMemo(() => {
    const byId = new Map(data.map((a) => [a.id, a]));
    const ok = new Set<number>();
    for (const a of data) {
      if (!a.isForeignCurrency || isCompanyCategory(a.categoryId) !== partner) continue;
      for (let p: Account | undefined = a; p && p.number !== '0'; p = p.parentId ? byId.get(p.parentId) : undefined) ok.add(p.id);
    }
    return (a: Account) => ok.has(a.id);
  }, [data, partner]);
}

/** Преоценка (Операции > Автоматични операции, spec 02c 2). */
export function Reevaluation() {
  const s = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [tab, setTab] = useState<Tab>('currency');
  const [date, setDate] = useState(s.workingDate);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [company, setCompany] = useState<{ id: number; name: string } | null>(null);
  const [term, setTerm] = useState<string>(REVALUATION_MESSAGES.strReevaluation);
  const [reference, setReference] = useState('');
  const [rates, setRates] = useState<Record<number, string>>({});
  const [partnerRate, setPartnerRate] = useState('');
  const [busy, setBusy] = useState(false);
  const currencyFilter = useForeignFilter(false);
  const partnerFilter = useForeignFilter(true);

  const setup = useQuery({ queryKey: ['revaluation', 'setup', s.year.year], queryFn: () => api.get<Setup>('/revaluation/setup') });
  const ready = tab === 'currency' ? all || !!accountId : !!accountId;
  const balances = useQuery({
    queryKey: ['revaluation', 'balances', tab, date, all, accountId, company?.id],
    queryFn: () => api.get<{ rows: Balance[]; rates: FixingRate[] }>(`/revaluation/balances${qs({ tab, date, accountId: tab === 'currency' && all ? null : accountId, companyId: tab === 'partner' ? company?.id : null })}`),
    enabled: ready && /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
  const data = ready ? balances.data : undefined;

  // Stored fixing of the date fills empty rate cells; the partner rate defaults to the average rate.
  useEffect(() => {
    if (!data) return;
    setRates((prev) => {
      const next = { ...prev };
      for (const r of data.rates) if (r.rate && !next[r.currencyId]) next[r.currencyId] = r.rate;
      return next;
    });
    if (tab === 'partner' && !partnerRate && data.rows.length) {
      const book = data.rows.reduce((a, r) => a + Number(r.bookNet), 0);
      const cur = data.rows.reduce((a, r) => a + Number(r.curNet), 0);
      if (Math.abs(cur) > 0.01) setPartnerRate(roundRate(Math.abs(book / cur)).toString());
    }
  }, [data, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return data.rows.flatMap((b): Row[] => {
      const rate = tab === 'partner' ? cleanRate(partnerRate) : cleanRate(rates[b.currencyId] ?? '');
      if (!rate) return [{ b, rate: '', r: null, legs: null }];
      const r = revalue(b.bookNet, b.curNet, rate);
      return isListedRevaluation(r.sum) ? [{ b, rate, r, legs: revaluationLegs(r) }] : [];
    });
  }, [data, rates, partnerRate, tab]);
  const missingRate = rows.some((x) => !x.r);
  const canSave = !missingRate && canSaveRevaluation(rows.map((x) => x.r!.sum)) && can('UI_Operations_AutoOperations_Reevaluation');
  const side = (x: 'account' | 'income' | 'expense' | undefined, b: Balance) =>
    x === 'account' ? b.accountNumber : x === 'income' ? setup.data?.income?.number : x === 'expense' ? setup.data?.expense?.number : '';

  const download = async () => {
    setBusy(true);
    try {
      const got = await api.post<FixingRate[]>('/revaluation/rates/download', { date });
      setRates((prev) => ({ ...prev, ...Object.fromEntries(got.filter((r) => r.rate).map((r) => [r.currencyId, r.rate!])) }));
      if (tab === 'partner' && data?.rows[0]) {
        const r = got.find((x) => x.currencyId === data.rows[0]!.currencyId)?.rate;
        if (r) setPartnerRate(r);
      }
    } catch (e) {
      await dialogs.error(e, 'Изтегляне на фиксинг');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ entries: unknown[] }>('/revaluation', {
        tab, date, accountId: tab === 'currency' && all ? null : accountId, all: tab === 'currency' && all,
        companyId: tab === 'partner' ? company?.id ?? null : null, term, reference: reference || null,
        rates: Object.entries(rates).filter(([, v]) => cleanRate(v)).map(([k, v]) => ({ currencyId: Number(k), rate: cleanRate(v) })),
        rate: tab === 'partner' ? cleanRate(partnerRate) || null : null,
      });
      await invalidate('revaluation', 'journal', 'entries', 'reports');
      await dialogs.alert(`Записани са ${res.entries.length} мемориални ордера.`, 'Преоценка');
    } catch (e) {
      await dialogs.error(e, 'Преоценка');
    } finally {
      setBusy(false);
    }
  };

  const currencies = data?.rates ?? [];

  return (
    <div className="flex h-full flex-col">
      <TabStrip<Tab> tabs={[['currency', 'Валутни сметки'], ['partner', 'Валутни сметки с партньор']]} value={tab} onChange={(t) => { setTab(t); setAccountId(null); setPartnerRate(''); }} />
      <CommandBar right={busy && <Spinner />}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!canSave || busy} onClick={save}>
          Запис
        </Button>
        <Button icon={<Download className="size-3.5" />} disabled={busy || !currencies.length} onClick={download}>
          Изтегляне на фиксинг
        </Button>
      </CommandBar>
      {setup.data && (!setup.data.income || !setup.data.expense) && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-800">{REVALUATION_MESSAGES.strReevaluationAccountsNotDefined}</div>
      )}
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-3 py-2">
        <Field label="Дата">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-36" aria-label="Дата" />
        </Field>
        <Field label="Сметка">
          {tab === 'currency' ? (
            <AccountPicker value={accountId} onChange={(a) => setAccountId(a?.id ?? null)} leafOnly={false} filter={currencyFilter} className={cx('w-72', all && 'opacity-50')} />
          ) : (
            <AccountPicker value={accountId} onChange={(a) => { setAccountId(a?.id ?? null); setPartnerRate(''); }} filter={partnerFilter} className="w-72" />
          )}
        </Field>
        {tab === 'currency' ? (
          <Checkbox label="Преоценка на всички валутни сметки" checked={all} onChange={setAll} className="mb-1.5" />
        ) : (
          <>
            <Field label="Партньор">
              <PartnerPicker value={company?.id ?? null} valueName={company?.name} onChange={(p) => setCompany(p ? { id: p.id, name: p.name } : null)} className="w-60" />
            </Field>
            <Field label="Нов курс">
              <TextInput value={partnerRate} onChange={(e) => setPartnerRate(e.target.value)} onBlur={() => setPartnerRate(cleanRate(partnerRate))} className="num w-28" aria-label="Нов курс" />
            </Field>
          </>
        )}
        <Field label="Основание">
          <TextInput value={term} onChange={(e) => setTerm(e.target.value)} className="w-56" aria-label="Основание" />
        </Field>
        <Field label="Забележка">
          <TextInput value={reference} onChange={(e) => setReference(e.target.value)} className="w-56" aria-label="Забележка" />
        </Field>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-auto p-3">
        {tab === 'currency' && (
          <Panel title="Фиксинг" className="w-60 self-start">
            {currencies.length ? (
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Валута</th>
                    <th className="text-right">Курс ({setup.data?.baseIso ?? s.baseCurrency})</th>
                  </tr>
                </thead>
                <tbody>
                  {currencies.map((c) => (
                    <tr key={c.currencyId}>
                      <td>{c.iso}</td>
                      <td className="p-0!">
                        <input
                          aria-label={`Курс ${c.iso}`}
                          className="num h-6 w-full bg-transparent px-2 outline-none focus:bg-white focus:ring-1 focus:ring-brand-300"
                          value={rates[c.currencyId] ?? ''}
                          onChange={(e) => setRates({ ...rates, [c.currencyId]: e.target.value })}
                          onBlur={() => setRates({ ...rates, [c.currencyId]: cleanRate(rates[c.currencyId] ?? '') })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="px-3 py-2 text-slate-500">Няма валути</div>
            )}
          </Panel>
        )}
        <Panel title="Салда за преоценка" className="min-w-0 flex-1 self-start">
          {!ready ? (
            <Empty>Изберете сметка{tab === 'currency' ? ' или „Преоценка на всички валутни сметки“' : ''}.</Empty>
          ) : balances.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !rows.length ? (
            <Empty>Няма сметки за преоценка.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Сметка</th>
                  {tab === 'partner' && <th>Партньор</th>}
                  <th>Валута</th>
                  <th className="text-right">Валутна сума</th>
                  <th className="text-right">Среден курс</th>
                  <th className="text-right">Сума</th>
                  <th className="text-right">Курс</th>
                  <th className="text-right">Нова сума</th>
                  <th>Дебит</th>
                  <th>Кредит</th>
                  <th className="text-right">Разлика</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ b, rate, r, legs }) => (
                  <tr key={`${b.accountId}:${b.companyId ?? ''}`}>
                    <td title={b.accountDescription}>{b.accountNumber}</td>
                    {tab === 'partner' && <td>{b.companyName}</td>}
                    <td>{b.currencyIso}</td>
                    <td className="num">{money(b.curNet)}</td>
                    <td className="num">{r ? r.averageRate.toDecimalPlaces(5).toString() : ''}</td>
                    <td className="num">{money(b.bookNet)}</td>
                    <td className="num">{rate || <span className="text-red-600">няма курс</span>}</td>
                    <td className="num">{r ? money(r.newAmount.toFixed(2)) : ''}</td>
                    <td>{side(legs?.debit, b)}</td>
                    <td>{side(legs?.credit, b)}</td>
                    <td className={cx('num', r?.direction === 'negative' && 'text-red-700', r?.direction === 'positive' && 'text-emerald-700')}>{r ? money(r.sum.toFixed(2)) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {missingRate && <div className="border-t border-slate-200 px-3 py-1.5 text-[12px] text-red-700">{REVALUATION_MESSAGES.strExchangeRateNotSetError}</div>}
        </Panel>
      </div>
    </div>
  );
}
