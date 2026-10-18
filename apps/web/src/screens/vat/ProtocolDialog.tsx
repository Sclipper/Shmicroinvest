import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { protocolTemplate, protocolVat, VAT_MESSAGES } from '@shmi/core';
import { api, ApiError, qs } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { AccountPicker } from '../../components/pickers.tsx';
import { Button, Dialog, Field, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useInvalidate, useLookups } from '../../session.tsx';

/**
 * "Протоколи по ЗДДС и други" (ICAViewModel, spec 02b 7 and 19): creates,
 * edits, prints and deletes the protocol accounting of a saved entry.
 */

interface Protocol {
  id?: number;
  icaType: number;
  purchaseTermId: number | null;
  documentNumber: string;
  documentDate: string;
  viesMonth: string;
  term: string;
  base: string;
  vat: string;
  expenseAccountId: number | null;
  vatDiaryCode: string | null;
}

interface Defaults extends Protocol {
  codes: string[];
  codeTexts: { code: string; text: string }[];
  userTerm: boolean;
  vatPair: boolean;
}

const ICA_TYPES: [number, string][] = [
  [1, 'ВОП'], [2, 'Получена услуга от ЕС'], [3, 'Туристически услуги/стоки втора употреба'], [4, 'Доставка по чл. 163а от ЗДДС'],
  [5, 'Внос по чл. 167а от ЗДДС'], [6, 'Режим складиране на стоки до поискване (чл. 15а)'], [7, 'Получена услуга от трета страна'],
  [8, 'ВОП - хляб и брашно'], [9, 'Доставка/внос на хляб и брашно'],
];

