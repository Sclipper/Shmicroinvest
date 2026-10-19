import { useState } from 'react';
import { formatMoney } from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { PartnerMultiPicker, type PickedPartner } from '../components/pickers.tsx';
import { Checkbox, Field, Select, TextInput } from '../components/ui.tsx';
import { useLookups } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import { VirtualRows } from '../components/VirtualRows.tsx';
import { ColumnFilter } from './payments/shared.tsx';
import { AccountNumberPicker, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useReportFilters, useYearPeriod, type Cell } from './common.tsx';

export interface JournalLine {
  detailId: number;
  accountingId: number;
  number: string;
  accountingDate: string;
  viesMonth: string;
  debitAccount: string;
  debitDescription: string;
  debitEnglishDescription: string;
  creditAccount: string;
  creditDescription: string;
  creditEnglishDescription: string;
  amount: string;
  debitCurrency: string;
  debitCurrencyAmount: string | null;
  debitExchangeRate: string | null;
  creditCurrency: string;
  creditCurrencyAmount: string | null;
  creditExchangeRate: string | null;
  debitQuantity: string | null;
  debitPrice: string | null;
  creditQuantity: string | null;
  creditPrice: string | null;
  companyName: string;
  companyVat: string;
  documentType: string;
  documentDate: string;
  documentNumber: string;
  term: string;
  reference: string;
  optionalReference: string;
  paragraph: string;
  vatTerm: string;
  userName: string;
}

/** "Тип справка": Стандартна / Валутна / Материална (05 4.2, 5.1). */
export type JournalReportType = 'standard' | 'currency' | 'quantity';
export const JOURNAL_REPORT_TYPES: [JournalReportType, string][] = [['standard', 'Стандартна'], ['currency', 'Валутна'], ['quantity', 'Материална']];

const CURRENCY_FILTERS: [string, string][] = [['DebitCurrencyAmount', 'Вал. сума дебит'], ['DebitExchangeRate', 'Вал. курс дебит'], ['CreditCurrencyAmount', 'Вал. сума кредит'], ['CreditExchangeRate', 'Вал. курс кредит']];
const QUANTITY_FILTERS: [string, string][] = [['DebitQuantity', 'Количество дебит'], ['DebitPrice', 'Ед. цена дебит'], ['CreditQuantity', 'Количество кредит'], ['CreditPrice', 'Ед. цена кредит']];

/** "Филтър по" of the chronological register (05 5.1), per report type. */
export function chronologicalFilterColumns(type: JournalReportType): [string, string][] {
  return [
    ['', 'Всички'], ['AccountingNumber', 'Номер на контиране'], ['AccountingDate', 'Дата на контиране'], ['DebitAccount', 'Сметка дебит'],
    ['DebitAccountDescription', 'Име на сметка дебит'], ['CreditAccount', 'Сметка кредит'], ['CreditAccountDescription', 'Име на сметка кредит'],
    ['Amount', 'Сума'], ['DocumentDate', 'Дата на документ'], ['DocumentNumber', 'Номер на документ'], ['CompanyName', 'Партньор'], ['Term', 'Основание'],
    ['Reference', 'Забележка'], ['ViesMonth', 'Месец за експорт'], ['OptionalReference', 'Втора забележка'], ['Paragraph', 'Параграф'], ['UserName', 'Потребител'],
    ...(type === 'currency' ? CURRENCY_FILTERS : type === 'quantity' ? QUANTITY_FILTERS : []),
  ];
}

/** "Филтър по" of the account card (05 4.2), per report type. */
export function analyticalFilterColumns(type: JournalReportType): [string, string][] {
  return [
    ['', 'Всички'], ['AccountingNumber', 'Номер на контиране'], ['AccountingDate', 'Дата на контиране'], ['DebitAccount', 'Сметка дебит'],
    ['DebitAccountDescription', 'Име на сметка дебит'], ['CreditAccount', 'Сметка кредит'], ['CreditAccountDescription', 'Име на сметка кредит'],
    ['Amount', 'Сума'], ['CompanyName', 'Партньор'], ['DocumentNumber', 'Номер на документ'], ['Term', 'Основание'], ['Reference', 'Забележка'],
    ['OptionalReference', 'Втора забележка'], ['Paragraph', 'Параграф'],
    ...(type === 'currency' ? CURRENCY_FILTERS : type === 'quantity' ? QUANTITY_FILTERS : []),
  ];
}

