import { useEffect, useState, type ReactNode } from 'react';
import { FileText, Percent } from 'lucide-react';
import { CATEGORY, calculateVatAmounts, dec, parseAmount, parseVatTermConfig, round2, VAT_MESSAGES, vatTermsFor } from '@shmi/core';
import { ApiError } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Field, Select } from '../../components/ui.tsx';
import { useLookups, useSession } from '../../session.tsx';
import type { Account } from '../../types.ts';
import { ProtocolDialog } from './ProtocolDialog.tsx';

/**
 * VAT assists of the accounting screen (spec 02b 1.4, 1.5, 7, 12), kept out of
 * EntryEditor.tsx: entry VAT term / VIES selector, F8 "Изчисли ДДС",
 * Shift+F1 AddVatPurchase, Shift+F2 AddVatSale, Ctrl+F6 protocol dialog and
 * the Yes/No confirmations of the save (HTTP 409 "confirm").
 */

interface VatLine {
  accountId: number | null;
  amount: string;
  vatTermId: number | null;
}
interface VatDraft {
  id?: number;
  transactionTypeId: number;
  viesId: number | null;
  debits: VatLine[];
  credits: VatLine[];
}

const toInput = (v: string) => String(Number(v)).replace('.', ',');

export function useEntryVat<D extends VatDraft>(d: D | null, patch: (p: Partial<D>) => void, byId: Map<number, Account>) {
  const lookups = useLookups();
  const session = useSession();
  const dialogs = useDialogs();
  const [protocolOpen, setProtocolOpen] = useState(false);
  const terms = lookups.data?.vatTerms ?? [];
  const tt = d?.transactionTypeId ?? 1;
  // SaleVatTerm / PurchaseVatTerm hold the VATTermType enum name (06 3.4); older numeric values are read too.
  const configured = tt === 3 ? parseVatTermConfig(session.settings.SaleVatTerm, 3) : tt === 2 ? parseVatTermConfig(session.settings.PurchaseVatTerm, 2) : null;
  const { list, defaultId } = vatTermsFor(terms, tt, configured);
  const [entryTerm, setEntryTerm] = useState<number | null>(null);
  const termId = entryTerm != null && list.some((t) => t.id === entryTerm) ? entryTerm : defaultId;

  // Transaction type change: default term of the type and its VIES type (02b 1.4).
  useEffect(() => {
    if (!d || d.id || tt === 1 || !defaultId) return;
    setEntryTerm(defaultId);
    const t = terms.find((x) => x.id === defaultId);
    patch({ viesId: t?.defaultViesId ?? 1, debits: d.debits.map((l) => ({ ...l, vatTermId: defaultId })), credits: d.credits.map((l) => ({ ...l, vatTermId: defaultId })) } as Partial<D>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tt]);

  // New lines of a purchase/sale take the entry term.
  useEffect(() => {
    if (!d || tt === 1 || !termId) return;
    const fill = (ls: VatLine[]) => ls.map((l) => (l.vatTermId == null ? { ...l, vatTermId: termId } : l));
    if ([...d.debits, ...d.credits].some((l) => l.vatTermId == null)) patch({ debits: fill(d.debits), credits: fill(d.credits) } as Partial<D>);
  });

  const isVatAccount = (side: 'debits' | 'credits', id: number | null) => {
    const a = id ? byId.get(id) : undefined;
    return !!a && a.categoryId === (side === 'debits' ? CATEGORY.VatPurchases : CATEGORY.VatSales);
  };
  const rateOf = (id: number) => terms.find((t) => t.id === id)?.vatValue ?? 0;

  const setTerm = (id: number | null) => {
    if (!d) return;
    setEntryTerm(id);
    const t = terms.find((x) => x.id === id);
    patch({ viesId: t?.defaultViesId ?? d.viesId, debits: d.debits.map((l) => ({ ...l, vatTermId: id })), credits: d.credits.map((l) => ({ ...l, vatTermId: id })) } as Partial<D>);
  };

  /** F8: recalculate every VAT line from the other lines of its side (02b 1.5). */
  const calculateVat = async () => {
    if (!d || !(await dialogs.confirm(VAT_MESSAGES.strCalculateVATConfirmationPrompt))) return;
    const side = (s: 'debits' | 'credits') => {
      const lines = d[s];
      const res = calculateVatAmounts(lines.map((l) => ({ amount: parseAmount(l.amount) ?? 0, vatTermId: l.vatTermId, isVat: isVatAccount(s, l.accountId) })), termId, rateOf);
      return lines.map((l, i) => (res[i] ? { ...l, amount: toInput(res[i]!.toFixed(2)) } : l));
    };
    patch({ debits: side('debits'), credits: side('credits') } as Partial<D>);
  };

  /** Shift+F1 / Shift+F2: add the VAT line on 453/1 (debit) or 453/2 (credit) and raise the single opposite line. */
  const addVat = (kind: 'purchase' | 'sale') => {
    if (!d) return;
    const side = kind === 'purchase' ? 'debits' : 'credits';
    const other = kind === 'purchase' ? 'credits' : 'debits';
    const cat = kind === 'purchase' ? CATEGORY.VatPurchases : CATEGORY.VatSales;
    const account = [...byId.values()].find((a) => a.categoryId === cat && a.isLeaf);
    if (!account) {
      void dialogs.alert(kind === 'purchase' ? VAT_MESSAGES.strVatAccountPurchaseNotDefined : VAT_MESSAGES.strVatAccountSalesNotDefined);
      return;
    }
    const term = termId ?? (kind === 'purchase' ? 2 : 7);
    const base = d[side].filter((l) => l.accountId && !isVatAccount(side, l.accountId)).reduce((a, l) => a.plus(parseAmount(l.amount) ?? 0), dec(0));
    const vat = round2(base.times(dec(rateOf(term))).div(100));
    if (vat.isZero()) return;
    const lines = d[side].filter((l) => l.accountId || parseAmount(l.amount));
    const next = [...lines, { ...lines[0], accountId: account.id, amount: toInput(vat.toFixed(2)), vatTermId: term, companyId: null, description: '', currencyAmount: '', exchangeRate: '', quantity: '', price: '' }];
    const opp = d[other].filter((l) => l.accountId);
    const p: Record<string, unknown> = { [side]: next };
    if (opp.length === 1) {
      const idx = d[other].findIndex((l) => l.accountId);
      p[other] = d[other].map((l, i) => (i === idx ? { ...l, amount: toInput((parseAmount(l.amount) ?? dec(0)).plus(vat).toFixed(2)) } : l));
    }
    patch(p as Partial<D>);
  };

  const openProtocol = () => {
    if (!d?.id) {
      void dialogs.alert('Запишете контирането, преди да създадете протокол по ЗДДС.');
      return;
    }
    setProtocolOpen(true);
  };

  /**
   * Save with the VAT Yes/No questions: a 409 "confirm" answer shows the
   * question(s); Yes repeats the save with force, No aborts (returns null).
   */
  const confirmSave = async <T,>(send: (force?: boolean) => Promise<T>): Promise<T | null> => {
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'confirm') throw e;
      for (const m of e.messages ?? []) if (!(await dialogs.confirm(m.text))) return null;
      return send(true);
    }
  };

  const vieses = lookups.data?.vieses ?? [];
  const header: ReactNode = d && (
    <>
      <Field label="ДДС режим" className="col-span-4">
        <Select value={termId ?? ''} onChange={(e) => setTerm(e.target.value ? Number(e.target.value) : null)} disabled={tt === 1} aria-label="ДДС режим">
          {tt === 1 && <option value="">Вътрешен оборот</option>}
          {list.map((t) => (
            <option key={t.id} value={t.id}>
              {t.description}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="VIES" className="col-span-3">
        <Select value={d.viesId ?? 1} onChange={(e) => patch({ viesId: Number(e.target.value) } as Partial<D>)} aria-label="VIES">
          {vieses.map((v) => (
            <option key={v.id} value={v.id}>
              {v.description}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );

  const toolbar: ReactNode = d && (
    <>
      <Button icon={<Percent className="size-3.5" />} onClick={() => void calculateVat()} title="F8 Изчисли ДДС; Shift+F1 ДДС покупки; Shift+F2 ДДС продажби">
        ДДС
      </Button>
      <Button icon={<FileText className="size-3.5" />} onClick={openProtocol} title="Ctrl+F6" disabled={tt === 1 && !d.id}>
        Протокол по ЗДДС
      </Button>
    </>
  );

  const dialog: ReactNode = protocolOpen && d?.id ? <ProtocolDialog accountingId={d.id} onClose={() => setProtocolOpen(false)} /> : null;

  return { confirmSave, header, toolbar, dialog, calculateVat, addVat, openProtocol };
}
