import { useId, useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import {
  BUDGET_PAYMENT_TYPES, documentSumToText, fieldSheet, ibanChangePatch, paymentTypeChangePatch, PAYMENT_CURRENCIES, PAYMENT_DOCUMENT_TYPES_DEF,
  PAYMENT_SYSTEMS, PAYMENT_TAXES, TAXES_HELP, validatePaymentDocument, type FieldDef, type PaymentDocumentFields, type PaymentDocumentTypeId,
} from '@shmi/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api.ts';
import { Button, Dialog, Field, Select, TextInput, cx } from '../../components/ui.tsx';
import type { Branch, Suggestions } from './model.ts';

type Bank = { id: number; name: string; code: string };

/** Patch applied when a field is edited: IBAN -> bank/BIC, amount/currency -> words, payment type -> reason / NAP payee. */
export function editPatch(type: number, doc: PaymentDocumentFields, key: keyof PaymentDocumentFields, value: string | number | null, banks: Bank[]): Partial<PaymentDocumentFields> {
  const patch: Partial<PaymentDocumentFields> = { [key]: value } as Partial<PaymentDocumentFields>;
  if (key === 'personIban' || key === 'customerIban') Object.assign(patch, ibanChangePatch(key, value as string | null, banks));
  if (key === 'qtty' || key === 'currency') {
    // Qtty setter: whitespace becomes "0".
    if (key === 'qtty' && typeof value === 'string' && value.length > 0 && value.trim() === '') patch.qtty = '0';
    const next = { ...doc, ...patch };
    patch.inWords = documentSumToText(next.qtty, next.currency);
  }
  if (key === 'paymentType') Object.assign(patch, paymentTypeChangePatch(type, value as number | null));
  return patch;
}

const listFor = (f: FieldDef, s: Suggestions | undefined) => (f.list && s ? s[f.list] : []);

/** Edit form of one payment document: the field sheet of the type (02c 1.3) and the NonCritical messages (1.4). */
export function DocumentForm({ type, doc, onChange, banks, suggestions, readOnly }: {
  type: number;
  doc: PaymentDocumentFields;
  onChange: (patch: Partial<PaymentDocumentFields>) => void;
  banks: Bank[];
  suggestions?: Suggestions;
  readOnly?: boolean;
}) {
  const id = useId();
  const [branches, setBranches] = useState(false);
  const sheet = fieldSheet(type);
  const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];
  const groups = useMemo(() => {
    const m = new Map<string, FieldDef[]>();
    for (const f of sheet) m.set(f.group, [...(m.get(f.group) ?? []), f]);
    return [...m.entries()];
  }, [sheet]);
  const messages = validatePaymentDocument(type, doc);
  const set = (key: keyof PaymentDocumentFields, value: string | number | null) => onChange(editPatch(type, doc, key, value, banks));
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const showWords = !sheet.some((f) => f.key === 'inWords');

  const input = (f: FieldDef) => {
    const listId = `${id}-${f.key}`;
    const common = { disabled: readOnly, 'aria-label': f.label };
    switch (f.kind) {
      case 'date':
        return <TextInput {...common} type="date" value={str(doc[f.key])} onChange={(e) => set(f.key, e.target.value || null)} />;
      case 'money':
        return <TextInput {...common} className="num" inputMode="decimal" value={str(doc.qtty)} onChange={(e) => set('qtty', e.target.value)} />;
      case 'currency':
        return (
          <>
            <TextInput {...common} list={listId} maxLength={3} value={str(doc.currency)} placeholder="EUR" onChange={(e) => set('currency', e.target.value.toUpperCase())} />
            <datalist id={listId}>{PAYMENT_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          </>
        );
      case 'taxes':
        return (
          <>
            <TextInput
              {...common}
              list={listId}
              title={TAXES_HELP}
              value={str(doc.taxes)}
              onChange={(e) => set('taxes', e.target.value.trim() === '' || Number.isNaN(Number(e.target.value)) ? null : Number(e.target.value))}
            />
            <datalist id={listId}>{PAYMENT_TAXES.map((c) => <option key={c} value={c} />)}</datalist>
          </>
        );
      case 'paymentType':
        return (
          <>
            <TextInput
              {...common}
              list={listId}
              inputMode="numeric"
              value={str(doc.paymentType)}
              onChange={(e) => set('paymentType', e.target.value.trim() === '' || !/^\d+$/.test(e.target.value.trim()) ? null : Number(e.target.value))}
            />
            <datalist id={listId}>{BUDGET_PAYMENT_TYPES.map((c) => <option key={c} value={c} />)}</datalist>
          </>
        );
      case 'paymentSystem':
        return (
          <>
            <TextInput {...common} list={listId} maxLength={50} value={str(doc.paymentSystem)} onChange={(e) => set('paymentSystem', e.target.value)} />
            <datalist id={listId}>{PAYMENT_SYSTEMS.map((c) => <option key={c} value={c} />)}</datalist>
          </>
        );
      case 'bank': {
        // Order picks PersonBank, MassPayment picks PersonBIC; both fill the other half.
        const current = banks.find((b) => (f.key === 'personBic' ? b.code === doc.personBic : b.name === doc.personBank));
        return (
          <Select
            {...common}
            value={current?.id ?? ''}
            onChange={(e) => {
              const b = banks.find((x) => x.id === Number(e.target.value));
              onChange({ personBank: b?.name ?? null, personBic: b?.code ?? null });
            }}
          >
            <option value="">{f.key === 'personBic' ? str(doc.personBic) : str(doc.personBank)}</option>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} – {b.name}
              </option>
            ))}
          </Select>
        );
      }
      case 'words':
        return <TextInput {...common} maxLength={500} value={str(doc.inWords)} onChange={(e) => set('inWords', e.target.value)} />;
      default: {
        const list = listFor(f, suggestions);
        return (
          <>
            <TextInput
              {...common}
              list={list.length ? listId : undefined}
              maxLength={f.maxLength ?? 50}
              className={f.kind === 'iban' ? 'font-mono' : undefined}
              value={str(doc[f.key])}
              onChange={(e) => set(f.key, e.target.value)}
            />
            {list.length > 0 && <datalist id={listId}>{list.map((v) => <option key={v} value={v} />)}</datalist>}
          </>
        );
      }
    }
  };

  return (
    <div className="flex min-h-0 gap-3">
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-2">
        {groups.map(([group, fields]) => (
          <fieldset key={group} className="rounded-sm border border-slate-300 px-2 pt-0.5 pb-2">
            <legend className="flex items-center gap-2 px-1 text-[12px] font-semibold text-slate-600">
              {group}
              {group === 'Банка' && !readOnly && (
                <Button variant="ghost" className="h-5 px-1 text-[11px]" icon={<Building2 className="size-3" />} onClick={() => setBranches(true)}>
                  Банкови клонове
                </Button>
              )}
            </legend>
            <div className="grid grid-cols-6 gap-x-2 gap-y-1">
              {fields.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  className={cx(
                    f.kind === 'currency' || f.kind === 'taxes' || f.kind === 'date' ? 'col-span-2' : f.kind === 'money' || f.kind === 'paymentType' || f.kind === 'paymentSystem' ? 'col-span-2' : 'col-span-6',
                    (f.key === 'egn' || f.key === 'lnch' || f.key === 'bulstat' || f.key === 'idNumber' || f.key === 'rowsCount' || f.key === 'controlCode') && 'col-span-2',
                    (f.key === 'bankBranch' || f.key === 'bankAddress' || f.key === 'issuePlace') && 'col-span-3',
                    f.kind === 'derived' && 'col-span-3',
                  )}
                >
                  {input(f)}
                </Field>
              ))}
              {group === 'Сума' && showWords && (
                <div className="col-span-6 text-[12px]">
                  <span className="text-slate-600">Словом: </span>
                  <span data-testid="in-words" className="font-medium">{doc.inWords || documentSumToText(doc.qtty, doc.currency)}</span>
                </div>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      <aside className="w-72 shrink-0">
        <div className="rounded-sm border border-slate-300">
          <div className="border-b border-slate-200 bg-slate-50 px-2 py-1 text-[12px] font-semibold text-slate-600">Проверка на документа</div>
          {messages.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-emerald-700">Документът е попълнен коректно.</div>
          ) : (
            <ul className="flex flex-col gap-0.5 px-2 py-1.5 text-[12px]" aria-label="Предупреждения">
              {messages.map((m) => (
                <li key={m.key} className="flex gap-1.5 text-amber-800">
                  <span className="text-amber-600">⚠</span>
                  <span>{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          {def?.description}. Предупрежденията не спират записа; при експорт към банка са задължителни.
        </div>
      </aside>
      {branches && (
        <BranchesDialog
          onClose={() => setBranches(false)}
          onPick={(b) => {
            const patch: Partial<PaymentDocumentFields> = { bankName: b.bankName, bankBranch: b.bankBranch, bankAddress: b.bankAddress };
            if (def?.branchFillsPlace) patch.issuePlace = b.issuePlace;
            onChange(patch);
            setBranches(false);
          }}
        />
      )}
    </div>
  );
}

/** "Банкови клонове": the bank/branch/address blocks used on earlier documents. */
function BranchesDialog({ onClose, onPick }: { onClose: () => void; onPick: (b: Branch) => void }) {
  const q = useQuery({ queryKey: ['payment-documents', 'branches'], queryFn: () => api.get<Branch[]>('/payment-documents/branches') });
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const rows = (q.data ?? []).filter((b) => !filter || [b.bankName, b.bankBranch, b.bankAddress, b.issuePlace].some((v) => v?.toLowerCase().includes(filter.toLowerCase())));
  return (
    <Dialog
      title="Банкови клонове"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="primary" disabled={sel === null || !rows[sel]} onClick={() => sel !== null && rows[sel] && onPick(rows[sel])}>
            Избор
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <Field label="Търсене (банка, клон, град)">
        <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} />
      </Field>
      <div className="mt-2 max-h-72 overflow-auto border border-slate-300">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Банка</th>
              <th>Клон</th>
              <th>Адрес</th>
              <th>Място</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => (
              <tr key={i} aria-selected={sel === i} onClick={() => setSel(i)} onDoubleClick={() => onPick(b)} className="cursor-default">
                <td>{b.bankName}</td>
                <td>{b.bankBranch}</td>
                <td>{b.bankAddress}</td>
                <td>{b.issuePlace}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="text-slate-500">Няма запазени клонове. Попълнете банката ръчно; тя ще се появи тук след запис.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