export function ProtocolDialog({ accountingId, onClose }: { accountingId: number; onClose: () => void }) {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const existing = useQuery({ queryKey: ['vat', 'protocol', accountingId], queryFn: () => api.get<{ protocol: Protocol | null }>(`/vat/protocols/${accountingId}`), staleTime: 0 });
  const [p, setP] = useState<Protocol | null>(null);
  const [meta, setMeta] = useState<Defaults | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDefaults = async (icaType: number, purchaseTermId: number | null, keep?: Partial<Protocol>) => {
    const d = await api.get<Defaults>(`/vat/protocols/${accountingId}/defaults${qs({ icaType, purchaseTermId })}`);
    setMeta(d);
    setP({ icaType, purchaseTermId: d.purchaseTermId, documentNumber: d.documentNumber, documentDate: d.documentDate, viesMonth: d.viesMonth, term: d.term, base: d.base, vat: d.vat, expenseAccountId: null, vatDiaryCode: d.vatDiaryCode, ...keep });
  };

  useEffect(() => {
    if (!existing.data || p) return;
    const ex = existing.data.protocol;
    if (ex) {
      void loadDefaults(ex.icaType, ex.purchaseTermId, ex);
    } else void loadDefaults(1, 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data]);

  if (!p || !meta) {
    return (
      <Dialog title="Протокол по ЗДДС" onClose={onClose} width={640}>
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      </Dialog>
    );
  }

  const t = protocolTemplate(p.icaType, p.purchaseTermId);
  const purchaseTerms = (lookups.data?.vatTerms ?? []).filter((v) => [2, 3, 4].includes(v.id));
  const set = (x: Partial<Protocol>) => setP({ ...p, ...x });

  const save = async (force = false) => {
    setBusy(true);
    try {
      const r = await api.put<{ id: number; documentNumber: string; warnings: { key: string; text: string; severity: 'warning' }[] }>(`/vat/protocols/${accountingId}`, {
        ...p, base: p.base.replace(',', '.'), vat: p.vat.replace(',', '.'), expenseAccountId: p.expenseAccountId, force,
      });
      await invalidate('entries', 'reports', 'vat');
      if (r.warnings.length) await dialogs.messages(`Протокол ${r.documentNumber} е записан с предупреждения`, r.warnings);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setBusy(false);
        if (await dialogs.confirm(e.message)) return save(true);
        return;
      }
      await dialogs.error(e, 'Протоколът не може да бъде записан');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await dialogs.confirm('Желаете ли да изтриете протокола?'))) return;
    try {
      await api.del(`/vat/protocols/${accountingId}`);
      await invalidate('entries', 'reports', 'vat');
      onClose();
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const calculate = async () => {
    if (await dialogs.confirm(VAT_MESSAGES.strCalculateVATConfirmationPrompt)) set({ vat: protocolVat(p.base.replace(',', '.') || '0').toFixed(2) });
  };

  const print = async () => {
    try {
      const d = await api.get<PrintData>(`/vat/protocols/${accountingId}/print`);
      printProtocol(d);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  return (
    <Dialog
      title="Протокол по ЗДДС"
      onClose={onClose}
      width={680}
      footer={
        <>
          {existing.data?.protocol && <Button variant="danger" onClick={remove} className="mr-auto">Изтриване</Button>}
          {existing.data?.protocol && <Button onClick={print}>Печат</Button>}
          <Button variant="primary" onClick={() => save()} disabled={busy}>Запис</Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-2">
        <Field label="Тип операция" className="col-span-4">
          <Select value={p.icaType} onChange={(e) => void loadDefaults(Number(e.target.value), p.purchaseTermId, { documentNumber: p.documentNumber })} aria-label="Тип операция">
            {ICA_TYPES.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </Select>
        </Field>
        <Field label="ДДС режим" className="col-span-2">
          <Select value={p.purchaseTermId ?? ''} disabled={!meta.userTerm} onChange={(e) => void loadDefaults(p.icaType, Number(e.target.value), { documentNumber: p.documentNumber })}>
            {!meta.userTerm && <option value={t.purchaseTermId}>{lookups.data?.vatTerms.find((v) => v.id === t.purchaseTermId)?.description}</option>}
            {meta.userTerm && purchaseTerms.map((v) => <option key={v.id} value={v.id}>{v.description}</option>)}
          </Select>
        </Field>
        <Field label="Документ №" className="col-span-2">
          <TextInput value={p.documentNumber} onChange={(e) => set({ documentNumber: e.target.value })} aria-label="Номер на протокол" />
        </Field>
        <Field label="Дата" className="col-span-2">
          <TextInput type="date" value={p.documentDate} onChange={(e) => set({ documentDate: e.target.value })} />
        </Field>
        <Field label="Месец за експорт" className="col-span-2">
          <TextInput type="month" value={p.viesMonth.slice(0, 7)} onChange={(e) => set({ viesMonth: `${e.target.value}-01` })} />
        </Field>
        <Field label="Основание" className="col-span-6">
          <TextInput value={p.term} onChange={(e) => set({ term: e.target.value })} />
        </Field>
        {t.vatPair && t.purchaseTermId === 3 && (
          <Field label="Сметка за разход" className="col-span-6">
            <AccountPicker value={p.expenseAccountId} leafOnly={false} onChange={(a) => set({ expenseAccountId: a?.id ?? null })} />
          </Field>
        )}
        <Field label="Данъчна основа" className="col-span-2">
          <TextInput className="num" value={p.base} onChange={(e) => set({ base: e.target.value })} aria-label="Данъчна основа" />
        </Field>
        <Field label="Стойност на ДДС" className="col-span-2">
          <div className="flex gap-1">
            <TextInput className="num w-full" value={p.vat} onChange={(e) => set({ vat: e.target.value })} aria-label="Стойност на ДДС" />
            <Button onClick={calculate}>Изчисли</Button>
          </div>
        </Field>
        {meta.codes.length > 0 && (
          <Field label="Код на операцията" className="col-span-2">
            <Select value={p.vatDiaryCode ?? ''} onChange={(e) => set({ vatDiaryCode: e.target.value || null })}>
              {meta.codeTexts.map((c) => (
                <option key={c.code} value={c.code} title={c.text}>{c.code} - {c.text}</option>
              ))}
            </Select>
          </Field>
        )}
        <div className="col-span-6 text-[12px] text-slate-500">
          {t.vatPair ? `Контировка: Дт 453/1 / Кт 453/2 с ДДС режими ${t.purchaseTermId} / ${t.saleTermId}${t.basePair ? ' и редове за данъчната основа' : ''}.` : 'Само код на операцията в дневниците (ДДС редовете са в основното контиране).'}
        </div>
      </div>
    </Dialog>
  );
}

interface PrintData {
  company: { name: string; vatId: string; bulstat: string };
  partner: { name: string; vatNumber: string; bulstat: string } | null;
  main: { number: string; documentNumber: string; documentDate: string };
  protocol: Protocol & { typeName: string; total: string };
  terms: { id: number; description: string }[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** VOPProtocol print: a protocol under art. 117 ZDDS in a hidden frame. */
export function printProtocol(d: PrintData) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Протокол ${esc(d.protocol.documentNumber)}</title>
<style>body{font:13px Arial,sans-serif;margin:24px}h1{font-size:18px;text-align:center}table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border:1px solid #333;padding:4px 6px}td.n{text-align:right}.sig{display:flex;justify-content:space-between;margin-top:48px}</style></head><body>
<h1>ПРОТОКОЛ № ${esc(d.protocol.documentNumber)} / ${bgDate(d.protocol.documentDate)}</h1>
<p style="text-align:center">по чл. 117 от ЗДДС — ${esc(d.protocol.typeName)}</p>
<p><b>Получател (съставител):</b> ${esc(d.company.name)}, ДДС № ${esc(d.company.vatId || '-')}, ЕИК ${esc(d.company.bulstat || '-')}</p>
<p><b>Доставчик:</b> ${esc(d.partner?.name ?? '-')}, ДДС № ${esc(d.partner?.vatNumber || '-')}</p>
<p><b>Към документ:</b> № ${esc(d.main.documentNumber)} от ${bgDate(d.main.documentDate)} (контиране ${esc(d.main.number)})</p>
<p><b>Основание:</b> ${esc(d.protocol.term)}</p>
<table><tr><th>Данъчна основа</th><th>Ставка</th><th>ДДС</th><th>Общо</th></tr>
<tr><td class="n">${money(d.protocol.base)}</td><td class="n">20%</td><td class="n">${money(d.protocol.vat)}</td><td class="n">${money(d.protocol.total)}</td></tr></table>
<p>${d.terms.map((t) => esc(`${t.id} - ${t.description}`)).join('<br>')}</p>
<div class="sig"><span>Съставил: ....................</span><span>Управител: ....................</span></div>
</body></html>`;
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  frame.contentDocument!.open();
  frame.contentDocument!.write(html);
  frame.contentDocument!.close();
  setTimeout(() => {
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
  }, 50);
}
