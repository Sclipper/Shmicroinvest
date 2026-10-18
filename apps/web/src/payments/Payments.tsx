import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { HandCoins, Link2, Pencil, RefreshCw, Trash2, Unlink, X } from 'lucide-react';
import { dec } from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Dialog, Empty, Field, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useInvalidate, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import { NewPaymentDialog } from './PaymentsNewDialog.tsx';
import { OpenItemsGrid, sum, toggleIn, toRows, type Allocation, type OpenItemRow, type PartnerOpenItems, type PaymentLink } from './PaymentsShared.tsx';

interface PartnerRow { companyId: number; companyName: string; companyBulstat: string; balance: string; currencyBalance: string; liabilities: number; payments: number }

const TABS = [
  { id: 'all', label: 'Фирми' },
  { id: 'suppliers', label: 'Доставчици' },
  { id: 'clients', label: 'Клиенти' },
] as const;

/** Разплащания (F3, spec 07 3.3): partners, open liabilities/claims and existing payments. */
export function Payments() {
  const s = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('all');
  const [account, setAccount] = useState('');
  const [inCurrency, setInCurrency] = useState(false);
  const [search, setSearch] = useState('');
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [docFilter, setDocFilter] = useState({ from: `${s.year.year}-01-01`, to: `${s.year.year}-12-31`, number: '' });
  const [liab, setLiab] = useState(new Map<number, Allocation>());
  const [pays, setPays] = useState(new Map<number, Allocation>());
  const [activePayment, setActivePayment] = useState<number | null>(null);
  const [activeDoc, setActiveDoc] = useState<OpenItemRow | null>(null);
  const [newPayment, setNewPayment] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const partners = useQuery({
    queryKey: ['payments', 'partners', tab, account, inCurrency, search, s.year.id],
    queryFn: () => api.get<PartnerRow[]>(`/payments/partners${qs({ tab, account, inCurrency: inCurrency ? 1 : undefined, q: search })}`),
    placeholderData: keepPreviousData,
  });
  const items = useQuery({
    queryKey: ['payments', 'items', companyId, account, inCurrency, docFilter, s.year.id],
    queryFn: () => api.get<PartnerOpenItems>(`/payments/open-items${qs({ companyId, account, inCurrency: inCurrency ? 1 : undefined, ...docFilter })}`),
    enabled: !!companyId,
    placeholderData: keepPreviousData,
  });
  const partner = partners.data?.find((p) => p.companyId === companyId) ?? null;
  const liabilities = items.data?.liabilities ?? [];
  const payments = items.data?.payments ?? [];
  const chosenLiab = liabilities.filter((l) => liab.has(l.accountingId));
  const chosenPays = payments.filter((p) => pays.has(p.accountingId));
  const showCurrency = [...liabilities, ...payments].some((r) => Number(r.openCurrencyAbs) !== 0);
  const paymentLinks = useMemo(() => payments.find((p) => p.accountingId === activePayment)?.links ?? [], [payments, activePayment]);

  const clear = () => {
    setLiab(new Map());
    setPays(new Map());
  };
  const refresh = async () => {
    clear();
    await invalidate('payments', 'entries', 'reports');
  };
  const choosePartner = (id: number) => {
    setCompanyId(id);
    clear();
    setActivePayment(null);
    setActiveDoc(null);
  };

  /** One account per operation: the chosen documents must share it. */
  const sameAccount = (rows: OpenItemRow[]) => new Set(rows.map((r) => r.accountId)).size <= 1;

  const startPayment = async () => {
    if (!chosenLiab.length) return dialogs.alert('Не са избрани документи за задължения и вземания!');
    if (!sameAccount(chosenLiab)) return dialogs.alert('Избраните документи трябва да бъдат към един и същ партньор и сметка!');
    if (chosenPays.length) return bind();
    setNewPayment(true);
  };

  const bindMut = useMutation({
    mutationFn: () => api.post('/payments/bind', { accountId: chosenLiab[0]!.accountId, companyId, liabilities: toRows(liab), payments: toRows(pays) }),
    onSuccess: refresh,
    onError: (e) => dialogs.error(e, 'Обвързване'),
  });
  const bind = async () => {
    if (!chosenLiab.length) return dialogs.alert('Не са избрани документи за задължения и вземания!');
    if (!chosenPays.length) return dialogs.alert('Не са избрани документи за съществуващи плащания!');
    if (!sameAccount([...chosenLiab, ...chosenPays])) return dialogs.alert('Избраните документи трябва да бъдат към един и същ партньор и сметка!');
    bindMut.mutate();
  };

  const deleteLinks = async () => {
    const ids = [...liab.keys(), ...pays.keys()];
    if (!ids.length && activeDoc) ids.push(activeDoc.accountingId);
    if (!ids.length) return dialogs.alert('Не са избрани документи!');
    if (!(await dialogs.confirm('Желаете ли да изтриете връзките между избраните документи?'))) return;
    try {
      const r = await api.post<{ deleted: number }>('/payments/links/delete', { accountingIds: ids });
      await refresh();
      await dialogs.alert(`Изтрити връзки: ${r.deleted}`);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const editEntry = () => {
    const id = activeDoc?.accountingId ?? activePayment;
    if (id) ws.open('entry', { key: `entry:${id}`, title: 'Контиране', params: { id } });
  };

  const paymentInit = useMemo(() => {
    const amount = sum([...liab.values()].map((a) => a.amount));
    if (!showCurrency || !chosenLiab.length) return { amount };
    // Currency amount pro rata to the open amounts of the chosen documents.
    const cur = chosenLiab.reduce((acc, l) => {
      const a = liab.get(l.accountingId)!.amount;
      return Number(l.openAbs) ? acc.plus(dec(l.openCurrencyAbs).times(dec(a || '0')).div(dec(l.openAbs))) : acc;
    }, dec(0));
    return { amount, currencyAmount: cur.toFixed(2), exchangeRate: chosenLiab[0]!.exchangeRate };
  }, [liab, chosenLiab, showCurrency]);

  return (
    <div className="flex h-full flex-col">
      <CommandBar
        right={
          partner && (
            <span className="text-[12px] text-slate-600">
              Салдо: <b>{money(items.data?.balance)}</b>
              {showCurrency && (
                <>
                  {' '}
                  · Валутно салдо: <b>{money(items.data?.currencyBalance)}</b>
                </>
              )}
            </span>
          )
        }
      >
        <Button variant="primary" icon={<HandCoins className="size-3.5" />} disabled={!companyId} onClick={startPayment}>
          Разплащане
        </Button>
        <Button icon={<Link2 className="size-3.5" />} disabled={!companyId || bindMut.isPending} onClick={bind}>
          Обвързване
        </Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!activeDoc && !activePayment} onClick={editEntry}>
          Редакция
        </Button>
        <Button icon={<Trash2 className="size-3.5" />} disabled={!companyId} onClick={() => setReviewing(true)}>
          Анулиране
        </Button>
        <Button icon={<Unlink className="size-3.5" />} disabled={!companyId} onClick={deleteLinks}>
          Изтриване на връзки
        </Button>
        <Button icon={<X className="size-3.5" />} onClick={clear}>
          Изчистване
        </Button>
        <Button icon={<RefreshCw className="size-3.5" />} onClick={() => invalidate('payments')}>
          Обнови
        </Button>
      </CommandBar>
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_minmax(0,1fr)] gap-2 p-2">
        <section className="flex min-h-0 flex-col rounded-sm border border-slate-300 bg-white">
          <div className="flex border-b border-slate-200 bg-slate-50" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={cx('flex-1 px-2 py-1 text-[12px]', tab === t.id ? 'border-b-2 border-brand-500 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-100')}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5 border-b border-slate-200 p-2">
            <div className="flex gap-1.5">
              <Field label="Сметка" className="w-24">
                <TextInput aria-label="Сметка на партньорите" value={account} onChange={(e) => setAccount(e.target.value)} />
              </Field>
              <Field label="Търсене" className="flex-1">
                <TextInput aria-label="Търсене на партньор" value={search} onChange={(e) => setSearch(e.target.value)} />
              </Field>
            </div>
            <Checkbox label="Във валута" checked={inCurrency} onChange={setInCurrency} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {partners.isLoading ? (
              <Empty>
                <Spinner />
              </Empty>
            ) : !partners.data?.length ? (
              <Empty>Няма партньори с неплатени документи.</Empty>
            ) : (
              <table className="grid-table" data-testid="payments-partners">
                <thead>
                  <tr>
                    <th>Фирма</th>
                    <th className="text-right">Салдо</th>
                  </tr>
                </thead>
                <tbody>
                  {partners.data.map((p) => (
                    <tr key={p.companyId} aria-selected={companyId === p.companyId} onClick={() => choosePartner(p.companyId)} className="cursor-default">
                      <td className="max-w-44 truncate" title={p.companyBulstat ? `ЕИК ${p.companyBulstat}` : undefined}>
                        {p.companyName}
                      </td>
                      <td className="num">{money(p.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col rounded-sm border border-slate-300 bg-white">
          <header className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-slate-600 uppercase">Документи за задължения и вземания</header>
          <div className="flex flex-wrap items-end gap-1.5 border-b border-slate-200 p-2">
            <Field label="От дата">
              <TextInput type="date" value={docFilter.from} onChange={(e) => setDocFilter({ ...docFilter, from: e.target.value })} className="w-34" />
            </Field>
            <Field label="До дата">
              <TextInput type="date" value={docFilter.to} onChange={(e) => setDocFilter({ ...docFilter, to: e.target.value })} className="w-34" />
            </Field>
            <Field label="Документ №">
              <TextInput value={docFilter.number} onChange={(e) => setDocFilter({ ...docFilter, number: e.target.value })} className="w-28" />
            </Field>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!companyId ? (
              <Empty>Изберете партньор.</Empty>
            ) : items.isLoading ? (
              <Empty>
                <Spinner />
              </Empty>
            ) : (
              <OpenItemsGrid
                rows={liabilities}
                selected={liab}
                showCurrency={showCurrency}
                testId="payments-liabilities"
                activeId={activeDoc?.accountingId}
                onRowClick={setActiveDoc}
                onToggle={(r, on) => setLiab(toggleIn(liab, r, on))}
                onAmount={(r, v) => setLiab(new Map(liab).set(r.accountingId, { amount: v }))}
              />
            )}
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col rounded-sm border border-slate-300 bg-white">
          <header className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-slate-600 uppercase">Документи за съществуващи плащания</header>
          <div className="min-h-0 flex-1 overflow-auto">
            {companyId && (
              <OpenItemsGrid
                rows={payments}
                selected={pays}
                showCurrency={showCurrency}
                testId="payments-payments"
                activeId={activePayment}
                onRowClick={(r) => {
                  setActivePayment(r.accountingId);
                  setActiveDoc(null);
                }}
                onToggle={(r, on) => setPays(toggleIn(pays, r, on))}
                onAmount={(r, v) => setPays(new Map(pays).set(r.accountingId, { amount: v }))}
              />
            )}
          </div>
          <div className="h-40 overflow-auto border-t border-slate-300">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Номер на контиране</th>
                  <th>Тип документи</th>
                  <th>Документ №</th>
                  <th>Дата</th>
                  <th>Сметка</th>
                  <th className="text-right">Сума</th>
                </tr>
              </thead>
              <tbody>
                {(activeDoc?.links ?? paymentLinks).map((l) => {
                  const asPayment = !!activeDoc;
                  return (
                    <tr key={l.id}>
                      <td>{asPayment ? l.paymentNumber : l.refNumber}</td>
                      <td>{asPayment ? l.paymentDocumentType : l.refDocumentType}</td>
                      <td>{asPayment ? l.paymentDocumentNumber : l.refDocumentNumber}</td>
                      <td>{bgDate(asPayment ? l.paymentDate : l.refDate)}</td>
                      <td>{l.accountNumber}</td>
                      <td className="num">{money(l.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {newPayment && companyId && partner && chosenLiab.length > 0 && (
        <NewPaymentDialog
          companyId={companyId}
          companyName={partner.companyName}
          accountId={chosenLiab[0]!.accountId}
          side={chosenLiab[0]!.side}
          allocations={toRows(liab)}
          amount={paymentInit.amount}
          currencyAmount={paymentInit.currencyAmount}
          exchangeRate={paymentInit.exchangeRate}
          isCurrency={showCurrency}
          onClose={() => setNewPayment(false)}
          onSaved={async () => {
            setNewPayment(false);
            await refresh();
          }}
        />
      )}
      {reviewing && companyId && <EditPaymentsDialog companyId={companyId} companyName={partner?.companyName ?? ''} onClose={() => setReviewing(false)} onChanged={refresh} />}
    </div>
  );
}

/** EditPaymentsView: review and void links between liabilities and payments. */
function EditPaymentsDialog({ companyId, companyName, onClose, onChanged }: { companyId: number; companyName: string; onClose: () => void; onChanged: () => void }) {
  const s = useSession();
  const dialogs = useDialogs();
  const [f, setF] = useState({ from: `${s.year.year}-01-01`, to: `${s.year.year}-12-31`, term: '', number: '' });
  const [sel, setSel] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['payments', 'links', companyId, f], queryFn: () => api.get<PaymentLink[]>(`/payments/links${qs({ companyId, ...f })}`) });
  const remove = async () => {
    if (!sel) return;
    if (!(await dialogs.confirm('Желаете ли да изтриете избраното плащане?'))) return;
    try {
      await api.del(`/payments/links/${sel}`);
      setSel(null);
      await q.refetch();
      onChanged();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <Dialog
      title={`Плащания - ${companyName}`}
      onClose={onClose}
      width={980}
      footer={
        <>
          <Button variant="danger" disabled={!sel} onClick={remove}>
            Изтриване
          </Button>
          <Button onClick={onClose}>Затвори</Button>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <Field label="От дата">
          <TextInput type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="w-36" />
        </Field>
        <Field label="До дата">
          <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" />
        </Field>
        <Field label="Основание">
          <TextInput value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} className="w-44" />
        </Field>
        <Field label="№ документ">
          <TextInput value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} className="w-28" />
        </Field>
      </div>
      <div className="max-h-[45vh] overflow-auto border border-slate-200">
        {!q.data?.length ? (
          <Empty>Няма плащания.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th colSpan={4}>Док-т за задължение/вземане</th>
                <th colSpan={4}>Док-т за плащане</th>
                <th className="text-right">Сума</th>
              </tr>
              <tr>
                <th>Контиране</th>
                <th>Тип</th>
                <th>Номер</th>
                <th className="text-right">Ст-ст</th>
                <th>Контиране</th>
                <th>Тип</th>
                <th>Номер</th>
                <th className="text-right">Ст-ст</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((l) => (
                <tr key={l.id} aria-selected={sel === l.id} onClick={() => setSel(l.id)} className="cursor-default">
                  <td>{l.refNumber}</td>
                  <td>{l.refDocumentType}</td>
                  <td>{l.refDocumentNumber}</td>
                  <td className="num">{money(l.refAmount)}</td>
                  <td>{l.paymentNumber}</td>
                  <td>{l.paymentDocumentType}</td>
                  <td>{l.paymentDocumentNumber}</td>
                  <td className="num">{money(l.paymentAmount)}</td>
                  <td className="num font-medium">{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
