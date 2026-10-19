import { useState } from 'react';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { PartnerMultiPicker, type PickedPartner } from '../components/pickers.tsx';
import { Checkbox, Field, Select } from '../components/ui.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import { ANALYTICAL_SORT, JOURNAL_REPORT_TYPES, analyticalFilterColumns, qtyText, rateText, type JournalLine, type JournalReportType } from './Chronological.tsx';
import { VirtualRows } from '../components/VirtualRows.tsx';
import { ColumnFilter } from './payments/shared.tsx';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useReportFilters, useYearPeriod, type Cell } from './common.tsx';

interface Balances {
  openingDebit: string;
  openingCredit: string;
  debitTurnover: string;
  creditTurnover: string;
  closingDebit: string;
  closingCredit: string;
}
interface Line extends JournalLine {
  balanceDebit: string;
  balanceCredit: string;
}
interface Result {
  reportType: JournalReportType;
  accountDescription: string;
  opening: Balances;
  lines: Line[];
  turnover: { debit: string; credit: string };
  closing: { debit: string; credit: string };
  currencyTotals: { debit: string; credit: string };
  quantityTotals: { debit: string; credit: string };
}

const TITLE: Record<JournalReportType, string> = { standard: 'Аналитичен регистър', currency: 'Валутен аналитичен регистър', quantity: 'Материален аналитичен регистър' };
const SHORT: Record<JournalReportType, string> = { standard: 'АРег', currency: 'АРег валутен', quantity: 'АРег СМЗ' };