/** "Сортиране" of the chronological register (05 5.1). */
export const CHRONOLOGICAL_SORT: [string, string][] = [
  ['AccountingDate', 'Дата на контиране'], ['AccountingNumber', 'Номер на контиране'], ['ViesMonth', 'Месец за експорт'], ['DocumentNumber', 'Номер на документ'],
  ['DocumentDate', 'Дата на документ'], ['CompanyName', 'Партньор'], ['DebitAccount', 'Сметка дебит'], ['CreditAccount', 'Сметка кредит'], ['Amount', 'Сума'],
  ['DocumentType', 'Тип документ'], ['Term', 'Основание'], ['Reference', 'Забележка'],
];

/** "Сортиране" of the account card (05 4.2). */
export const ANALYTICAL_SORT: [string, string][] = [
  ['AccountingDate', 'Дата на контиране'], ['AccountingNumber', 'Номер на контиране'], ['DebitAccount', 'Сметка дебит'], ['CreditAccount', 'Сметка кредит'],
  ['Amount', 'Сума'], ['CompanyName', 'Партньор'], ['Term', 'Основание'], ['DocumentType', 'Тип документ'], ['DocumentNumber', 'Номер на документ'],
];

export const qtyText = (v: string | null) => (v === null || Number(v) === 0 ? '' : formatMoney(v, 3));
export const rateText = (v: string | null) => (v === null || Number(v) === 0 ? '' : v.replace('.', ','));

const LIMIT = 20000;
const SHORT: Record<JournalReportType, string> = { standard: 'ХронРег', currency: 'ХронРег валутен', quantity: 'ХронРег СМЗ' };
const TITLE: Record<JournalReportType, string> = { standard: 'Хронологичен регистър', currency: 'Хронологичен регистър във валута', quantity: 'Материален хронологичен регистър' };

