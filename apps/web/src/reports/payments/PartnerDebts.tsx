import { Fragment, useState } from 'react';
import { api, qs } from '../../api.ts';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Checkbox, Field, Select, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { AccountNumberPicker, Amt, ReportFrame, amt, useReport, useYearPeriod, type Cell } from '../common.tsx';
import { ColumnFilter, DocumentTypeSelect, ReportTypeSelect, usePartnerAccountFilter } from './shared.tsx';

type Level = 'partner' | 'document' | 'accounting';

interface PartnerRow { companyId: number; companyName: string; companyBulstat: string; amount: string; currencyAmount: string }
interface DocRow {
  companyId: number; companyName: string; companyBulstat: string; companyBankAccount: string;
  accountingId: number; accountingNumber: string; accountingDate: string; accountNumber: string;
  documentNumber: string; documentDate: string; documentTypeShortName: string; dueDate: string;
  amount: string; sumAmount: string; currencyAmount: string; sumCurrencyAmount: string; currencyIso: string;
  term: string; reference: string; optionalReference: string;
}
interface Line { accountingId: number; accountingNumber: string; accountingDate: string; debitAccountNumber: string; creditAccountNumber: string; documentNumber: string; documentDate: string; documentTypeShortName: string; coveredAmount: string; coveredCurrencyAmount: string }
interface AccRow extends DocRow { originalAmount: string; originalCurrencyAmount: string; remainingAmount: string; companyAmount: string; companyCurrencyAmount: string; lines: Line[] }
interface Result<R> { level: Level; startDate: string; endDate: string; rows: R[]; total: string; totalCurrency: string }

const LEVELS: [Level, string][] = [['partner', 'Партньор'], ['document', 'Документ'], ['accounting', 'Контиране']];
const SORTS: Record<Level, [string, string][]> = {
  partner: [['CompanyName', 'Партньор'], ['Amount', 'Сума']],
  document: [['DocumentDate', 'Дата на документа'], ['DocumentNumber', 'Номер на документа'], ['DocumentType', 'Тип документ'], ['Amount', 'Сума']],
  accounting: [['AccountingNumber', 'Номер на контиране'], ['AccountingDate', 'Дата на контиране'], ['DocumentNumber', 'Номер на документ'], ['DocumentType', 'Тип документ'], ['Amount', 'Сума']],
};

function groupByPartner<R extends { companyId: number }>(rows: R[]) {
  const out: { id: number; rows: R[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.id === r.companyId) last.rows.push(r);
    else out.push({ id: r.companyId, rows: [r] });
  }
  return out;
}
const total = <R,>(rows: R[], pick: (r: R) => string) => Math.round(rows.reduce((a, r) => a + Number(pick(r)), 0) * 100) / 100;