/** Аналитичен регистър / карта на сметка (spec 05 4.2): standard (running balance), currency and materials layouts. */
export function Analytical() {
  const ws = useWorkspace();
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('analytical', {
    ...period, type: 'standard' as JournalReportType, account: '', withSub: true, byExportMonth: false,
    partners: [] as PickedPartner[], sort: 'AccountingDate', filterColumn: '', text: '',
  });
  const [sel, setSel] = useState<number | null>(null);
  const report = useReport(
    'analytical',
    f,
    (x) => api.get<Result>(`/reports/analytical${qs({
      from: x.from, to: x.to, account: x.account, type: x.type === 'standard' ? undefined : x.type, sub: x.withSub ? undefined : '0', byExportMonth: x.byExportMonth,
      companyId: x.partners.map((p) => p.id).join(','), sort: x.sort, filterColumn: x.filterColumn, text: x.text.trim(),
    })}`),
    (x) => (x.account ? (x.from > x.to ? 'Началната дата е след крайната дата.' : null) : 'Не е избрана сметка.'),
  );
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.withSub ? 'с подсметките' : 'без подсметките', a.partners.length > 0 && `партньор ${a.partners.map((p) => p.name).join(', ')}`].filter(Boolean).join(', ');
  const open = (l: Line) => ws.open('entry', { key: `entry:${l.accountingId}`, title: `Контиране ${l.number}`, params: { id: l.accountingId } });
  const cur = a.type === 'currency';
  const mat = a.type === 'quantity';
  const std = !cur && !mat;
  const extraHead = cur ? ['Вал. сума дебит', 'Вал. курс дебит', 'Вал. сума кредит', 'Вал. курс кредит'] : mat ? ['Количество дебит', 'Ед. цена дебит', 'Количество кредит', 'Ед. цена кредит'] : ['Салдо Дебит', 'Салдо Кредит'];
  const extraCells = (l: Line): Cell[] => (cur
    ? [amt(l.debitCurrencyAmount), rateText(l.debitExchangeRate), amt(l.creditCurrencyAmount), rateText(l.creditExchangeRate)]
    : mat ? [qtyText(l.debitQuantity), qtyText(l.debitPrice), qtyText(l.creditQuantity), qtyText(l.creditPrice)] : [amt(l.balanceDebit), amt(l.balanceCredit)]);

  const csv = (d: Result): Cell[][] => [
    [`Сметка ${a.account} ${d.accountDescription}`],
    [],
    ['Контиране', 'Дата', 'Дебит сметка', 'Дебит', 'Кредит сметка', 'Кредит', 'Сума', ...extraHead, 'Партньор', 'Док. вид', 'Док. дата', 'Документ №', 'Основание', 'Забележка', 'Втора забележка'],
    ['Начално салдо', '', '', '', '', '', '', ...(std ? [amt(d.opening.openingDebit), amt(d.opening.openingCredit)] : [amt(d.opening.openingDebit), '', amt(d.opening.openingCredit), ''])],
    ...d.lines.map((l) => [l.number, bgDate(l.accountingDate), l.debitAccount, l.debitDescription, l.creditAccount, l.creditDescription, amt(l.amount), ...extraCells(l), l.companyName, l.documentType, bgDate(l.documentDate), l.documentNumber, l.term, l.reference, l.optionalReference]),
    ...(cur ? [['Всичко валута', '', '', '', '', '', '', amt(d.currencyTotals.debit), '', amt(d.currencyTotals.credit), '']] : mat ? [['Всичко количество', '', '', '', '', '', '', qtyText(d.quantityTotals.debit), '', qtyText(d.quantityTotals.credit), '']] : []),
    ['Оборот', '', '', '', '', '', '', ...(std ? [amt(d.turnover.debit), amt(d.turnover.credit)] : [amt(d.turnover.debit), '', amt(d.turnover.credit), ''])],
    ['Крайно салдо', '', '', '', '', '', '', ...(std ? [amt(d.closing.debit), amt(d.closing.credit)] : [amt(d.closing.debit), '', amt(d.closing.credit), ''])],
  ];

  // Footer cells under the type's own columns: standard = the balance pair, currency / materials = the debit and credit columns of the pair groups.
  const pair = (debit: string, credit: string, qty = false) => (std
    ? <><Amt v={debit} /><Amt v={credit} /></>
    : <><td className="num">{qty ? qtyText(debit) : money(debit)}</td><td /><td className="num">{qty ? qtyText(credit) : money(credit)}</td><td /></>);
  const tail = 6;

  return (
    <ReportFrame<Result>
      title={TITLE[a.type]}
      logEntity="analyticalReport"
      subtitle={subtitle}
      report={report}
      // The card is meaningful even without movements (opening balance only).
      isEmpty={() => false}
      status={(d) => `${d.lines.length} записа`}
      csvName={`${SHORT[a.type]}_${a.account.replace(/\//g, '-')}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Тип справка">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as JournalReportType, filterColumn: '' })} className="w-32" aria-label="Тип справка">
              {JOURNAL_REPORT_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Сметка *">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-72" />
          </Field>
          <Checkbox className="mb-1.5" label="С подсметките" checked={f.withSub} onChange={(withSub) => setF({ ...f, withSub })} />
          <Field label="Партньор">
            <PartnerMultiPicker value={f.partners} onChange={(partners) => setF({ ...f, partners })} />
          </Field>
          <Field label="Сортиране">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="w-40" aria-label="Сортиране">
              {ANALYTICAL_SORT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <ColumnFilter columns={analyticalFilterColumns(f.type)} column={f.filterColumn} text={f.text} onChange={(filterColumn, text) => setF({ ...f, filterColumn, text })} />
        </>
      }
      options={<Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />}
    >
      {(d) => (
        <>
          <div className="border-b border-slate-200 bg-white px-3 py-1.5 text-[13px]">
            Сметка <span className="font-semibold">{a.account}</span> {d.accountDescription}
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th>Контиране</th>
                <th>Дата</th>
                <th>Дебит</th>
                <th>Кредит</th>
                <th className="text-right">Сума</th>
                {extraHead.map((h) => <th key={h} className="text-right">{h}</th>)}
                <th>Партньор</th>
                <th>Документ</th>
                <th>№ док.</th>
                <th>Дата док.</th>
                <th>Основание</th>
                <th>Забележка</th>
              </tr>
            </thead>
            <tbody>
              <tr className="grp">
                <td colSpan={5}>Начално салдо</td>
                {pair(d.opening.openingDebit, d.opening.openingCredit)}
                <td colSpan={tail} />
              </tr>
              <VirtualRows count={d.lines.length} colSpan={5 + extraHead.length + tail} row={(i) => {
                const l = d.lines[i]!;
                return (
                <tr key={l.detailId} aria-selected={sel === l.detailId} onClick={() => setSel(l.detailId)} onDoubleClick={() => open(l)} className="cursor-default">
                  <td className="font-medium">{l.number}</td>
                  <td className="nowrap">{bgDate(l.accountingDate)}</td>
                  <td className="nowrap" title={l.debitDescription}>{l.debitAccount}</td>
                  <td className="nowrap" title={l.creditDescription}>{l.creditAccount}</td>
                  <td className="num">{money(l.amount)}</td>
                  {std && (
                    <>
                      <Amt v={l.balanceDebit} />
                      <Amt v={l.balanceCredit} />
                    </>
                  )}
                  {cur && (
                    <>
                      <td className="num" title={l.debitCurrency}>{l.debitCurrencyAmount ? `${money(l.debitCurrencyAmount)} ${l.debitCurrency}` : ''}</td>
                      <td className="num">{rateText(l.debitExchangeRate)}</td>
                      <td className="num" title={l.creditCurrency}>{l.creditCurrencyAmount ? `${money(l.creditCurrencyAmount)} ${l.creditCurrency}` : ''}</td>
                      <td className="num">{rateText(l.creditExchangeRate)}</td>
                    </>
                  )}
                  {mat && (
                    <>
                      <td className="num">{qtyText(l.debitQuantity)}</td>
                      <td className="num">{qtyText(l.debitPrice)}</td>
                      <td className="num">{qtyText(l.creditQuantity)}</td>
                      <td className="num">{qtyText(l.creditPrice)}</td>
                    </>
                  )}
                  <td className="max-w-56 truncate">{l.companyName}</td>
                  <td>{l.documentType}</td>
                  <td>{l.documentNumber}</td>
                  <td className="nowrap">{bgDate(l.documentDate)}</td>
                  <td className="max-w-72 truncate" title={l.term}>{l.term}</td>
                  <td className="max-w-48 truncate" title={[l.reference, l.optionalReference].filter(Boolean).join(' / ')}>{l.reference}</td>
                </tr>
                );
              }} />
            </tbody>
            <tfoot>
              {(cur || mat) && (
                <tr className="ft2">
                  <td colSpan={5}>{cur ? 'Всичко валута' : 'Всичко количество'}</td>
                  {cur ? pair(d.currencyTotals.debit, d.currencyTotals.credit) : pair(d.quantityTotals.debit, d.quantityTotals.credit, true)}
                  <td colSpan={tail} />
                </tr>
              )}
              <tr className="ft1">
                <td colSpan={5}>Оборот</td>
                {pair(d.turnover.debit, d.turnover.credit)}
                <td colSpan={tail} />
              </tr>
              <tr className="ft1">
                <td colSpan={5}>Крайно салдо</td>
                {pair(d.closing.debit, d.closing.credit)}
                <td colSpan={tail} />
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </ReportFrame>
  );
}
