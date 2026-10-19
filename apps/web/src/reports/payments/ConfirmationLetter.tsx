import { api, qs } from '../../api.ts';
import { Field, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useSession } from '../../session.tsx';
import { ReportFrame, amt, useReport, useYearPeriod, type Cell, useReportFilters } from '../common.tsx';
import { baseCurrencyWord, type LettersResult, type PartnerLetter } from './letters.ts';
import { ReportTypeSelect, Sheet, SheetPrintButton } from './shared.tsx';

/**
 * Потвърдително писмо за задължения/вземания (spec 05 6.5): one letter per
 * partner with its open documents (signed: receivable +, payable -), sent under
 * чл. 22 ЗСч at the year-end closing. The original letter text is not
 * recoverable (U); this wording follows the report description.
 */
export function ConfirmationLetter() {
  const period = useYearPeriod();
  const s = useSession();
  const [f, setF] = useReportFilters('confirmationLetter', { to: period.to, type: 0, companyName: '', minSum: '' });
  const report = useReport(
    'confirmationLetter',
    f,
    (x) => api.get<LettersResult>(`/reports/confirmation-letter${qs({ to: x.to, companyName: x.companyName, minSum: x.minSum.replace(',', '.') })}`),
    (x) => (x.minSum && (Number.isNaN(Number(x.minSum.replace(',', '.'))) || Number(x.minSum.replace(',', '.')) < 0) ? 'Невалидна минимална сума.' : null),
  );
  const a = report.applied ?? f;
  const fc = a.type === 1;
  const letter = (d: LettersResult, l: PartnerLetter) => <Letter key={l.company.id} d={d} l={l} fc={fc} applicationDate={s.workingDate} />;
  const csv = (d: LettersResult): Cell[][] => [
    ['Партньор', 'ЕИК', 'Тип документ', 'Документ №', 'Дата', 'Сума', ...(fc ? ['Валутна сума', 'Валута'] : [])],
    ...d.letters.flatMap((l) => l.items.map((i) => [l.company.name, l.company.bulstat, i.documentTypeShortName, i.documentNumber, bgDate(i.documentDate), amt(i.amount), ...(fc ? [amt(i.currencyAmount), i.currencyIso] : [])])),
  ];
  return (
    <ReportFrame<LettersResult>
      title={fc ? 'Потвърдително писмо валута' : 'Потвърдително писмо за задължения/вземания'}
      subtitle={`Към дата: ${bgDate(a.to)}`}
      report={report}
      isEmpty={(d) => d.letters.length === 0}
      // One letter: the e-mail goes to that partner.
      emailPartnerId={(d) => (d.letters.length === 1 ? d.letters[0]!.company.id : null)}
      status={(d) => `${d.letters.length} писма`}
      csvName={`${fc ? 'Потвърдително писмо валута' : 'Потвърдително писмо'}_${a.to}`}
      csv={csv}
      filters={
        <>
          <Field label="Към дата">
            <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" required />
          </Field>
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} />
          <Field label="Партньор">
            <TextInput value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} className="w-56" placeholder="име или част от него" />
          </Field>
          <Field label="Минимална сума">
            <TextInput value={f.minSum} onChange={(e) => setF({ ...f, minSum: e.target.value })} className="w-28 text-right" />
          </Field>
        </>
      }
      options={report.q.data && report.applied ? <SheetPrintButton label="Печат на писмата" disabled={report.q.isFetching || !report.q.data.letters.length}>{() => report.q.data!.letters.map((l) => letter(report.q.data!, l))}</SheetPrintButton> : undefined}
    >
      {(d) => <div className="bg-slate-100 py-1">{d.letters.map((l) => letter(d, l))}</div>}
    </ReportFrame>
  );
}

function Letter({ d, l, fc, applicationDate }: { d: LettersResult; l: PartnerLetter; fc: boolean; applicationDate: string }) {
  const me = d.myCompany;
  const cur = baseCurrencyWord(d.endDate);
  const total = Number(l.total);
  return (
    <Sheet>
      <div className="flex justify-between gap-6">
        <div>
          <div className="font-bold">{me.name}</div>
          {me.bulstat && <div>ЕИК: {me.bulstat}</div>}
          {(me.city || me.address) && <div>{[me.city, me.address].filter(Boolean).join(', ')}</div>}
          {me.phone && <div>Тел.: {me.phone}</div>}
        </div>
        <div className="min-w-[45%]">
          <div>До: <span className="font-bold">{l.company.name}</span></div>
          {l.company.bulstat && <div>ЕИК: {l.company.bulstat}</div>}
          {(l.company.city || l.company.address) && <div>{[l.company.postalCode, l.company.city, l.company.address].filter(Boolean).join(', ')}</div>}
          {l.company.mol && <div>На вниманието на: {l.company.mol}</div>}
        </div>
      </div>
      <h2 className="mt-8 mb-4 text-center text-[15px] font-bold">ПОТВЪРДИТЕЛНО ПИСМО</h2>
      <p className="mb-2">Уважаеми партньори,</p>
      <p className="mb-3 text-justify">
        На основание чл. 22 от Закона за счетоводството, във връзка с годишното приключване, Ви молим да потвърдите салдото на взаимните ни разчети към {bgDate(d.endDate)} г.
        Според нашите счетоводни данни {total >= 0 ? 'Вие ни дължите' : 'ние Ви дължим'} {money(Math.abs(total))} {cur}, формирани от следните документи:
      </p>
      <table className="grid-table w-full">
        <thead>
          <tr>
            <th>Тип документ</th>
            <th>Документ №</th>
            <th>Дата</th>
            <th className="text-right">Сума</th>
            {fc && <th className="text-right">Валутна сума</th>}
            {fc && <th>Валута</th>}
          </tr>
        </thead>
        <tbody>
          {l.items.map((i, n) => (
            <tr key={n}>
              <td>{i.documentTypeShortName || (i.documentNumber ? '' : 'Начално салдо')}</td>
              <td>{i.documentNumber}</td>
              <td>{bgDate(i.documentDate)}</td>
              <td className="num">{money(i.amount)}</td>
              {fc && <td className="num">{money(i.currencyAmount)}</td>}
              {fc && <td>{i.currencyIso}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Общо:</td>
            <td className="num">{money(l.total)}</td>
            {fc && <td className="num">{money(l.totalCurrency)}</td>}
            {fc && <td />}
          </tr>
        </tfoot>
      </table>
      <p className="mt-2 text-[11px] text-slate-600">Положителните суми са вземания на {me.name} от Вас, отрицателните - задължения на {me.name} към Вас.</p>
      <p className="mt-4 text-justify">Моля, потвърдете посоченото салдо или посочете различията, като върнете подписан екземпляр от настоящото писмо.</p>
      <div className="mt-8 flex justify-between">
        <div>
          <div>Дата: {bgDate(applicationDate)}</div>
          <div className="mt-6">Управител: ..............................{me.mol && ` (${me.mol})`}</div>
          <div className="mt-4">Гл. счетоводител: ..............................{me.accountant && ` (${me.accountant})`}</div>
        </div>
      </div>
      <div className="mt-10 border-t border-dashed border-slate-400 pt-4">
        <div className="mb-2 font-bold">Отговор на {l.company.name}</div>
        <div>□ Потвърждаваме посоченото салдо към {bgDate(d.endDate)} г.</div>
        <div className="mt-2">□ Не потвърждаваме салдото. Според нашите данни то е: ..............................</div>
        <div className="mt-6 flex justify-between">
          <span>Дата: ....................</span>
          <span>Подпис и печат: ..............................</span>
        </div>
      </div>
    </Sheet>
  );
}
