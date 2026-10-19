import { api, qs } from '../../api.ts';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Field, TextInput } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useSession } from '../../session.tsx';
import { AccountNumberPicker, ReportFrame, amt, useReport, useYearPeriod, type Cell, useReportFilters } from '../common.tsx';
import type { LettersResult, PartnerLetter } from './letters.ts';
import { ReportTypeSelect, Sheet, SheetPrintButton, usePartnerAccountFilter } from './shared.tsx';
import { IncrementalList } from '../../components/VirtualRows.tsx';

/**
 * Просрочени задължения (spec 05 6.7): one letter per partner with its open
 * documents whose due date is before "Към дата" (corrected D2: the end date,
 * not the server clock). Letter text as in the original Excel template.
 */
export function Overdues() {
  const period = useYearPeriod();
  const s = useSession();
  const accFilter = usePartnerAccountFilter();
  const [f, setF] = useReportFilters('overdues', { to: period.to, type: 0, companyId: null as number | null, companyName: '', account: '' });
  const report = useReport(
    'overdues',
    f,
    (x) => api.get<LettersResult>(`/reports/overdues${qs({ to: x.to, companyId: x.companyId, account: x.account })}`),
  );
  const a = report.applied ?? f;
  const fc = a.type === 1;
  const letter = (d: LettersResult, l: PartnerLetter) => <OverdueLetter key={l.company.id} d={d} l={l} fc={fc} date={s.workingDate} />;
  const csv = (d: LettersResult): Cell[][] => [
    ['Партньор', 'ЕИК', 'Документ', 'Дата', 'Тип на документа', 'Дата на падеж', 'Задължение', 'Остатък', ...(fc ? ['Валутна сума'] : []), 'Дни в просрочие', 'Основание', 'Забележка', ...(fc ? [] : ['Втора Забележка'])],
    ...d.letters.flatMap((l) => l.items.map((i) => [l.company.name, l.company.bulstat, i.documentNumber, bgDate(i.documentDate), i.documentTypeShortName, bgDate(i.dueDate), amt(i.sumAmount), amt(i.amount), ...(fc ? [amt(i.currencyAmount)] : []), i.overdueDaysText, i.term, i.reference, ...(fc ? [] : [i.optionalReference])])),
  ];
  return (
    <ReportFrame<LettersResult>
      title={fc ? 'Просрочени задължения - валута' : 'Просрочени задължения'}
      subtitle={[`Към дата: ${bgDate(a.to)}`, a.companyId && `партньор ${a.companyName}`, a.account && `сметка ${a.account}`].filter(Boolean).join(', ')}
      report={report}
      isEmpty={(d) => d.letters.length === 0}
      status={(d) => `${d.letters.length} писма`}
      csvName={`Просрочени задължения_${a.to}`}
      csv={csv}
      filters={
        <>
          <Field label="Към дата">
            <TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" required />
          </Field>
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} />
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-56" />
          </Field>
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} filter={accFilter} className="w-56" />
          </Field>
        </>
      }
      options={report.q.data && report.applied ? <SheetPrintButton label="Печат на писмата" disabled={report.q.isFetching || !report.q.data.letters.length}>{() => report.q.data!.letters.map((l) => letter(report.q.data!, l))}</SheetPrintButton> : undefined}
    >
      {(d) => <div className="bg-slate-100 py-1"><IncrementalList items={d.letters} render={(l) => letter(d, l)} step={30} /></div>}
    </ReportFrame>
  );
}

function OverdueLetter({ d, l, fc, date }: { d: LettersResult; l: PartnerLetter; fc: boolean; date: string }) {
  const me = d.myCompany;
  const c = l.company;
  return (
    <Sheet>
      <div className="flex justify-between gap-6">
        <h2 className="self-center text-[16px] font-bold">Просрочени задължения</h2>
        <table className="text-[12px]">
          <tbody>
            <tr><td colSpan={2} className="pb-1 font-semibold">На вниманието на</td></tr>
            <tr><td className="pr-3 text-slate-600">Фирма</td><td className="font-bold">{c.name}</td></tr>
            <tr><td className="pr-3 text-slate-600">Идент. №</td><td>{c.bulstat}</td></tr>
            <tr><td className="pr-3 text-slate-600">Град</td><td>{c.city}</td></tr>
            <tr><td className="pr-3 text-slate-600">Адрес</td><td>{c.address}</td></tr>
            <tr><td className="pr-3 text-slate-600">МОЛ</td><td>{c.mol}</td></tr>
            <tr><td className="pr-3 text-slate-600">Телефон</td><td>{c.phone}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="mt-6 mb-2">Уважаеми партньори,</p>
      <p className="mb-3 text-justify">С настоящото писмо най-учтиво Ви уведомяваме, че имате неплатени документи с просрочен падеж. Следва списък на неплатените документи и техните стойности.</p>
      <table className="grid-table w-full">
        <thead>
          <tr>
            <th>Документ</th>
            <th>Дата</th>
            <th>Тип на документа</th>
            <th>Дата на падеж</th>
            <th className="text-right">Задължение</th>
            <th className="text-right">Остатък</th>
            {fc && <th className="text-right">Валутна сума</th>}
            <th>Дни в просрочие</th>
            <th>Основание</th>
            <th>Забележка</th>
            {!fc && <th>Втора Забележка</th>}
          </tr>
        </thead>
        <tbody>
          {l.items.map((i, n) => (
            <tr key={n}>
              <td>{i.documentNumber}</td>
              <td className="nowrap">{bgDate(i.documentDate)}</td>
              <td>{i.documentTypeShortName}</td>
              <td className="nowrap">{bgDate(i.dueDate)}</td>
              <td className="num">{money(i.sumAmount)}</td>
              <td className="num">{money(i.amount)}</td>
              {fc && <td className="num">{money(i.currencyAmount)}</td>}
              <td className="nowrap">{i.overdueDaysText}</td>
              <td>{i.term}</td>
              <td>{i.reference}</td>
              {!fc && <td>{i.optionalReference}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4}>Общо:</td>
            <td className="num">{money(l.totalSum)}</td>
            <td className="num">{money(l.total)}</td>
            {fc && <td className="num">{money(l.totalCurrency)}</td>}
            <td colSpan={fc ? 3 : 4} />
          </tr>
        </tfoot>
      </table>
      <p className="mt-4 text-justify">Приканваме Ви да погасите задълженията си във възможно най-кратък срок и да закриете всички просрочени документи.</p>
      <p className="mt-2">За допълнителни въпроси и уточнения се свържете с нас на посочените координати:</p>
      <div className="mt-2">
        <div className="font-bold">{me.name}</div>
        {me.address && <div>{me.address}</div>}
        {me.city && <div>{me.city}</div>}
        {me.phone && <div>Тел.: {me.phone}</div>}
        {me.mol && <div>МОЛ: {me.mol}</div>}
      </div>
      <div className="mt-8 flex justify-between">
        <span>Дата: {bgDate(date)}</span>
        <span>Подпис: ..............................</span>
      </div>
    </Sheet>
  );
}
