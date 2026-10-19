import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { PAYMENT_MESSAGES, SUPPLIER_CATEGORIES, isCompanyCategory, sameExchangeRate } from '@shmi/core';
import { api, type Message } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { AccountPicker } from '../components/pickers.tsx';
import { Button, Checkbox, Select, TextInput } from '../components/ui.tsx';
import { useAccounts, useInvalidate, useLookups, useSession } from '../session.tsx';
import { PAYMENT_DOCUMENT_TYPES, defaultPaymentDocType, usePaymentSettings } from './PaymentsNewDialog.tsx';
import { BindingDocumentsDialog, PAYMENT_ACCOUNT_CATEGORIES, type OpenItemRow } from './PaymentsShared.tsx';

/**
 * Entry editor additions (02a 4.3, 8.2): "Автоматично разплащане" with a
 * payment account, and "Обвързване" of the entry with open documents. Both are
 * applied right after the entry is saved.
 */

interface EntryLine { accountId: number; companyId?: number | null; amount?: string | null }
export interface EntryPayload { accountingDate: string; companyId?: number | null; debits: EntryLine[]; credits: EntryLine[] }

interface BindChoice { accountId: number; companyId: number; rows: { accountingId: number; amount: string | null }[]; rates: string[] }

export interface EntryPaymentController {
  auto: boolean;
  setAuto: (v: boolean) => void;
  paymentAccountId: number | null;
  setPaymentAccountId: (v: number | null) => void;
  documentTypeId: number | null;
  setDocumentTypeId: (v: number | null) => void;
  documentNumber: string;
  setDocumentNumber: (v: string) => void;
  binding: BindChoice | null;
  setBinding: (v: BindChoice | null) => void;
  /** Pre-save checks; false = do not save, otherwise the payment / binding sent with the entry. */
  beforeSave: (payload: EntryPayload) => Promise<false | SaveExtras>;
  /** Resets the panel after the entry was saved. */
  afterSave: (extras: SaveExtras) => Promise<void>;
}

/** Auto payment / binding the server runs in the same transaction as the entry save. */
export interface SaveExtras {
  payment?: { paymentAccountId: number | null; documentTypeId: number | null; documentNumber: string | null };
  bindDocuments?: BindChoice['rows'];
}

/** Partner line of the entry: the first line on a client/supplier account. */
function partnerLine(payload: EntryPayload, categoryOf: (id: number) => number | null | undefined) {
  const line = [...payload.debits, ...payload.credits].find((l) => isCompanyCategory(categoryOf(l.accountId)));
  const companyId = line?.companyId ?? payload.companyId ?? null;
  return line && companyId ? { accountId: line.accountId, companyId } : null;
}

export function useEntryPayment(): EntryPaymentController {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const accounts = useAccounts();
  const settings = usePaymentSettings();
  const [auto, setAuto] = useState(false);
  const [paymentAccountId, setPaymentAccount] = useState<number | null>(null);
  const [documentTypeId, setDocumentTypeId] = useState<number | null>(null);
  const [documentNumber, setDocumentNumber] = useState('');
  const [binding, setBinding] = useState<BindChoice | null>(null);
  const account = paymentAccountId ?? settings.data?.paymentAccountId ?? null;
  const categoryOf = (id: number) => accounts.data?.find((a) => a.id === id)?.categoryId;
  const lines = (p: EntryPayload) => [...p.debits, ...p.credits].map((l) => ({ accountId: l.accountId, companyId: l.companyId ?? null }));

  const beforeSave = async (p: EntryPayload) => {
    if (auto) {
      try {
        const r = await api.post<{ messages: Message[] }>('/payments/validate-auto', { paymentAccountId: account, documentTypeId, documentNumber: documentNumber || null, lines: lines(p) });
        if (r.messages.length) {
          await dialogs.messages('Операцията не може да бъде записана', r.messages);
          return false;
        }
      } catch (e) {
        await dialogs.error(e);
        return false;
      }
    }
    let bind = binding;
    if (binding && !sameExchangeRate(binding.rates)) {
      if (!(await dialogs.confirm(PAYMENT_MESSAGES.strDifferentExchangeRatesInAccountingsError))) return false;
      bind = null;
    } else if (binding && auto) {
      // The auto payment pays the whole open amount, nothing is left to bind.
      if (!(await dialogs.confirm(PAYMENT_MESSAGES.strDifferentAmountInPaymentAndBindingDoc))) return false;
      bind = null;
    }
    if (bind !== binding) setBinding(null);
    const extras: SaveExtras = {};
    if (bind) extras.bindDocuments = bind.rows;
    if (auto && partnerLine(p, categoryOf)) extras.payment = { paymentAccountId: account, documentTypeId, documentNumber: documentNumber || null };
    return extras;
  };

  const afterSave = async (extras: SaveExtras) => {
    setBinding(null);
    setDocumentNumber('');
    if (extras.payment || extras.bindDocuments) await invalidate('payments', 'entries', 'reports');
  };

  return {
    auto, setAuto, paymentAccountId: account, setPaymentAccountId: setPaymentAccount, documentTypeId, setDocumentTypeId,
    documentNumber, setDocumentNumber, binding, setBinding, beforeSave, afterSave,
  };
}

