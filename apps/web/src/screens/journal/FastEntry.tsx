import { useMemo, useState } from 'react';
import { ClipboardCopy, ClipboardPaste, Copy, Eraser, FileDown, Link2, Plus, Save, Trash2 } from 'lucide-react';
import { dec, formatMoney, isCompanyCategory, JOURNAL_EXTRA_MESSAGES as XM, PAYMENT_ACCOUNT_CATEGORIES, PAYMENT_CATEGORIES, PAYMENT_MESSAGES, parseAmount } from '@shmi/core';
import { api, ApiError, type Message } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { DictionaryInput } from '../../components/DictionaryInput.tsx';
import { AccountPicker, PartnerPicker } from '../../components/pickers.tsx';
import { Button, CommandBar, Select, TextInput, cx } from '../../components/ui.tsx';
import { useAccounts, useInvalidate, useLookups, useSession } from '../../session.tsx';
import { useWorkspace, type ScreenProps } from '../../shell/workspace.tsx';
import type { Account } from '../../types.ts';
import { toInput } from '../entry/commands.ts';
import { memorizer } from '../entry/memorizer.ts';
import { SaveTemplateDialog, useTemplates, type TemplatePayload } from '../templates/TemplateDialogs.tsx';
import { BindingDocumentsDialog } from '../../payments/PaymentsShared.tsx';

interface Row {
  key: number;
  templateId: number | null;
  documentTypeId: number | null;
  documentNumber: string;
  date: string;
  debitAccountId: number | null;
  creditAccountId: number | null;
  amount: string;
  debitVatTermId: number | null;
  creditVatTermId: number | null;
  companyId: number | null;
  companyName: string | null;
  term: string;
  paymentAccountId: number | null;
  /** В-ка (02a 8.1): open documents the row's entry is bound with on save. */
  bindDocuments: { accountingId: number; amount: string | null }[] | null;
}

let seq = 0;
const blankRow = (date: string, from?: Partial<Row>): Row => ({
  templateId: null, documentTypeId: 1, documentNumber: '', date, debitAccountId: null, creditAccountId: null, amount: '', debitVatTermId: null,
  creditVatTermId: null, companyId: null, companyName: null, term: '', paymentAccountId: null, bindDocuments: null, ...from, key: ++seq,
});

const isPaymentAccount = (a: Account) => a.isLeaf && ([...PAYMENT_CATEGORIES, ...PAYMENT_ACCOUNT_CATEGORIES] as number[]).includes(a.categoryId ?? -1) && !a.isForeignCurrency;
/** Fast entry accepts only non-material, non-foreign accounts (8.1). */
const fastAccount = (a: Account) => !a.isMaterial && !a.isForeignCurrency;

