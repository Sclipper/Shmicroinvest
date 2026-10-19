import { amountFromCurrency, currencyLine, dec, lineWithFixing, materialLine, parseAmount, type Dec } from '@shmi/core';
import type { Account } from '../../types.ts';
import type { MaterialLine } from '../stock/MaterialDetailsDialog.tsx';
import type { TemplatePayload } from '../templates/TemplateDialogs.tsx';
import type { RescheduleFromEntry } from '../templates/Reschedules.tsx';
import type { MemorizedHeader } from './memorizer.ts';

/**
 * Editor command helpers (02a 2 and 4): pure functions over the editor draft so
 * EntryEditor only wires keys and buttons to them.
 */

export interface LineLike {
  accountId: number | null;
  amount: string;
  companyId: number | null;
  companyName?: string | null;
  currencyAmount: string;
  exchangeRate: string;
  /** Фиксинг (02a 1.3): the BNB/ECB rate of the accounting date; empty = filled by the server. */
  fixedRate?: string;
  quantity: string;
  price: string;
  description: string;
  vatTermId: number | null;
}

export interface DraftLike<L extends LineLike = LineLike> {
  id?: number;
  number: string;
  accountingDate: string;
  documentDate: string;
  documentTypeId: number | null;
  documentNumber: string;
  companyId: number | null;
  companyName?: string | null;
  term: string;
  reference: string;
  optionalReference: string;
  paragraph: string;
  transactionTypeId: number;
  viesId: number | null;
  viesMonth: string;
  dueDate: string;
  isInitialBalance: boolean;
  debits: L[];
  credits: L[];
}

/** Display form of a decimal: ',' separator, no trailing zeros. */
export const toInput = (v: string | number | Dec | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Number(String(v))).replace('.', ','));
/** Amount display form: two decimals with ','. */
export const toAmountInput = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2).replace('.', ','));
const toApi = (v: string) => parseAmount(v)?.toString() ?? null;

export const lineTotal = (lines: LineLike[]) => lines.reduce((a, l) => a.plus(parseAmount(l.amount) ?? 0), dec(0));

/** Изравняване: puts the difference on the shorter side's first empty (or last) line. */
export function balanced<L extends LineLike, D extends DraftLike<L>>(d: D): D {
  const diff = lineTotal(d.debits).minus(lineTotal(d.credits));
  if (diff.isZero()) return d;
  const side = diff.gt(0) ? 'credits' : 'debits';
  const lines = [...d[side]];
  const idx = lines.findIndex((l) => !parseAmount(l.amount));
  const target = idx >= 0 ? idx : lines.length - 1;
  const cur = parseAmount(lines[target]!.amount) ?? dec(0);
  lines[target] = { ...lines[target]!, amount: toAmountInput(cur.plus(diff.abs()).toFixed(2)) };
  return { ...d, [side]: lines };
}

export interface RowFormats {
  quantityDecimals: number;
  priceDecimals: number;
}

export const rowFormats = (settings: Record<string, string>): RowFormats => ({
  quantityDecimals: Number(settings.QuantityFormat ?? 3) || 3,
  priceDecimals: Number(settings.PriceFormat ?? 3) || 3,
});

/**
 * Row calculations (02a 2): foreign line amount = round2(currency × rate) or,
 * when the amount is typed, currency = round2(amount / rate); material line
 * quantity/price rounded to their formats and amount = round2(q × p).
 */
export function recalcLine<L extends LineLike>(l: L, changed: Partial<L>, acc: Account | undefined, f: RowFormats): L {
  if (!acc) return l;
  if (acc.isForeignCurrency) {
    const r = parseAmount(l.exchangeRate);
    if ('currencyAmount' in changed || 'exchangeRate' in changed) {
      const ca = parseAmount(l.currencyAmount);
      if (ca && r) return { ...l, amount: toAmountInput(amountFromCurrency(ca, r).toFixed(2)) };
    } else if ('amount' in changed && r && !r.isZero()) {
      const a = parseAmount(l.amount);
      if (a) return { ...l, currencyAmount: toInput(currencyLine(a, r).currencyAmount.toFixed(2)) };
    }
  }
  if (acc.isMaterial && ('quantity' in changed || 'price' in changed)) {
    const q = parseAmount(l.quantity);
    const p = parseAmount(l.price);
    if (q && p) {
      const m = materialLine(q, p, f);
      return { ...l, amount: toAmountInput(m.amount.toFixed(2)) };
    }
  }
  return l;
}

