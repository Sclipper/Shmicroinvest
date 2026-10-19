import { useState } from 'react';
import { api, qs } from '../../api.ts';
import { Field, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell, useReportFilters } from '../common.tsx';
import { CashAccountSelect, DocumentTypeSelect, ReportTypeSelect, Sheet, SheetPrintButton } from './shared.tsx';

interface Line { accountingNumber: string; debitAccount: string; creditAccount: string; amount: string; documentNumber: string; date: string; term: string; companyName: string }
interface Order {
  accountingId: number; accountingNumber: string; documentNumber: string; documentDate: string; term: string; companyName: string;
  amount: string; amountText: string; currencyAmount: string; isoCode: string; exchangeRate: string; lines: Line[];
}
interface Result { myCompanyName: string; myCompanyBulstat: string; documentTypeId: number; title: string; orders: Order[]; rows: { first: Order; second: Order | null }[] }
interface Signatories { sender: string; senderPosition: string; recipient: string; recipientPosition: string; accountant: string }

/** Касов ордер ПКО/РКО (spec 05 6.9): filled cash-order forms, two per sheet. */
export function CashOrder() {
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('cashOrder', { ...period, type: 0, documentTypeId: 8, account: '501', companyName: '', fromNumber: '', toNumber: '' });
  const [sig, setSig] = useState<Signatories>({ sender: '', senderPosition: '', recipient: '', recipientPosition: '', accountant: '' });
  const report = useReport(
    'cashOrder',
    f,
    (x) => api.get<Result>(`/reports/cash-order${qs({ from: x.from, to: x.to, documentTypeId: x.documentTypeId, account: x.account, companyName: x.companyName, fromNumber: x.fromNumber, toNumber: x.toNumber })}`),
    (x) => ([x.fromNumber, x.toNumber].some((v) => v.trim() && !/^\d+$/.test(v.trim())) ? 'Номерът на документа трябва да е число.' : null),
  );
  const a = report.applied ?? f;
  const fc = a.type === 1;
  const senderLabel = f.documentTypeId === 9 ? 'Изплатил' : 'Наредил';
  const short = a.documentTypeId === 9 ? 'РКО' : 'ПКО';
  const sheet = (d: Result, r: Result['rows'][number], i: number) => (
    <Sheet key={i}>
      <OrderForm d={d} o={r.first} fc={fc} sig={sig} />
      {r.second && <div className="my-6 border-t border-dashed border-slate-400" />}
      {r.second && <OrderForm d={d} o={r.second} fc={fc} sig={sig} />}
    </Sheet>
  );
  const csv = (d: Result): Cell[][] => [
    ['Документ №', 'Дата', 'Партньор', 'Основание', 'Сума', 'Словом', ...(fc ? ['Валутна сума', 'Валута', 'Курс'] : []), 'Контиране №'],
    ...d.orders.map((o) => [o.documentNumber, bgDate(o.documentDate), o.companyName, o.term, amt(o.amount), o.amountText, ...(fc ? [amt(o.currencyAmount), o.isoCode, o.exchangeRate] : []), o.accountingNumber]),
  ];
  return (
    <ReportFrame<Result>
      title={`Касов ордер (${short}${fc ? ' валутен' : ''})`}
      subtitle={`${periodText(a)}, каса ${a.account}`}
      report={report}
      isEmpty={(d) => d.orders.length === 0}
      status={(d) => `${d.orders.length} ордера`}
      csvName={`${short}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} />
          <DocumentTypeSelect value={f.documentTypeId} onChange={(v) => setF({ ...f, documentTypeId: v ?? 8 })} only={[8, 9]} />
          <Field label="Сметка">
            <CashAccountSelect value={f.account} onChange={(account) => setF({ ...f, account })} />
          </Field>
          <Field label="Партньор">
            <TextInput value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} className="w-48" />
          </Field>
          <Field label="От № документ">
            <TextInput value={f.fromNumber} onChange={(e) => setF({ ...f, fromNumber: e.target.value })} className="w-24" />
          </Field>
          <Field label="До № документ">
            <TextInput value={f.toNumber} onChange={(e) => setF({ ...f, toNumber: e.target.value })} className="w-24" />
          </Field>
        </>
      }
      options={
        <>
          <Field label={senderLabel}>
            <TextInput value={sig.sender} onChange={(e) => setSig({ ...sig, sender: e.target.value })} className="w-44" />
          </Field>
          <Field label="Позиция">
            <TextInput value={sig.senderPosition} onChange={(e) => setSig({ ...sig, senderPosition: e.target.value })} className="w-32" />
          </Field>
          <Field label="Получил">
            <TextInput value={sig.recipient} onChange={(e) => setSig({ ...sig, recipient: e.target.value })} className="w-44" />
          </Field>
          <Field label="Позиция">
            <TextInput value={sig.recipientPosition} onChange={(e) => setSig({ ...sig, recipientPosition: e.target.value })} className="w-32" />
          </Field>
          <Field label="Счетоводител">
            <TextInput value={sig.accountant} onChange={(e) => setSig({ ...sig, accountant: e.target.value })} className="w-44" />
          </Field>
          {report.q.data && report.applied && (
            <div className="self-end">
              <SheetPrintButton label="Печат на ордерите" disabled={report.q.isFetching || !report.q.data.orders.length}>{() => report.q.data!.rows.map((r, i) => sheet(report.q.data!, r, i))}</SheetPrintButton>
            </div>
          )}
        </>
      }
    >
      {(d) => <div className="bg-slate-100 py-1">{d.rows.map((r, i) => sheet(d, r, i))}</div>}
    </ReportFrame>
  );
}

function OrderForm({ d, o, fc, sig }: { d: Result; o: Order; fc: boolean; sig: Signatories }) {
  const pko = d.documentTypeId !== 9;
  return (
    <div className="text-[12px]">
      <div className="flex justify-between">
        <div>
          <div className="font-bold">{d.myCompanyName}</div>
          {d.myCompanyBulstat && <div>ЕИК: {d.myCompanyBulstat}</div>}
        </div>
        <div className="text-right text-slate-600">Контиране № {o.accountingNumber}</div>
      </div>
      <h3 className="my-3 text-center text-[14px] font-bold">
        {pko ? 'Приходен касов ордер' : 'Разходен касов ордер'} № {o.documentNumber} / {bgDate(o.documentDate)}
      </h3>
      <table className="w-full">
        <tbody>
          <tr><td className="w-36 py-0.5 text-slate-600">{pko ? 'Получено от:' : 'Изплатено на:'}</td><td className="font-semibold">{o.companyName}</td></tr>
          <tr><td className="py-0.5 text-slate-600">Основание:</td><td>{o.term}</td></tr>
          <tr><td className="py-0.5 text-slate-600">Сума:</td><td className="font-semibold">{money(o.amount)}{fc && o.isoCode ? ` (${money(o.currencyAmount)} ${o.isoCode}, курс ${o.exchangeRate})` : ''}</td></tr>
          <tr><td className="py-0.5 text-slate-600">Словом:</td><td className="italic">{o.amountText}</td></tr>
        </tbody>
      </table>
      <table className="grid-table mt-2 w-full">
        <thead>
          <tr>
            <th>Дебит</th>
            <th>Кредит</th>
            <th className="text-right">Сума</th>
            <th>Партньор</th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.debitAccount}</td>
              <td>{l.creditAccount}</td>
              <td className="num">{money(l.amount)}</td>
              <td>{l.companyName}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6 grid grid-cols-3 gap-4">
        <div>{pko ? 'Наредил' : 'Изплатил'}: ..................<div className="text-[11px] text-slate-600">{[sig.sender, sig.senderPosition].filter(Boolean).join(', ')}</div></div>
        <div>Получил: ..................<div className="text-[11px] text-slate-600">{[sig.recipient, sig.recipientPosition].filter(Boolean).join(', ')}</div></div>
        <div>Счетоводител: ..................<div className="text-[11px] text-slate-600">{sig.accountant}</div></div>
      </div>
    </div>
  );
}