/** Header strip of the entry editor with the auto payment and binding controls. */
export function EntryPaymentPanel({ ctl, payload, entryId, readOnly }: { ctl: EntryPaymentController; payload: EntryPayload; entryId?: number; readOnly?: boolean }) {
  const s = useSession();
  const lookups = useLookups();
  const accounts = useAccounts();
  const [binding, setBinding] = useState(false);
  const categoryOf = (id: number) => accounts.data?.find((a) => a.id === id)?.categoryId;
  const target = partnerLine(payload, categoryOf);
  const payAcc = accounts.data?.find((a) => a.id === ctl.paymentAccountId);
  const targetCategory = target ? categoryOf(target.accountId) : null;
  const side = (SUPPLIER_CATEGORIES as readonly number[]).includes(targetCategory ?? -1) ? 'supplier' : 'client';
  const typeId = ctl.documentTypeId ?? (payAcc ? defaultPaymentDocType(side, payAcc.categoryId) : null);
  const channel = lookups.data?.documentTypes.find((t) => t.id === typeId)?.sequenceChannel ?? 0;
  const bindingEnabled = s.settings.IsBindingDocumentsEnabled !== 'False';
  if (!target && !ctl.auto && !ctl.binding) return null;
  return (
    <div className="col-span-12 flex flex-wrap items-center gap-2 rounded-sm border border-slate-200 bg-slate-50 px-2 py-1.5" data-testid="entry-payment">
      {bindingEnabled && (
        <Button icon={<Link2 className="size-3.5" />} disabled={!target || readOnly} onClick={() => setBinding(true)}>
          Обвързване{ctl.binding ? ` (${ctl.binding.rows.length})` : ''}
        </Button>
      )}
      <Checkbox label="Автоматично разплащане" checked={ctl.auto} disabled={readOnly} onChange={ctl.setAuto} />
      {ctl.auto && (
        <>
          <div className="w-64">
            <AccountPicker value={ctl.paymentAccountId} onChange={(a) => ctl.setPaymentAccountId(a?.id ?? null)} filter={(a) => !a.isLeaf || PAYMENT_ACCOUNT_CATEGORIES.includes(a.categoryId ?? -1)} />
          </div>
          <Select aria-label="Документ за разплащане" className="w-48" value={ctl.documentTypeId ?? ''} onChange={(e) => ctl.setDocumentTypeId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{typeId ? `${lookups.data?.documentTypes.find((t) => t.id === typeId)?.name ?? ''} (по подразбиране)` : '—'}</option>
            {lookups.data?.documentTypes.filter((t) => PAYMENT_DOCUMENT_TYPES.includes(t.id)).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <TextInput aria-label="Номер на документ за разплащане" className="w-32" placeholder={channel ? 'автоматично' : 'Номер'} value={ctl.documentNumber} onChange={(e) => ctl.setDocumentNumber(e.target.value)} />
        </>
      )}
      {target && !ctl.auto && !ctl.binding && <span className="text-[12px] text-slate-500">{PAYMENT_MESSAGES.strPaymentWarning}</span>}
      {binding && target && (
        <BindingDocumentsDialog
          accountId={target.accountId}
          companyId={target.companyId}
          excludeAccountingId={entryId}
          onClose={() => setBinding(false)}
          onOk={async (rows) => {
            const items = await api.get<OpenItemRow[]>(`/payments/candidates?accountId=${target.accountId}&companyId=${target.companyId}`);
            const rates = items.filter((i) => rows.some((r) => r.accountingId === i.accountingId)).map((i) => i.exchangeRate);
            ctl.setBinding({ ...target, rows, rates });
            setBinding(false);
          }}
        />
      )}
    </div>
  );
}