export function lineToApi(l: LineLike) {
  return {
    accountId: l.accountId!,
    amount: toApi(l.amount) ?? '0',
    companyId: l.companyId,
    description: l.description || null,
    vatTermId: l.vatTermId,
    currencyAmount: toApi(l.currencyAmount),
    exchangeRate: toApi(l.exchangeRate),
    fixedRate: l.fixedRate ? toApi(l.fixedRate) : null,
    quantity: toApi(l.quantity),
    price: toApi(l.price),
  };
}

/**
 * Fixing (Ctrl+F12, AutomaticFillExchangeRate, 02a 2): the rate of the date
 * becomes the line's fixing; with `asRate` also its rate, and the amount (or
 * the currency amount) is recalculated.
 */
export function withFixing<L extends LineLike>(l: L, rate: string, asRate: boolean): L {
  if (!asRate) return { ...l, fixedRate: toInput(rate) };
  const r = lineWithFixing({ amount: parseAmount(l.amount)?.toString() ?? null, currencyAmount: parseAmount(l.currencyAmount)?.toString() ?? null }, rate);
  return {
    ...l, fixedRate: toInput(rate), exchangeRate: toInput(rate),
    amount: r.amount ? toAmountInput(r.amount.toFixed(2)) : l.amount,
    currencyAmount: r.currencyAmount ? toInput(r.currencyAmount.toFixed(2)) : l.currencyAmount,
  };
}

// ---- material details (Alt+D delivery / Alt+P sale) --------------------------

/** Material lines of a side, for the material dialog's initial rows. */
export function materialLinesOf(lines: LineLike[], byId: Map<number, Account>): MaterialLine[] {
  return lines.flatMap((l) => {
    const a = l.accountId ? byId.get(l.accountId) : undefined;
    if (!a?.isMaterial || !a.productId) return [];
    const q = parseAmount(l.quantity) ?? dec(0);
    const p = parseAmount(l.price) ?? dec(0);
    return [{ productId: a.productId, accountId: a.id, name: a.description, code: null, measure: '', quantity: q.toString(), price: p.toString(), amount: (parseAmount(l.amount) ?? dec(0)).toFixed(2) }];
  });
}

/** Replaces the side's material lines with the dialog result; other lines stay. */
export function withMaterialLines<L extends LineLike>(lines: L[], material: MaterialLine[], byId: Map<number, Account>, empty: () => L): L[] {
  const kept = lines.filter((l) => l.accountId && !byId.get(l.accountId)?.isMaterial);
  const added = material.map((m) => ({ ...empty(), accountId: m.accountId, amount: toAmountInput(m.amount), quantity: toInput(m.quantity), price: toInput(m.price) }));
  const out = [...added, ...kept];
  return out.length ? out : [empty()];
}

// ---- memorizer (Alt+C / Alt+V) ------------------------------------------------

export const headerOf = (d: DraftLike): MemorizedHeader => ({
  documentTypeId: d.documentTypeId, documentNumber: d.documentNumber, documentDate: d.documentDate, companyId: d.companyId, companyName: d.companyName,
  term: d.term, reference: d.reference, optionalReference: d.optionalReference, paragraph: d.paragraph, transactionTypeId: d.transactionTypeId,
  viesId: d.viesId, viesMonth: d.viesMonth,
});

// ---- templates (F5 / Ctrl+T) --------------------------------------------------

export function templatePayload(d: DraftLike): TemplatePayload {
  const line = (l: LineLike) => ({ ...lineToApi(l), amount: toApi(l.amount) ?? '0' });
  return {
    documentTypeId: d.documentTypeId, documentNumber: d.documentNumber || null, companyId: d.companyId, term: d.term,
    reference: d.reference || null, optionalReference: d.optionalReference || null, paragraph: d.paragraph || null,
    transactionTypeId: d.transactionTypeId, viesId: d.viesId,
    debits: d.debits.filter((l) => l.accountId).map(line), credits: d.credits.filter((l) => l.accountId).map(line),
  };
}

// ---- reschedule from entry (02a 4.7 / 9.3) ------------------------------------

export function rescheduleFromEntry(d: DraftLike): RescheduleFromEntry {
  const dr = d.debits.find((l) => l.accountId);
  const cr = d.credits.find((l) => l.accountId);
  const partner = [...d.debits, ...d.credits].find((l) => l.companyId);
  return {
    amount: lineTotal(d.debits).toFixed(2), documentTypeId: d.documentTypeId, documentNumber: d.documentNumber || null, documentDate: d.documentDate || null,
    debitAccountId: dr?.accountId ?? null, creditAccountId: cr?.accountId ?? null,
    companyId: d.companyId ?? partner?.companyId ?? null, companyName: d.companyName ?? partner?.companyName ?? null,
    term: d.term || null, sourceAccountingId: d.id ?? null,
  };
}