/** Бързо контиране (F12, spec 02a 8.1): one simple 1:1 entry per row, saved together or not at all. */
export function FastEntry({ tab }: ScreenProps) {
  const s = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const accounts = useAccounts();
  const templates = useTemplates({ q: '', account: '', fast: true });
  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const [rows, setRows] = useState<Row[]>(() => [blankRow(s.workingDate)]);
  const [cur, setCur] = useState(0);
  const [clip, setClip] = useState<Row | null>(null);
  const [messages, setMessages] = useState<(Message & { row?: number })[]>([]);
  const [saving, setSaving] = useState(false);
  const [templateFor, setTemplateFor] = useState<TemplatePayload | null>(null);
  const [bindingFor, setBindingFor] = useState<number | null>(null);
  const bindingEnabled = s.settings.IsBindingDocumentsInFastAccountingEnabled !== 'False';
  /** The row's partner account: the debit one when it is a partner account, else the credit one. */
  const partnerAccountOf = (r: Row) => [r.debitAccountId, r.creditAccountId].find((a) => a && isCompanyCategory(byId.get(a)?.categoryId)) ?? null;

  const setDirty = (dirty: boolean) => tab.dirty !== dirty && ws.update(tab.key, { dirty });
  const update = (next: Row[]) => {
    setRows(next);
    setDirty(true);
  };
  const patch = (i: number, p: Partial<Row>) => update(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const lastDate = rows[rows.length - 1]?.date ?? s.workingDate;

  const applyTemplate = (i: number, id: number | null) => {
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return patch(i, { templateId: null });
    patch(i, {
      templateId: t.id, documentTypeId: t.documentTypeId ?? rows[i]!.documentTypeId, debitAccountId: t.debitAccountId, creditAccountId: t.creditAccountId,
      amount: Number(t.amount) ? toInput(t.amount) : rows[i]!.amount, companyId: t.companyId ?? rows[i]!.companyId, companyName: t.companyName ?? rows[i]!.companyName,
      term: t.termText ?? rows[i]!.term,
    });
  };

  // ---- row menu (8.1) ----------------------------------------------------------
  const addRow = () => {
    update([...rows, blankRow(lastDate)]);
    setCur(rows.length);
  };
  const clearRow = () => update(rows.map((r, j) => (j === cur ? blankRow(r.date, { key: r.key }) : r)));
  const deleteRow = () => {
    const next = rows.filter((_, j) => j !== cur);
    update(next.length ? next : [blankRow(s.workingDate)]);
    setCur(Math.max(0, cur - 1));
  };
  const copyRow = () => setClip({ ...rows[cur]! });
  // A copied row does not take the binding: an open document is bound once.
  const pasteRow = () => clip && update(rows.map((r, j) => (j === cur ? { ...clip, bindDocuments: null, key: r.key } : r)));
  const copyToNew = () => {
    const r = rows[cur]!;
    update([...rows.slice(0, cur + 1), blankRow(r.date, { ...r, bindDocuments: null }), ...rows.slice(cur + 1)]);
    setCur(cur + 1);
  };
  const saveAsTemplate = () => {
    const r = rows[cur]!;
    if (!r.debitAccountId || !r.creditAccountId) return;
    const amount = parseAmount(r.amount)?.toString() ?? '0';
    setTemplateFor({
      documentTypeId: r.documentTypeId, companyId: r.companyId, term: r.term, reference: null, optionalReference: null, paragraph: null, transactionTypeId: 1, viesId: null,
      debits: [{ accountId: r.debitAccountId, amount, companyId: isCompanyCategory(byId.get(r.debitAccountId)?.categoryId) ? r.companyId : null, vatTermId: r.debitVatTermId }],
      credits: [{ accountId: r.creditAccountId, amount, companyId: isCompanyCategory(byId.get(r.creditAccountId)?.categoryId) ? r.companyId : null, vatTermId: r.creditVatTermId }],
    });
  };

  const body = () => rows
    .filter((r) => r.debitAccountId || r.creditAccountId || r.amount || r.documentNumber)
    .map((r) => ({
      templateId: r.templateId, documentTypeId: r.documentTypeId, documentNumber: r.documentNumber, date: r.date, debitAccountId: r.debitAccountId,
      creditAccountId: r.creditAccountId, amount: parseAmount(r.amount)?.toString() ?? '0', debitVatTermId: r.debitVatTermId, creditVatTermId: r.creditVatTermId,
      companyId: r.companyId, term: r.term, paymentAccountId: r.paymentAccountId,
      bindDocuments: bindingEnabled && r.bindDocuments?.length ? r.bindDocuments : null,
    }));

  /** Контиране: validate, confirm database duplicates, save all rows in one transaction. */
  const save = async () => {
    let payload = body();
    if (!payload.length || saving) return;
    // As in the entry editor: an automatic payment pays the whole document, nothing is left to bind.
    if (payload.some((r) => r.bindDocuments && r.paymentAccountId)) {
      if (!(await dialogs.confirm(PAYMENT_MESSAGES.strDifferentAmountInPaymentAndBindingDoc))) return;
      payload = payload.map((r) => (r.paymentAccountId ? { ...r, bindDocuments: null } : r));
    }
    setSaving(true);
    setMessages([]);
    try {
      let force = false;
      for (;;) {
        try {
          const r = await api.post<{ saved: { id: number; number: string }[] }>('/journal/fast-entry', { rows: payload, force });
          await invalidate('entries', 'reports', 'accounts', 'dictionary');
          await dialogs.alert(`Записани са ${r.saved.length} контировки: ${r.saved.map((x) => x.number).join(', ')}.`, 'Бързо контиране');
          setRows([blankRow(lastDate)]);
          setCur(0);
          setDirty(false);
          return;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.messages?.length && !force) {
            if (!(await dialogs.messages('Бързо контиране', e.messages, true))) return;
            force = true;
            continue;
          }
          if (e instanceof ApiError && e.messages) setMessages(e.messages as (Message & { row?: number })[]);
          throw e;
        }
      }
    } catch (e) {
      await dialogs.error(e, 'Бързо контиране');
    } finally {
      setSaving(false);
    }
  };

  const total = rows.reduce((a, r) => a.plus(parseAmount(r.amount) ?? 0), dec(0));
  const badRows = new Set(messages.filter((m) => m.severity === 'critical').map((m) => m.row));
  const docTypes = lookups.data?.documentTypes.filter((t) => t.isVisible) ?? [];
  const vatTerms = lookups.data?.vatTerms ?? [];
  const paymentAccounts = (accounts.data ?? []).filter(isPaymentAccount);

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        if (e.altKey && e.code === 'KeyC') {
          e.preventDefault();
          const r = rows[cur]!;
          memorizer.copy({ documentTypeId: r.documentTypeId, documentNumber: r.documentNumber, documentDate: r.date, companyId: r.companyId, companyName: r.companyName, term: r.term, reference: '', optionalReference: '', paragraph: '', transactionTypeId: 1, viesId: null, viesMonth: '' });
        } else if (e.altKey && e.code === 'KeyV') {
          e.preventDefault();
          const h = memorizer.paste();
          if (h) patch(cur, { documentTypeId: h.documentTypeId, documentNumber: h.documentNumber, companyId: h.companyId, companyName: h.companyName ?? null, term: h.term, ...(h.documentDate ? { date: h.documentDate } : {}) });
        }
      }}
    >
      <CommandBar right={<span className="text-[12px] text-slate-500">Редове: {rows.length} · Общо: {formatMoney(total)}</span>}>
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={saving}>
          Контиране
        </Button>
        <Button icon={<Plus className="size-3.5" />} onClick={addRow}>Прибавяне на ред</Button>
        <Button icon={<Eraser className="size-3.5" />} onClick={clearRow}>Изчистване на ред</Button>
        <Button icon={<Trash2 className="size-3.5" />} onClick={deleteRow}>Изтриване на ред</Button>
        <Button icon={<ClipboardCopy className="size-3.5" />} onClick={copyRow}>Копиране на ред</Button>
        <Button icon={<ClipboardPaste className="size-3.5" />} onClick={pasteRow} disabled={!clip}>Поставяне на копиран ред</Button>
        <Button icon={<Copy className="size-3.5" />} onClick={copyToNew}>Копиране и поставяне в нов ред</Button>
        <Button icon={<FileDown className="size-3.5" />} onClick={saveAsTemplate} disabled={!rows[cur]?.debitAccountId || !rows[cur]?.creditAccountId}>Запис като шаблон</Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table" data-testid="fast-entry">
          <thead>
            <tr>
              <th className="w-6">#</th>
              <th className="w-36">Шаблон</th>
              <th className="w-32">Тип док.</th>
              <th className="w-24">Документ №</th>
              <th className="w-32">Дата</th>
              <th className="w-44">Дт с-ка</th>
              <th className="w-44">Кт с-ка</th>
              <th className="w-24 text-right">Ст-ст</th>
              <th className="w-28">Дт ДДС</th>
              <th className="w-28">Кт ДДС</th>
              <th className="w-48">Фирма</th>
              {bindingEnabled && <th className="w-24" title="Обвързване на документи">В-ка</th>}
              <th className="w-48">Основание</th>
              <th className="w-36">Плащане</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const needsPartner = isCompanyCategory(byId.get(r.debitAccountId ?? 0)?.categoryId) || isCompanyCategory(byId.get(r.creditAccountId ?? 0)?.categoryId);
              return (
                <tr key={r.key} aria-selected={cur === i} onFocus={() => setCur(i)} onClick={() => setCur(i)} className={cx(badRows.has(i) && 'bg-red-50')}>
                  <td className="text-center text-slate-500">{i + 1}</td>
                  <td className="p-0.5">
                    <Select value={r.templateId ?? ''} onChange={(e) => applyTemplate(i, e.target.value ? Number(e.target.value) : null)} aria-label={`Шаблон ${i + 1}`}>
                      <option value="" />
                      {templates.data?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-0.5">
                    <Select value={r.documentTypeId ?? ''} onChange={(e) => patch(i, { documentTypeId: e.target.value ? Number(e.target.value) : null })} aria-label={`Тип док. ${i + 1}`}>
                      <option value="" />
                      {docTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.shortName}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-0.5">
                    <TextInput value={r.documentNumber} onChange={(e) => patch(i, { documentNumber: e.target.value })} aria-label={`Документ № ${i + 1}`} />
                  </td>
                  <td className="p-0.5">
                    <TextInput type="date" value={r.date} onChange={(e) => patch(i, { date: e.target.value })} aria-label={`Дата ${i + 1}`} />
                  </td>
                  <td className="p-0.5">
                    <AccountPicker value={r.debitAccountId} filter={fastAccount} onChange={(a) => patch(i, { debitAccountId: a?.id ?? null })} />
                  </td>
                  <td className="p-0.5">
                    <AccountPicker value={r.creditAccountId} filter={fastAccount} onChange={(a) => patch(i, { creditAccountId: a?.id ?? null })} />
                  </td>
                  <td className="p-0.5">
                    <TextInput className="num" value={r.amount} inputMode="decimal" onChange={(e) => patch(i, { amount: e.target.value })} onBlur={() => parseAmount(r.amount) && patch(i, { amount: toInput(parseAmount(r.amount)!.toFixed(2)) })} aria-label={`Ст-ст ${i + 1}`} />
                  </td>
                  <td className="p-0.5">
                    <Select value={r.debitVatTermId ?? ''} onChange={(e) => patch(i, { debitVatTermId: e.target.value ? Number(e.target.value) : null })} aria-label={`Дт ДДС ${i + 1}`}>
                      <option value="" />
                      {vatTerms.map((v) => (
                        <option key={v.id} value={v.id} title={v.description}>
                          {v.description}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-0.5">
                    <Select value={r.creditVatTermId ?? ''} onChange={(e) => patch(i, { creditVatTermId: e.target.value ? Number(e.target.value) : null })} aria-label={`Кт ДДС ${i + 1}`}>
                      <option value="" />
                      {vatTerms.map((v) => (
                        <option key={v.id} value={v.id} title={v.description}>
                          {v.description}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-0.5">{needsPartner ? <PartnerPicker value={r.companyId} valueName={r.companyName} onChange={(p) => patch(i, { companyId: p?.id ?? null, companyName: p?.name ?? null, bindDocuments: null })} /> : null}</td>
                  {bindingEnabled && (
                    <td className="p-0.5">
                      <Button className="h-6 w-full px-1" icon={<Link2 className="size-3.5" />} disabled={!needsPartner || !r.companyId} onClick={() => setBindingFor(i)} aria-label={`Обвързване ${i + 1}`}>
                        {r.bindDocuments?.length ? `(${r.bindDocuments.length})` : ''}
                      </Button>
                    </td>
                  )}
                  <td className="p-0.5">
                    <DictionaryInput type="terms" value={r.term} placeholder="Основание" onChange={(v) => patch(i, { term: v })} />
                  </td>
                  <td className="p-0.5">
                    <Select value={r.paymentAccountId ?? ''} onChange={(e) => patch(i, { paymentAccountId: e.target.value ? Number(e.target.value) : null })} aria-label={`Плащане ${i + 1}`} disabled={!needsPartner}>
                      <option value="">{XM.strNoPayment}</option>
                      {paymentAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.number} {a.description}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {messages.length > 0 && (
          <ul className="m-3 flex flex-col gap-1 rounded-sm border border-red-200 bg-red-50 p-2 text-[13px]">
            {messages.map((m, j) => (
              <li key={j} className={m.severity === 'critical' ? 'text-red-800' : 'text-amber-800'}>
                {m.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      {bindingFor !== null && rows[bindingFor] && partnerAccountOf(rows[bindingFor]!) && rows[bindingFor]!.companyId && (
        <BindingDocumentsDialog
          accountId={partnerAccountOf(rows[bindingFor]!)!}
          companyId={rows[bindingFor]!.companyId!}
          onClose={() => setBindingFor(null)}
          onOk={(docs) => {
            patch(bindingFor, { bindDocuments: docs });
            setBindingFor(null);
          }}
        />
      )}
      {templateFor && <SaveTemplateDialog payload={templateFor} onClose={() => setTemplateFor(null)} onSaved={() => setTemplateFor(null)} />}
    </div>
  );
}
