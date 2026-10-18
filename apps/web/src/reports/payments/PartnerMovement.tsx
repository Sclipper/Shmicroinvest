import { useState } from 'react';
import { api, qs } from '../../api.ts';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Field, Select } from '../../components/ui.tsx';
import { bgDate } from '../../format.ts';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell } from '../common.tsx';
import { ColumnFilter, ReportTypeSelect, usePartnerAccountFilter } from './shared.tsx';

interface Row {
  accountingId: number; accountingNumbers: string; accountingDate: string; documentDate: string; documentType: string; documentNumber: string;
  debitAmount: string; creditAmount: string; debitCurrencyAmount: string; creditCurrencyAmount: string; currency: string;
  term: string; reference: string; optionalReference: string;
}
interface Bal { debit: string; credit: string; debitCurrency: string; creditCurrency: string }
interface Result { companyName: string; accountDescription: string; opening: Bal; rows: Row[]; turnover: Bal; closing: Bal }

const SORTS: [string, string][] = [['DocumentDate', 'Дата на документа'], ['AccountingNumber', 'Номер на контиране'], ['AccountingDate', 'Дата на контиране'], ['DebitAmount', 'Сума дебит'], ['CreditAmount', 'Сума кредит'], ['Term', 'Основание'], ['DocumentType', 'Тип документ'], ['DocumentNumber', 'Номер на документ']];
const FILTERS: [string, string][] = [['all', 'Всички'], ['accountingNumbers', 'Номер на контиране'], ['accountingDate', 'Дата на контиране'], ['documentDate', 'Дата на документа'], ['documentType', 'Тип на документа'], ['documentNumber', 'Номер на документ'], ['debitAmount', 'Сума дебит'], ['creditAmount', 'Сума кредит'], ['term', 'Основание'], ['reference', 'Забележка'], ['optionalReference', 'Втора забележка']];

/** Движение по партньор (spec 05 6.6): chronological movement of one partner on a partner account. */
export function PartnerMovement() {
  const period = useYearPeriod();
  const accFilter = usePartnerAccountFilter();
  const [f, setF] = useState({ ...period, type: 0, account: '', companyId: null as number | null, companyName: '', sort: 'DocumentDate', direction: 0, filterColumn: 'all', filterText: '' });
  const report = useReport(
    'partnerMovement',
    f,
    (x) => api.get<Result>(`/reports/partner-movement${qs({ from: x.from, to: x.to, account: x.account, companyId: x.companyId, direction: x.direction || null, currency: x.type === 1, sort: x.sort, filterColumn: x.filterText ? x.filterColumn : null, filterText: x.filterText })}`),
    (x) => (!x.companyId ? 'Не е въведено име на фирма в поле Партньор!' : !x.account ? 'Не е избрана сметка, която поддържа работа с партньори!' : null),
  );
  const a = report.applied ?? f;
  const fc = a.type === 1;
  const subtitle = `Движение по сметка ${a.account} на партньор ${a.companyName}, ${periodText(a)}`;
  const headers = ['Дата на Документа', 'Тип на документа', 'Номер на документа', 'Дебит', ...(fc ? ['Дебит във валута'] : []), 'Кредит', ...(fc ? ['Кредит във валута'] : []), 'Основание', 'Забележка', 'Втора забележка', 'Дата на Контиране', 'Номер на контиране'];
  const balRow = (label: string, b: Bal): Cell[] => [label, '', '', amt(b.debit), ...(fc ? [amt(b.debitCurrency)] : []), amt(b.credit), ...(fc ? [amt(b.creditCurrency)] : [])];
  const csv = (d: Result): Cell[][] => [
    headers,
    balRow('Начално салдо', d.opening),
    ...d.rows.map((r) => [bgDate(r.documentDate), r.documentType, r.documentNumber, amt(r.debitAmount), ...(fc ? [amt(r.debitCurrencyAmount)] : []), amt(r.creditAmount), ...(fc ? [amt(r.creditCurrencyAmount)] : []), r.term, r.reference, r.optionalReference, bgDate(r.accountingDate), r.accountingNumbers]),
    balRow('Оборот', d.turnover),
    balRow('Крайно салдо', d.closing),
  ];
  const balanceLine = (label: string, b: Bal) => (
    <tr className="font-semibold">
      <td colSpan={3}>{label}</td>
      <Amt v={b.debit} />
      {fc && <Amt v={b.debitCurrency} />}
      <Amt v={b.credit} />
      {fc && <Amt v={b.creditCurrency} />}
      <td colSpan={5} />
    </tr>
  );
  return (
    <ReportFrame<Result>
      title={fc ? 'Движение по партньор - валута' : 'Движение по партньор'}
      subtitle={subtitle}
      report={report}
      isEmpty={() => false}
      status={(d) => `${d.rows.length} документа`}
      csvName={`Движение партньор_${a.account.replace(/\//g, '-')}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} />
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} filter={accFilter} className="w-56" />
          </Field>
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-56" />
          </Field>
          <Field label="Сортиране">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="w-40">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Посока">
            <Select value={f.direction} onChange={(e) => setF({ ...f, direction: Number(e.target.value) })} className="w-44">
              <option value={0}>Всички</option>
              <option value={1}>Задължения/вземания</option>
              <option value={2}>Плащания</option>
            </Select>
          </Field>
        </>
      }
      options={<ColumnFilter columns={FILTERS} column={f.filterColumn} text={f.filterText} onChange={(filterColumn, filterText) => setF({ ...f, filterColumn, filterText })} />}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              <th className="w-24">Дата на документа</th>
              <th className="w-20">Тип</th>
              <th className="w-28">Номер на документа</th>
              <th className="w-28 text-right">Дебит</th>
              {fc && <th className="w-28 text-right">Дебит във валута</th>}
              <th className="w-28 text-right">Кредит</th>
              {fc && <th className="w-28 text-right">Кредит във валута</th>}
              <th>Основание</th>
              <th>Забележка</th>
              <th>Втора забележка</th>
              <th className="w-24">Дата на контиране</th>
              <th className="w-32">Номер на контиране</th>
            </tr>
          </thead>
          <tbody>
            {balanceLine('Начално салдо', d.opening)}
            {d.rows.map((r, i) => (
              <tr key={i}>
                <td className="nowrap">{bgDate(r.documentDate)}</td>
                <td>{r.documentType}</td>
                <td className="nowrap">{r.documentNumber}</td>
                <Amt v={r.debitAmount} />
                {fc && <Amt v={r.debitCurrencyAmount} />}
                <Amt v={r.creditAmount} />
                {fc && <Amt v={r.creditCurrencyAmount} />}
                <td className="max-w-[16rem] truncate" title={r.term}>{r.term}</td>
                <td className="max-w-[10rem] truncate">{r.reference}</td>
                <td className="max-w-[10rem] truncate">{r.optionalReference}</td>
                <td className="nowrap">{bgDate(r.accountingDate)}</td>
                <td className="max-w-[10rem] truncate" title={r.accountingNumbers}>{r.accountingNumbers}</td>
              </tr>
            ))}
            {balanceLine('Оборот', d.turnover)}
            {balanceLine('Крайно салдо', d.closing)}
          </tbody>
        </table>
      )}
    </ReportFrame>
  );
}
