import { useState } from 'react';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { PartnerPicker } from '../components/pickers.tsx';
import { Checkbox, Field, Select, TextInput } from '../components/ui.tsx';
import { useLookups } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import { AccountNumberPicker, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useYearPeriod, type Cell } from './common.tsx';

export interface JournalLine {
  detailId: number;
  accountingId: number;
  number: string;
  accountingDate: string;
  viesMonth: string;
  debitAccount: string;
  debitDescription: string;
  creditAccount: string;
  creditDescription: string;
  amount: string;
  companyName: string;
  companyVat: string;
  documentType: string;
  documentDate: string;
  documentNumber: string;
  term: string;
  reference: string;
  vatTerm: string;
  userName: string;
}

const LIMIT = 20000;

/** Хронологичен регистър (spec 05 section 5): one row per posting in posting order. */
export function Chronological() {
  const ws = useWorkspace();
  const lookups = useLookups();
  const period = useYearPeriod();
  const [f, setF] = useState({
    ...period,
    byExportMonth: false,
    debit: '',
    credit: '',
    account: '',
    documentTypeId: '',
    companyId: null as number | null,
    companyName: '' as string | null,
    text: '',
  });
  const [sel, setSel] = useState<number | null>(null);
  const report = useReport('chronological', f, (x) =>
    api.get<JournalLine[]>(
      `/journal-lines${qs({ from: x.from, to: x.to, byExportMonth: x.byExportMonth, debit: x.debit, credit: x.credit, account: x.account, documentTypeId: x.documentTypeId, companyId: x.companyId, text: x.text.trim(), limit: LIMIT })}`,
    ),
  );
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.debit && `дебит ${a.debit}`, a.credit && `кредит ${a.credit}`, a.account && `сметка ${a.account}`, a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');
  const open = (l: JournalLine) => ws.open('entry', { key: `entry:${l.accountingId}`, title: `Контиране ${l.number}`, params: { id: l.accountingId } });

  const csv = (d: JournalLine[]): Cell[][] => [
    ['Номер', 'Дата', 'Месец за експорт', 'Вид документ', '№ документ', 'Дата документ', 'Дебит', 'Име дебит', 'Кредит', 'Име кредит', 'Сума', 'Основание', 'Забележка', 'Партньор', 'ЕИК/ДДС №', 'Операция по ДДС'],
    ...d.map((l) => [l.number, bgDate(l.accountingDate), l.viesMonth.slice(5, 7) + '.' + l.viesMonth.slice(0, 4), l.documentType, l.documentNumber, bgDate(l.documentDate), l.debitAccount, l.debitDescription, l.creditAccount, l.creditDescription, amt(l.amount), l.term, l.reference, l.companyName, l.companyVat, l.vatTerm]),
    ['Общо:', '', '', '', '', '', '', '', '', '', sum(d, (l) => l.amount)],
  ];

  return (
    <ReportFrame<JournalLine[]>
      title="Хронологичен регистър"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа${d.length >= LIMIT ? ' (ограничено)' : ''}`}
      csvName={`ХронРег_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Дебит сметка">
            <AccountNumberPicker value={f.debit} onChange={(debit) => setF({ ...f, debit })} className="w-44" />
          </Field>
          <Field label="Кредит сметка">
            <AccountNumberPicker value={f.credit} onChange={(credit) => setF({ ...f, credit })} className="w-44" />
          </Field>
          <Field label="Сметка (Дт или Кт)">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-44" />
          </Field>
          <Field label="Тип документ">
            <Select value={f.documentTypeId} onChange={(e) => setF({ ...f, documentTypeId: e.target.value })} className="w-44">
              <option value="">Всички</option>
              {lookups.data?.documentTypes
                .filter((t) => t.isVisible)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-52" />
          </Field>
          <Field label="Търсене" className="min-w-40 flex-1">
            <TextInput value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="номер, основание, документ, партньор, сума" />
          </Field>
        </>
      }
      options={<Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Номер</th>
              <th>Дата</th>
              <th>Документ</th>
              <th>№ док.</th>
              <th>Дата док.</th>
              <th>Дебит</th>
              <th>Кредит</th>
              <th className="text-right">Сума</th>
              <th>Основание</th>
              <th>Партньор</th>
            </tr>
          </thead>
          <tbody>
            {d.map((l) => (
              <tr key={l.detailId} aria-selected={sel === l.detailId} onClick={() => setSel(l.detailId)} onDoubleClick={() => open(l)} className="cursor-default" title="Двоен клик — отваря контировката">
                <td className="font-medium">{l.number}</td>
                <td className="nowrap">{bgDate(l.accountingDate)}</td>
                <td>{l.documentType}</td>
                <td>{l.documentNumber}</td>
                <td className="nowrap">{bgDate(l.documentDate)}</td>
                <td className="nowrap" title={l.debitDescription}>
                  {l.debitAccount}
                </td>
                <td className="nowrap" title={l.creditDescription}>
                  {l.creditAccount}
                </td>
                <td className="num">{money(l.amount)}</td>
                <td className="max-w-80 truncate" title={l.reference || l.term}>
                  {l.term}
                </td>
                <td className="max-w-64 truncate" title={l.companyVat}>
                  {l.companyName}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7}>Общо: {d.length} записа</td>
              <td className="num">{money(sum(d, (l) => l.amount))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
