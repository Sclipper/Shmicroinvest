import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { dec, formatMoney, parseAmount, round, round2 } from '@shmi/core';
import { api, qs } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Dialog, TextInput, cx } from '../../components/ui.tsx';
import { useAccounts } from '../../session.tsx';

/** One material line of a delivery / sale entry; decimal strings use '.'. */
export interface MaterialLine { productId: number; accountId: number; name: string; code: string | null; measure: string; quantity: string; price: string; amount: string }

interface StockProduct { id: number; name: string; code: string | null; measure: string; price: string; accounts: { accountId: number; number: string; description: string }[] }
interface Option { productId: number; accountId: number; accountNumber: string; name: string; code: string | null; measure: string; price: string }
interface Row { key: number; productId: number; accountId: number; accountNumber: string; name: string; code: string | null; measure: string; quantity: string; price: string; amount: string }

/** Canonical decimal string ('.' separator, no trailing zeros) of a user input; '' when invalid. */
const norm = (s: string) => {
  const v = parseAmount(s);
  return v ? v.toString() : '';
};
const num = (s: string) => parseAmount(s) ?? dec(0);
const show = (s: string) => s.replace('.', ',');
const lineAmount = (qty: string, price: string) => round2(num(qty).times(num(price))).toFixed(2);

/**
 * Material details of a delivery (debit stock accounts) or a sale (credit sales
 * accounts): Доставка / Продажба на СМЗ, spec 03a 4.5. Value = round2(quantity × price);
 * editing the value recomputes the price.
 */