/** Хронологичен регистър (spec 05 section 5): one row per posting in posting order. */
export function Chronological() {
  const ws = useWorkspace();
  const lookups = useLookups();
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('chronological', {
    ...period,
    type: 'standard' as JournalReportType,
    byExportMonth: false,
    fromNumber: '',
    toNumber: '',
    debit: '',
    debitSub: true,
    credit: '',
    creditSub: true,
    excludeDebit: '',
    excludeCredit: '',
    partners: [] as PickedPartner[],
    documentTypeId: '',
    documentNumber: '',
    transactionTypeId: '',
    vatTermId: '',
    sort: 'AccountingDate',
    filterColumn: '',
    text: '',
  });
  const [sel, setSel] = useState<number | null>(null);
  const report = useReport(
    'chronological',
    f,
    (x) =>
      api.get<JournalLine[]>(
        `/journal-lines${qs({
          from: x.from, to: x.to, type: x.type === 'standard' ? undefined : x.type, byExportMonth: x.byExportMonth,
          fromNumber: x.fromNumber.trim(), toNumber: x.toNumber.trim(),
          debit: x.debit, debitSub: x.debitSub ? undefined : '0', credit: x.credit, creditSub: x.creditSub ? undefined : '0',
          excludeDebit: x.excludeDebit.trim(), excludeCredit: x.excludeCredit.trim(),
          companyId: x.partners.map((p) => p.id).join(','), documentTypeId: x.documentTypeId, documentNumber: x.documentNumber.trim(),
          transactionTypeId: x.transactionTypeId, vatTermId: x.vatTermId, sort: x.sort, filterColumn: x.filterColumn, text: x.text.trim(), limit: LIMIT,
        })}`,
      ),
    (x) => (x.from > x.to ? 'Началната дата е след крайната дата.' : null),
  );
  const a = report.applied ?? f;
  const subtitle = [
    periodText(a), a.debit && `дебит ${a.debit}`, a.credit && `кредит ${a.credit}`,
    a.fromNumber && `от № ${a.fromNumber}`, a.toNumber && `до № ${a.toNumber}`, a.partners.length > 0 && `партньор ${a.partners.map((p) => p.name).join(', ')}`,
  ].filter(Boolean).join(', ');
  const open = (l: JournalLine) => ws.open('entry', { key: `entry:${l.accountingId}`, title: `Контиране ${l.number}`, params: { id: l.accountingId } });
  const cur = a.type === 'currency';
  const mat = a.type === 'quantity';

  const csv = (d: JournalLine[]): Cell[][] => [
    [
      'Контиране', 'Дата', 'Дебит сметка', 'Дебит', 'Debit', 'Кредит сметка', 'Кредит', 'Credit', 'Сума',
      ...(cur ? ['Вал. сума дебит', 'Вал. курс дебит', 'Вал. сума кредит', 'Вал. курс кредит'] : mat ? ['Количество дебит', 'Ед. цена дебит', 'Количество кредит', 'Ед. цена кредит'] : []),
      'Док. вид', 'Док. дата', 'Документ №', 'Партньор', 'ЕИК/ДДС Номер', 'Основание', 'Забележка', 'Втора забележка', 'Сделка по ЗДДС', 'Параграф', 'Месец за експорт', ...(cur || mat ? [] : ['Потребител']),
    ],
    ...d.map((l) => [
      l.number, bgDate(l.accountingDate), l.debitAccount, l.debitDescription, l.debitEnglishDescription, l.creditAccount, l.creditDescription, l.creditEnglishDescription, amt(l.amount),
      ...(cur ? [amt(l.debitCurrencyAmount), rateText(l.debitExchangeRate), amt(l.creditCurrencyAmount), rateText(l.creditExchangeRate)] : mat ? [qtyText(l.debitQuantity), qtyText(l.debitPrice), qtyText(l.creditQuantity), qtyText(l.creditPrice)] : []),
      l.documentType, bgDate(l.documentDate), l.documentNumber, l.companyName, l.companyVat, l.term, l.reference, l.optionalReference, l.vatTerm, l.paragraph,
      `${l.viesMonth.slice(5, 7)}.${l.viesMonth.slice(0, 4)}`, ...(cur || mat ? [] : [l.userName]),
    ]),
    ['Общо:', '', '', '', '', '', '', '', amt(sum(d, (l) => l.amount))],
  ];

  return (
    <ReportFrame<JournalLine[]>
      title={TITLE[a.type]}
      logEntity="chronologicalReport"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа${d.length >= LIMIT ? ' (ограничено)' : ''}`}
      csvName={`${SHORT[a.type]}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Тип справка">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as JournalReportType, filterColumn: '' })} className="w-32" aria-label="Тип справка">
              {JOURNAL_REPORT_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="От № контиране">
            <TextInput value={f.fromNumber} onChange={(e) => setF({ ...f, fromNumber: e.target.value })} className="w-28" aria-label="От № контиране" />
          </Field>
          <Field label="До № контиране">
            <TextInput value={f.toNumber} onChange={(e) => setF({ ...f, toNumber: e.target.value })} className="w-28" aria-label="До № контиране" />
          </Field>
          <Field label="Сметка дебит">
            <AccountNumberPicker value={f.debit} onChange={(debit) => setF({ ...f, debit })} className="w-40" />
          </Field>
          <Checkbox className="mb-1.5" label="С подсметките" checked={f.debitSub} onChange={(debitSub) => setF({ ...f, debitSub })} />
          <Field label="Сметка кредит">
            <AccountNumberPicker value={f.credit} onChange={(credit) => setF({ ...f, credit })} className="w-40" />
          </Field>
          <Checkbox className="mb-1.5" label="С подсметките" checked={f.creditSub} onChange={(creditSub) => setF({ ...f, creditSub })} />
          <Field label="Без сметки в дебита">
            <TextInput value={f.excludeDebit} onChange={(e) => setF({ ...f, excludeDebit: e.target.value })} className="w-36" placeholder="501/1, 503" aria-label="Без сметки в дебита" />
          </Field>
          <Field label="Без сметки в кредита">
            <TextInput value={f.excludeCredit} onChange={(e) => setF({ ...f, excludeCredit: e.target.value })} className="w-36" placeholder="501/1, 503" aria-label="Без сметки в кредита" />
          </Field>
          <Field label="Партньор">
            <PartnerMultiPicker value={f.partners} onChange={(partners) => setF({ ...f, partners })} />
          </Field>
          <Field label="Тип документ">
            <Select value={f.documentTypeId} onChange={(e) => setF({ ...f, documentTypeId: e.target.value })} className="w-40" aria-label="Тип документ">
              <option value="">Всички</option>
              {lookups.data?.documentTypes.filter((t) => t.isVisible).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Документ №">
            <TextInput value={f.documentNumber} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} className="w-28" aria-label="Документ №" />
          </Field>
          <Field label="Тип на сделката">
            <Select value={f.transactionTypeId} onChange={(e) => setF({ ...f, transactionTypeId: e.target.value })} className="w-32" aria-label="Тип на сделката">
              <option value="">Всички</option>
              {lookups.data?.transactionTypes.map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
            </Select>
          </Field>
          <Field label="Операция по ДДС">
            <Select value={f.vatTermId} onChange={(e) => setF({ ...f, vatTermId: e.target.value })} className="w-56" aria-label="Операция по ДДС">
              <option value="">Всички</option>
              {lookups.data?.vatTerms.map((t) => <option key={t.id} value={t.id}>{t.id} - {t.description}</option>)}
            </Select>
          </Field>
          <Field label="Сортиране">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="w-40" aria-label="Сортиране">
              {CHRONOLOGICAL_SORT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <ColumnFilter columns={chronologicalFilterColumns(f.type)} column={f.filterColumn} text={f.text} onChange={(filterColumn, text) => setF({ ...f, filterColumn, text })} />
        </>
      }
      options={<Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Контиране</th>
              <th>Дата</th>
              <th>Дебит</th>
              <th>Кредит</th>
              <th className="text-right">Сума</th>
              {cur && (
                <>
                  <th className="text-right">Вал. сума Дт</th>
                  <th className="text-right">Курс Дт</th>
                  <th className="text-right">Вал. сума Кт</th>
                  <th className="text-right">Курс Кт</th>
                </>
              )}
              {mat && (
                <>
                  <th className="text-right">Колич. Дт</th>
                  <th className="text-right">Ед. цена Дт</th>
                  <th className="text-right">Колич. Кт</th>
                  <th className="text-right">Ед. цена Кт</th>
                </>
              )}
              <th>Док. вид</th>
              <th>Документ №</th>
              <th>Док. дата</th>
              <th>Партньор</th>
              <th>Основание</th>
              <th>Забележка</th>
              <th>Сделка по ЗДДС</th>
              <th>Месец</th>
            </tr>
          </thead>
          <tbody>
            <VirtualRows count={d.length} colSpan={13 + (cur || mat ? 4 : 0)} row={(i) => {
              const l = d[i]!;
              return (
              <tr key={l.detailId} aria-selected={sel === l.detailId} onClick={() => setSel(l.detailId)} onDoubleClick={() => open(l)} className="cursor-default" title="Двоен клик — отваря контировката">
                <td className="font-medium">{l.number}</td>
                <td className="nowrap">{bgDate(l.accountingDate)}</td>
                <td className="nowrap" title={l.debitDescription}>{l.debitAccount}</td>
                <td className="nowrap" title={l.creditDescription}>{l.creditAccount}</td>
                <td className="num">{money(l.amount)}</td>
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
                <td>{l.documentType}</td>
                <td>{l.documentNumber}</td>
                <td className="nowrap">{bgDate(l.documentDate)}</td>
                <td className="max-w-56 truncate" title={l.companyVat}>{l.companyName}</td>
                <td className="max-w-72 truncate" title={l.term}>{l.term}</td>
                <td className="max-w-48 truncate" title={[l.reference, l.optionalReference].filter(Boolean).join(' / ')}>{l.reference}</td>
                <td className="max-w-48 truncate" title={l.vatTerm}>{l.vatTerm}</td>
                <td className="nowrap">{l.viesMonth.slice(5, 7)}.{l.viesMonth.slice(0, 4)}</td>
              </tr>
              );
            }} />
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Общо: {d.length} записа</td>
              <td className="num">{money(sum(d, (l) => l.amount))}</td>
              <td colSpan={8 + (cur || mat ? 4 : 0)} />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
