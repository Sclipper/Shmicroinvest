import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { dec } from '@shmi/core';
import { api } from '../api.ts';
import { money } from '../format.ts';
import { AccountPicker } from '../components/pickers.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Dialog, Field, Select, TextInput } from '../components/ui.tsx';
import { useAccounts, useLookups, useSession } from '../session.tsx';
import { PAYMENT_ACCOUNT_CATEGORIES } from './PaymentsShared.tsx';

export interface PaymentSettings { paymentAccountId: number | null; nextCashReceipt: string; nextCashPayment: string }

/** Payment document types offered for a payment: ПКО, РКО, БИ, ПН, МО. */
export const PAYMENT_DOCUMENT_TYPES = [8, 9, 11, 12, 10];

export const usePaymentSettings = () => useQuery({ queryKey: ['payments', 'settings'], queryFn: () => api.get<PaymentSettings>('/payments/settings') });

/** ПКО for a client paying into cash, РКО for paying a supplier from cash, bank statement otherwise. */
export function defaultPaymentDocType(side: 'client' | 'supplier', categoryId: number | null | undefined) {
  if (categoryId === 21 || categoryId === 26) return side === 'client' ? 8 : 9;
  return 11;
}

/** NewPaymentView: the paying entry for the chosen documents. */
export function NewPaymentDialog({ companyId, companyName, accountId, side, allocations, amount: initialAmount, currencyAmount: initialCurrency, exchangeRate: initialRate, isCurrency, onClose, onSaved }: {
  companyId: number;
  companyName: string;
  accountId: number;
  side: 'client' | 'supplier';
  allocations: { accountingId: number; amount: string | null }[];
  amount: string;
  currencyAmount?: string;
  exchangeRate?: string;
  isCurrency: boolean;
  onClose: () => void;
  onSaved: (r: { id: number; number: string }) => void;
}) {
  const s = useSession();
  const dialogs = useDialogs();
  const lookups = useLookups();
  const accounts = useAccounts();
  const settings = usePaymentSettings();
  const [f, setF] = useState({
    date: s.workingDate, term: side === 'client' ? 'Получено плащане' : 'Извършено плащане', reference: '',
    paymentAccountId: null as number | null, documentTypeId: 0, documentNumber: '',
    amount: initialAmount, currencyAmount: initialCurrency ?? '', exchangeRate: initialRate ?? '',
  });
  const payAcc = accounts.data?.find((a) => a.id === f.paymentAccountId);
  useEffect(() => {
    if (f.paymentAccountId === null && settings.data?.paymentAccountId) setF((x) => ({ ...x, paymentAccountId: settings.data!.paymentAccountId }));
  }, [settings.data, f.paymentAccountId]);
  useEffect(() => {
    if (payAcc) setF((x) => ({ ...x, documentTypeId: defaultPaymentDocType(side, payAcc.categoryId) }));
  }, [payAcc, side]);
  const channel = lookups.data?.documentTypes.find((t) => t.id === f.documentTypeId)?.sequenceChannel ?? 0;
  const nextNumber = f.documentTypeId === 8 ? settings.data?.nextCashReceipt : f.documentTypeId === 9 ? settings.data?.nextCashPayment : '';
  const save = useMutation({
    mutationFn: () => api.post<{ id: number; number: string }>('/payments', {
      companyId, accountId, paymentAccountId: f.paymentAccountId ?? 0, date: f.date, term: f.term, reference: f.reference || null,
      documentTypeId: f.documentTypeId || null, documentNumber: f.documentNumber || null,
      amount: f.amount, currencyAmount: isCurrency && f.currencyAmount ? f.currencyAmount : null, exchangeRate: isCurrency && f.exchangeRate ? f.exchangeRate : null,
      allocations,
    }),
    onSuccess: onSaved,
    onError: (e) => dialogs.error(e, 'Разплащане'),
  });
  const setCurrency = (currencyAmount: string) => {
    const ok = /^\d+(\.\d+)?$/.test(currencyAmount) && /^\d+(\.\d+)?$/.test(f.exchangeRate);
    setF({ ...f, currencyAmount, amount: ok ? dec(currencyAmount).times(dec(f.exchangeRate)).toFixed(2) : f.amount });
  };
  return (
    <Dialog
      title="Разплащане"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Запис
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Фирма" className="col-span-2">
          <TextInput value={companyName} readOnly />
        </Field>
        <Field label="Дата">
          <TextInput type="date" aria-label="Дата на плащане" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Сметка за разплащане">
          <AccountPicker value={f.paymentAccountId} onChange={(a) => setF({ ...f, paymentAccountId: a?.id ?? null })} filter={(a) => !a.isLeaf || PAYMENT_ACCOUNT_CATEGORIES.includes(a.categoryId ?? -1)} />
        </Field>
        <Field label="Платежен документ">
          <Select aria-label="Платежен документ" value={f.documentTypeId} onChange={(e) => setF({ ...f, documentTypeId: Number(e.target.value) })}>
            <option value={0}>—</option>
            {lookups.data?.documentTypes.filter((t) => PAYMENT_DOCUMENT_TYPES.includes(t.id)).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Номер" hint={channel ? 'Празно = следващ номер' : undefined}>
          <TextInput aria-label="Номер на платежен документ" value={f.documentNumber} placeholder={nextNumber || ''} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} />
        </Field>
        <Field label="Основание" className="col-span-2">
          <TextInput value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} />
        </Field>
        <Field label="Сума">
          <TextInput aria-label="Сума на плащането" className="text-right" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        {isCurrency ? (
          <>
            <Field label="Валутна сума">
              <TextInput className="text-right" value={f.currencyAmount} onChange={(e) => setCurrency(e.target.value)} />
            </Field>
            <Field label="Курс">
              <TextInput className="text-right" value={f.exchangeRate} onChange={(e) => setF({ ...f, exchangeRate: e.target.value })} />
            </Field>
          </>
        ) : (
          <div />
        )}
        <Field label="Забележка" className="col-span-2">
          <TextInput value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
      </div>
      <div className="mt-2 text-[12px] text-slate-500">
        Документи за разплащане: {allocations.length}, сума {money(initialAmount)}
      </div>
    </Dialog>
  );
}