/** Задължения/вземания по партньори (spec 05 6.2-6.4): three levels, standard and currency. */
export function PartnerDebts() {
  const period = useYearPeriod();
  const accFilter = usePartnerAccountFilter();
  const [f, setF] = useState({
    to: period.to, type: 0, level: 'partner' as Level, account: '', companyId: null as number | null, companyName: '',
    documentTypeId: null as number | null, documentNumber: '', sort: 'CompanyName', closed: false, expired: false, filterColumn: 'all', filterText: '',
  });
  const report = useReport('partnerDebts', f, (x) =>
    api.get<Result<PartnerRow | DocRow | AccRow>>(`/reports/partner-debts${qs({
      to: x.to, level: x.level, currency: x.type === 1, account: x.account, companyId: x.companyId,
      documentTypeId: x.level === 'partner' ? null : x.documentTypeId, documentNumber: x.level === 'partner' ? null : x.documentNumber,
      closed: x.closed, expired: !x.closed && x.expired, sort: x.sort, filterColumn: x.filterText ? x.filterColumn : null, filterText: x.filterText,
    })}`),
  );
  const a = report.applied ?? f;
  const fc = a.type === 1;
  const docLevel = f.level !== 'partner';
  const filterColumns: [string, string][] = [['all', 'Всички'], ['companyName', 'Партньор'], ['companyBulstat', 'ЕИК'], ['amount', 'Сума'],
    ...(f.type === 1 ? [['currencyAmount', 'Валутна сума'] as [string, string]] : []),
    ...(f.level === 'document' ? [['optionalReference', 'Втора забележка'] as [string, string]] : [])];
  const subtitle = [`Към дата: ${bgDate(a.to)}`, a.account && `сметка ${a.account}`, a.companyId && `партньор ${a.companyName}`, LEVELS.find((l) => l[0] === a.level)?.[1] && `ниво ${LEVELS.find((l) => l[0] === a.level)![1].toLowerCase()}`].filter(Boolean).join(', ');

  const csv = (d: Result<PartnerRow | DocRow | AccRow>): Cell[][] => {
    if (d.level === 'partner') {
      const rows = d.rows as PartnerRow[];
      return [['Партньор', 'ЕИК', 'Задължение / Вземане', ...(fc ? ['Валутна сума'] : [])], ...rows.map((r) => [r.companyName, r.companyBulstat, amt(r.amount), ...(fc ? [amt(r.currencyAmount)] : [])]), ['Общо:', '', amt(d.total), ...(fc ? [amt(d.totalCurrency)] : [])]];
    }
    if (d.level === 'document') {
      const rows = d.rows as DocRow[];
      return [
        ['Партньор', 'ЕИК', 'Тип док.', 'Номер на док.', 'Дата на док.', 'Сума', ...(fc ? ['Валутна сума', 'Валута'] : []), 'Контиране номер', 'Основание', 'Забележка', 'Обща сума', 'Дата на падеж', 'IBAN на партньора'],
        ...rows.map((r) => [r.companyName, r.companyBulstat, r.documentTypeShortName, r.documentNumber, bgDate(r.documentDate), amt(r.amount), ...(fc ? [amt(r.currencyAmount), r.currencyIso] : []), r.accountingNumber, r.term, r.reference, amt(r.sumAmount), bgDate(r.dueDate), r.companyBankAccount]),
        ['Общо:', '', '', '', '', amt(d.total), ...(fc ? [amt(d.totalCurrency), ''] : [])],
      ];
    }
    const rows = d.rows as AccRow[];
    const out: Cell[][] = [['Партньор', 'ЕИК', 'Тип док.', 'Документ №', 'Дата', 'Сума на документа', 'Остатък', 'Контиране №', 'Дата на контиране', 'Сметка дебит', 'Сметка кредит', 'Документ №', 'Покрита сума', 'Салдо на партньора']];
    for (const r of rows) {
      out.push([r.companyName, r.companyBulstat, r.documentTypeShortName, r.documentNumber, bgDate(r.documentDate), amt(r.originalAmount), amt(r.remainingAmount), r.accountingNumber, bgDate(r.accountingDate), '', '', '', '', amt(r.companyAmount)]);
      for (const l of r.lines) out.push(['', '', '', '', '', '', '', l.accountingNumber, bgDate(l.accountingDate), l.debitAccountNumber, l.creditAccountNumber, l.documentNumber, amt(l.coveredAmount), '']);
    }
    out.push(['Общо:', '', '', '', '', '', '', '', '', '', '', '', '', amt(d.total)]);
    return out;
  };

  return (
    <ReportFrame<Result<PartnerRow | DocRow | AccRow>>
      title="Задължения/вземания по партньори"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} реда`}
      csvName={`Задължения вземания_${a.level}_${a.to}`}
      csv={csv}
      filters={
        <>
          <Field label="Към дата">
            <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" required />
          </Field>
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} />
          <Field label="Ниво на справка">
            <Select value={f.level} onChange={(e) => { const level = e.target.value as Level; setF({ ...f, level, sort: SORTS[level][0]![0] }); }} className="w-32">
              {LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Опорна сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} filter={accFilter} className="w-56" />
          </Field>
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-56" />
          </Field>
          <DocumentTypeSelect value={f.documentTypeId} onChange={(documentTypeId) => setF({ ...f, documentTypeId })} disabled={!docLevel} />
          <Field label="Документ №">
            <TextInput value={f.documentNumber} disabled={!docLevel} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} className="w-28" />
          </Field>
          <Field label="Сортиране">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="w-40">
              {SORTS[f.level].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </>
      }
      options={
        <>
          <Checkbox label="Показване на закрити документи" checked={f.closed} onChange={(closed) => setF({ ...f, closed })} />
          <Checkbox label="Показване на документи с изтекъл срок на падеж" checked={f.expired && !f.closed} disabled={f.closed} onChange={(expired) => setF({ ...f, expired })} />
          <ColumnFilter columns={filterColumns} column={f.filterColumn} text={f.filterText} onChange={(filterColumn, filterText) => setF({ ...f, filterColumn, filterText })} />
        </>
      }
    >
      {(d) => (d.level === 'partner' ? <PartnerTable d={d as Result<PartnerRow>} fc={fc} /> : d.level === 'document' ? <DocumentTable d={d as Result<DocRow>} fc={fc} /> : <AccountingTable d={d as Result<AccRow>} fc={fc} />)}
    </ReportFrame>
  );
}

function PartnerTable({ d, fc }: { d: Result<PartnerRow>; fc: boolean }) {
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th>Партньор</th>
          <th className="w-36">ЕИК</th>
          <th className="w-40 text-right">Задължение / Вземане</th>
          {fc && <th className="w-36 text-right">Валутна сума</th>}
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <tr key={r.companyId}>
            <td className="max-w-[30rem] truncate" title={r.companyName}>{r.companyName}</td>
            <td className="nowrap">{r.companyBulstat}</td>
            <Amt v={r.amount} />
            {fc && <Amt v={r.currencyAmount} />}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={2}>Общо:</td>
          <Amt v={d.total} />
          {fc && <Amt v={d.totalCurrency} />}
        </tr>
      </tfoot>
    </table>
  );
}

function DocumentTable({ d, fc }: { d: Result<DocRow>; fc: boolean }) {
  const cols = fc ? 12 : 10;
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th className="w-20">Тип док.</th>
          <th className="w-28">Номер на док.</th>
          <th className="w-24">Дата на док.</th>
          <th className="w-28 text-right">Сума</th>
          {fc && <th className="w-28 text-right">Валутна сума</th>}
          {fc && <th className="w-14">Валута</th>}
          <th className="w-28">Контиране номер</th>
          <th>Основание</th>
          <th>Забележка</th>
          <th className="w-28 text-right">Обща сума</th>
          <th className="w-24">Дата на падеж</th>
          <th className="w-56">IBAN на партньора</th>
        </tr>
      </thead>
      <tbody>
        {groupByPartner(d.rows).map((g) => (
          <Fragment key={g.id}>
            <tr className="grp">
              <td colSpan={cols}>{g.rows[0]!.companyName}{g.rows[0]!.companyBulstat ? `, ЕИК ${g.rows[0]!.companyBulstat}` : ''}</td>
            </tr>
            {g.rows.map((r) => (
              <tr key={`${r.accountingId}-${r.accountNumber}`}>
                <td>{r.documentTypeShortName}</td>
                <td className="nowrap">{r.documentNumber}</td>
                <td className="nowrap">{bgDate(r.documentDate)}</td>
                <Amt v={r.amount} />
                {fc && <Amt v={r.currencyAmount} />}
                {fc && <td>{r.currencyIso}</td>}
                <td className="nowrap">{r.accountingNumber}</td>
                <td className="max-w-[16rem] truncate" title={r.term}>{r.term}</td>
                <td className="max-w-[12rem] truncate" title={r.reference}>{r.reference}</td>
                <Amt v={r.sumAmount} />
                <td className="nowrap">{bgDate(r.dueDate)}</td>
                <td className="nowrap">{r.companyBankAccount}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="text-right font-semibold">Общо за партньора:</td>
              <Amt v={total(g.rows, (r) => r.amount)} className="font-semibold" />
              {fc && <Amt v={total(g.rows, (r) => r.currencyAmount)} className="font-semibold" />}
              <td colSpan={fc ? 7 : 6} />
            </tr>
          </Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3}>Общо:</td>
          <Amt v={d.total} />
          {fc && <Amt v={d.totalCurrency} />}
          <td colSpan={fc ? 7 : 6} />
        </tr>
      </tfoot>
    </table>
  );
}

function AccountingTable({ d, fc }: { d: Result<AccRow>; fc: boolean }) {
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th className="w-28">Контиране №</th>
          <th className="w-24">Дата</th>
          <th className="w-20">Сметка Дт</th>
          <th className="w-20">Сметка Кт</th>
          <th className="w-20">Тип док.</th>
          <th className="w-28">Документ №</th>
          <th className="w-24">Дата на док.</th>
          <th className="w-28 text-right">Сума на документа</th>
          {fc && <th className="w-28 text-right">Валутна сума</th>}
          <th className="w-28 text-right">Покрита сума</th>
          <th className="w-28 text-right">Остатък</th>
        </tr>
      </thead>
      <tbody>
        {groupByPartner(d.rows).map((g) => (
          <Fragment key={g.id}>
            <tr className="grp">
              <td colSpan={fc ? 8 : 7}>{g.rows[0]!.companyName}{g.rows[0]!.companyBulstat ? `, ЕИК ${g.rows[0]!.companyBulstat}` : ''}</td>
              <td colSpan={3} className="num">Салдо: {money(g.rows[0]!.companyAmount)}</td>
            </tr>
            {g.rows.map((r) => (
              <Fragment key={`${r.accountingId}-${r.accountNumber}`}>
                <tr className="font-semibold">
                  <td className="nowrap">{r.accountingNumber}</td>
                  <td className="nowrap">{bgDate(r.accountingDate)}</td>
                  <td colSpan={2}>{r.accountNumber}</td>
                  <td>{r.documentTypeShortName}</td>
                  <td className="nowrap">{r.documentNumber}</td>
                  <td className="nowrap">{bgDate(r.documentDate)}</td>
                  <Amt v={r.originalAmount} />
                  {fc && <Amt v={r.originalCurrencyAmount} />}
                  <td />
                  <Amt v={r.remainingAmount} />
                </tr>
                {r.lines.map((l) => (
                  <tr key={l.accountingId} className="text-slate-700">
                    <td className="nowrap pl-4">{l.accountingNumber}</td>
                    <td className="nowrap">{bgDate(l.accountingDate)}</td>
                    <td>{l.debitAccountNumber}</td>
                    <td>{l.creditAccountNumber}</td>
                    <td>{l.documentTypeShortName}</td>
                    <td className="nowrap">{l.documentNumber}</td>
                    <td className="nowrap">{bgDate(l.documentDate)}</td>
                    <td />
                    {fc && <Amt v={l.coveredCurrencyAmount} />}
                    <Amt v={l.coveredAmount} />
                    <td />
                  </tr>
                ))}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={fc ? 10 : 9}>Общо:</td>
          <Amt v={d.total} />
        </tr>
      </tfoot>
    </table>
  );
}
