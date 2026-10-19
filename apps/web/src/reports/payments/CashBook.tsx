import { api, qs } from '../../api.ts';
import { Checkbox, Field, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell, useReportFilters } from '../common.tsx';
import { CashAccountSelect, ReportTypeSelect } from './shared.tsx';

interface Row {
  accountingId: number; accountingNumber: string; documentDate: string; documentType: string; documentNumber: string; term: string; companyName: string;
  incomeAmount: string; incomeAccount: string; incomeCurrencyAmount: string; incomeExchangeRate: string;
  expenseAmount: string; expenseAccount: string; expenseCurrencyAmount: string; expenseExchangeRate: string;
  balance: string; currencyBalance: string;
}
interface Balances {
  openingDebit: string; openingCredit: string; debitTurnover: string; creditTurnover: string; closingDebit: string; closingCredit: string;
  openingDebitCurrency: string; openingCreditCurrency: string; debitTurnoverCurrency: string; creditTurnoverCurrency: string; closingDebitCurrency: string; closingCreditCurrency: string;
}
interface Result { myCompanyName: string; accountDescription: string; accountCurrency: string; balances: Balances; rows: Row[]; totals: { income: string; expense: string; incomeCurrency: string; expenseCurrency: string } }

const net = (d: string, c: string) => Math.round((Number(d) - Number(c)) * 100) / 100;
const rate = (v: string) => (v ? Number(v).toFixed(5) : '');

/** Касова книга (spec 05 6.8): cash receipts and payments by document with opening, turnover and closing. */
export function CashBook() {
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('cashBook', { ...period, type: 0, account: '501', sub: false, companyName: '' });
  const report = useReport('cashBook', f, (x) => api.get<Result>(`/reports/cash-book${qs({ from: x.from, to: x.to, account: x.account, sub: x.sub, companyName: x.companyName })}`), (x) => (x.account ? null : 'Не е избрана сметка.'));
  const a = report.applied ?? f;
  const fc = a.type === 1;
  const headers = fc
    ? ['Дата', 'Тип документ', 'Документ №', 'Основание', 'Партньор', 'Приход валута', 'Курс', 'Приход', 'Кор. сметка', 'Разход валута', 'Курс', 'Разход', 'Кор. сметка', 'Наличност валута', 'Наличност']
    : ['Дата', 'Тип документ', 'Документ №', 'Основание', 'Партньор', 'Приход', 'Кор. сметка', 'Разход', 'Кор. сметка', 'Наличност'];
  const csv = (d: Result): Cell[][] => {
    const b = d.balances;
    const line = (label: string, inc: string, incC: string, exp: string, expC: string, bal: Cell, balC: Cell): Cell[] => fc
      ? [label, '', '', '', '', amt(incC), '', amt(inc), '', amt(expC), '', amt(exp), '', balC, bal]
      : [label, '', '', '', '', amt(inc), '', amt(exp), '', bal];
    return [
      headers,
      line('Начално салдо', '', '', '', '', net(b.openingDebit, b.openingCredit), net(b.openingDebitCurrency, b.openingCreditCurrency)),
      ...d.rows.map((r): Cell[] => fc
        ? [bgDate(r.documentDate), r.documentType, r.documentNumber, r.term, r.companyName, amt(r.incomeCurrencyAmount), rate(r.incomeExchangeRate), amt(r.incomeAmount), r.incomeAccount, amt(r.expenseCurrencyAmount), rate(r.expenseExchangeRate), amt(r.expenseAmount), r.expenseAccount, amt(r.currencyBalance), amt(r.balance)]
        : [bgDate(r.documentDate), r.documentType, r.documentNumber, r.term, r.companyName, amt(r.incomeAmount), r.incomeAccount, amt(r.expenseAmount), r.expenseAccount, amt(r.balance)]),
      line('Оборот', b.debitTurnover, b.debitTurnoverCurrency, b.creditTurnover, b.creditTurnoverCurrency, '', ''),
      line('Крайно салдо', '', '', '', '', net(b.closingDebit, b.closingCredit), net(b.closingDebitCurrency, b.closingCreditCurrency)),
    ];
  };
  return (
    <ReportFrame<Result>
      title={fc ? 'Касова книга валутна' : 'Касова книга'}
      subtitle={`${periodText(a)}, каса ${a.account}${a.sub ? ' с подсметките' : ''}${a.companyName ? `, партньор ${a.companyName}` : ''}`}
      report={report}
      isEmpty={() => false}
      status={(d) => `${d.rows.length} реда`}
      csvName={`Касова книга_${a.account.replace(/\//g, '-')}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} />
          <Field label="Сметка">
            <CashAccountSelect value={f.account} onChange={(account) => setF({ ...f, account })} />
          </Field>
          <Field label="Партньор">
            <TextInput value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} className="w-56" />
          </Field>
        </>
      }
      options={<Checkbox label="С подсметките" checked={f.sub} onChange={(sub) => setF({ ...f, sub })} />}
    >
      {(d) => {
        const b = d.balances;
        const span = 5;
        return (
          <>
            <div className="px-3 py-1 text-[12px] text-slate-600">
              Сметка {a.account} {d.accountDescription}{d.accountCurrency ? `, валута ${d.accountCurrency}` : ''}
            </div>
            <table className="grid-table">
              <thead>
                <tr>
                  {headers.map((h, i) => <th key={i} className={/Приход|Разход|Наличност|Курс/.test(h) ? 'w-28 text-right' : undefined}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr className="font-semibold">
                  <td colSpan={span}>Начално салдо</td>
                  <td colSpan={fc ? 8 : 4} />
                  {fc && <Amt v={net(b.openingDebitCurrency, b.openingCreditCurrency)} />}
                  <Amt v={net(b.openingDebit, b.openingCredit)} />
                </tr>
                {d.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap">{bgDate(r.documentDate)}</td>
                    <td>{r.documentType}</td>
                    <td className="nowrap">{r.documentNumber}</td>
                    <td className="max-w-[16rem] truncate" title={r.term}>{r.term}</td>
                    <td className="max-w-[14rem] truncate" title={r.companyName}>{r.companyName}</td>
                    {fc && <Amt v={r.incomeCurrencyAmount} />}
                    {fc && <td className="num">{rate(r.incomeExchangeRate)}</td>}
                    <Amt v={r.incomeAmount} />
                    <td className="nowrap">{r.incomeAccount}</td>
                    {fc && <Amt v={r.expenseCurrencyAmount} />}
                    {fc && <td className="num">{rate(r.expenseExchangeRate)}</td>}
                    <Amt v={r.expenseAmount} />
                    <td className="nowrap">{r.expenseAccount}</td>
                    {fc && <td className="num">{money(r.currencyBalance)}</td>}
                    <td className="num">{money(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ft1">
                  <td colSpan={span}>Оборот</td>
                  {fc && <Amt v={b.debitTurnoverCurrency} />}
                  {fc && <td />}
                  <Amt v={b.debitTurnover} />
                  <td />
                  {fc && <Amt v={b.creditTurnoverCurrency} />}
                  {fc && <td />}
                  <Amt v={b.creditTurnover} />
                  <td colSpan={fc ? 3 : 2} />
                </tr>
                <tr className="ft1">
                  <td colSpan={span}>Крайно салдо</td>
                  <td colSpan={fc ? 8 : 4} />
                  {fc && <Amt v={net(b.closingDebitCurrency, b.closingCreditCurrency)} />}
                  <Amt v={net(b.closingDebit, b.closingCredit)} />
                </tr>
              </tfoot>
            </table>
          </>
        );
      }}
    </ReportFrame>
  );
}