export function MaterialDetailsDialog({ mode, date, initial, onOk, onClose }: { mode: 'delivery' | 'sale'; date: string; initial?: MaterialLine[]; onOk: (lines: MaterialLine[]) => void; onClose: () => void }) {
  const dialogs = useDialogs();
  const { data: accounts = [] } = useAccounts();
  const numberOf = useMemo(() => new Map(accounts.map((a) => [a.id, a.number])), [accounts]);
  const keyRef = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    (initial ?? []).map((l) => ({ key: ++keyRef.current, ...l, accountNumber: '', quantity: show(l.quantity), price: show(l.price), amount: show(l.amount) })),
  );
  const [picking, setPicking] = useState(!initial?.length);
  const [filter, setFilter] = useState('');
  const [hi, setHi] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const products = useQuery({ queryKey: ['products', 'stock', mode], queryFn: () => api.get<StockProduct[]>(`/stock/products${qs({ mode })}`) });
  const options = useMemo<Option[]>(
    () => (products.data ?? []).flatMap((p) => p.accounts.map((a) => ({ productId: p.id, accountId: a.accountId, accountNumber: a.number, name: p.name, code: p.code, measure: p.measure, price: p.price }))),
    [products.data],
  );
  const q = filter.trim().toLowerCase();
  const matches = options.filter((o) => !q || o.name.toLowerCase().includes(q) || o.accountNumber.startsWith(q) || (o.code ?? '').toLowerCase().includes(q));
  useEffect(() => setHi(0), [filter]);
  useEffect(() => {
    if (picking) filterRef.current?.focus();
  }, [picking]);

  const acct = (r: Row) => r.accountNumber || numberOf.get(r.accountId) || '';
  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const add = (o: Option | undefined) => {
    if (!o) return;
    const price = show(dec(o.price).toString());
    const key = ++keyRef.current;
    setRows((rs) => [...rs, { key, productId: o.productId, accountId: o.accountId, accountNumber: o.accountNumber, name: o.name, code: o.code, measure: o.measure, quantity: '', price, amount: '0,00' }]);
    setSel(key);
    setPicking(false);
    setFilter('');
    // Focus the new row's quantity.
    setTimeout(() => document.querySelector<HTMLInputElement>(`[data-qty="${key}"]`)?.focus(), 0);
  };

  const setQuantity = (r: Row, v: string) => patch(r.key, { quantity: v, amount: show(lineAmount(v, r.price)) });
  const setPrice = (r: Row, v: string) => patch(r.key, { price: v, amount: show(lineAmount(r.quantity, v)) });
  const setAmount = (r: Row, v: string) => {
    const qty = num(r.quantity);
    patch(r.key, qty.isZero() ? { amount: v } : { amount: v, price: show(round(num(v).div(qty), 6).toString()) });
  };

  const averagePrices = async () => {
    setBusy(true);
    try {
      const prices = await Promise.all(rows.map((r) => api.get<{ price: string }>(`/stock/average-price${qs({ productId: r.productId, date })}`)));
      setRows((rs) => rs.map((r, i) => {
        const price = show(dec(prices[i]?.price ?? r.price).toString());
        return { ...r, price, amount: show(lineAmount(r.quantity, price)) };
      }));
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setBusy(false);
    }
  };

  const totalQty = rows.reduce((a, r) => a.plus(num(r.quantity)), dec(0));
  const totalAmount = rows.reduce((a, r) => a.plus(num(r.amount)), dec(0));

  const ok = async () => {
    const bad = rows.find((r) => (r.quantity.trim() && !norm(r.quantity)) || (r.price.trim() && !norm(r.price)) || (r.amount.trim() && !norm(r.amount)));
    if (bad) {
      await dialogs.alert(`Невалидна стойност за „${bad.name}“.`);
      return;
    }
    onOk(
      rows
        .filter((r) => !num(r.quantity).isZero())
        .map((r) => ({ productId: r.productId, accountId: r.accountId, name: r.name, code: r.code, measure: r.measure, quantity: norm(r.quantity), price: norm(r.price) || '0', amount: round2(num(r.amount)).toFixed(2) })),
    );
  };

  return (
    <Dialog
      title={mode === 'delivery' ? 'Доставка на стоково-материални запаси' : 'Продажба на стоково-материални запаси'}
      width={900}
      onClose={onClose}
      footer={
        <>
          {mode === 'sale' && (
            <Button className="mr-auto" onClick={averagePrices} disabled={busy || rows.length === 0}>
              Средно претеглени цени
            </Button>
          )}
          <Button variant="primary" onClick={ok}>
            OK
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-2"
        onKeyDown={(e) => {
          if (e.key === 'F4') {
            e.preventDefault();
            setPicking((p) => !p);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Button icon={<Plus className="size-3.5" />} onClick={() => setPicking((p) => !p)} title="F4">
            Добавяне на стока (F4)
          </Button>
          {sel != null && (
            <Button variant="danger" icon={<X className="size-3.5" />} onClick={() => (setRows((rs) => rs.filter((r) => r.key !== sel)), setSel(null))}>
              Изтриване на ред
            </Button>
          )}
        </div>
        {picking && (
          <div className="rounded-sm border border-slate-300 bg-slate-50 p-2">
            <TextInput
              ref={filterRef}
              aria-label="Филтър по име, сметка или код"
              placeholder="Филтър по име, сметка или код"
              className="w-80"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, matches.length - 1)));
                else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
                else if (e.key === 'Enter') (e.preventDefault(), add(matches[hi]));
                else if (e.key === 'Escape') (e.stopPropagation(), setPicking(false));
              }}
            />
            <div className="mt-1 max-h-48 overflow-auto bg-white">
              {matches.length === 0 ? (
                <div className="px-2 py-1.5 text-slate-500">{products.isLoading ? 'Зареждане…' : 'Няма стоки с подходяща сметка.'}</div>
              ) : (
                <table className="grid-table">
                  <thead>
                    <tr><th>Име</th><th>Код</th><th>Мярка</th><th>Сметка</th><th className="text-right">Цена</th></tr>
                  </thead>
                  <tbody>
                    {matches.map((o, i) => (
                      <tr key={`${o.productId}:${o.accountId}`} aria-selected={i === hi} className="cursor-default" onMouseEnter={() => setHi(i)} onClick={() => add(o)}>
                        <td>{o.name}</td>
                        <td>{o.code}</td>
                        <td>{o.measure}</td>
                        <td>{o.accountNumber}</td>
                        <td className="num">{formatMoney(o.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        <table className="grid-table">
          <thead>
            <tr>
              <th>Име</th>
              <th className="w-24">Код</th>
              <th className="w-16">Мярка</th>
              <th className="w-24">Сметка</th>
              <th className="w-28 text-right">Количество</th>
              <th className="w-28 text-right">Цена</th>
              <th className="w-28 text-right">Стойност</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-500">Няма въведени стоки. Натиснете F4 за добавяне.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} aria-selected={r.key === sel} onClick={() => setSel(r.key)}>
                <td>{r.name}</td>
                <td>{r.code}</td>
                <td>{r.measure}</td>
                <td>{acct(r)}</td>
                <td className="p-0!">
                  <input data-qty={r.key} aria-label={`Количество ${r.name}`} className={cx('field-input h-6 w-full text-right', r.quantity.trim() && !norm(r.quantity) && 'border-red-400 bg-red-50')} value={r.quantity} onFocus={(e) => (setSel(r.key), e.target.select())} onChange={(e) => setQuantity(r, e.target.value)} />
                </td>
                <td className="p-0!">
                  <input aria-label={`Цена ${r.name}`} className={cx('field-input h-6 w-full text-right', r.price.trim() && !norm(r.price) && 'border-red-400 bg-red-50')} value={r.price} onFocus={(e) => (setSel(r.key), e.target.select())} onChange={(e) => setPrice(r, e.target.value)} />
                </td>
                <td className="p-0!">
                  <input aria-label={`Стойност ${r.name}`} className={cx('field-input h-6 w-full text-right', r.amount.trim() && !norm(r.amount) && 'border-red-400 bg-red-50')} value={r.amount} onFocus={(e) => (setSel(r.key), e.target.select())} onChange={(e) => setAmount(r, e.target.value)} />
                </td>
                <td className="text-center">
                  <button type="button" className="text-slate-500 hover:text-red-600" aria-label={`Изтрий ред ${r.name}`} onClick={(e) => (e.stopPropagation(), setRows((rs) => rs.filter((x) => x.key !== r.key)))}>
                    <X className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end gap-6 text-[13px]">
          <span>
            Количество общо: <b data-testid="total-quantity">{totalQty.toString().replace('.', ',')}</b>
          </span>
          <span>
            Стойност общо: <b data-testid="total-amount">{formatMoney(totalAmount)}</b>
          </span>
        </div>
      </div>
    </Dialog>
  );
}
