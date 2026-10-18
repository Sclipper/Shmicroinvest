import { Fragment, useMemo, useState } from 'react';
import { isCompanyCategory } from '@shmi/core';
import { api, qs } from '../api.ts';
import { PartnerPicker } from '../components/pickers.tsx';
import { Checkbox, Field } from '../components/ui.tsx';
import { useAccounts } from '../session.tsx';
import type { Account } from '../types.ts';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, sum, useAccountName, useReport, useYearPeriod, type Cell } from './common.tsx';

interface Row {
  companyId: number;
  companyName: string;
  vat: string;
  openingDebit: string;
  openingCredit: string;
  debitTurnover: string;
  creditTurnover: string;
  closingDebit: string;
  closingCredit: string;
}

const AMOUNTS = ['openingDebit', 'openingCredit', 'debitTurnover', 'creditTurnover', 'closingDebit', 'closingCredit'] as const;

/** Задължения/вземания по партньори: trial balance by partner for a partner account (spec 05 3.5 P). */
export function PartnerTurnover() {
  const period = useYearPeriod();
  const accountName = useAccountName();
  const [f, setF] = useState({ ...period, account: '', zero: false, byExportMonth: false, companyId: null as number | null, companyName: '' as string | null });
  const report = useReport(
    'partnerTurnover',
    f,
    (x) => api.get<Row[]>(`/reports/partner-turnover${qs({ from: x.from, to: x.to, account: x.account, zero: x.zero, byExportMonth: x.byExportMonth, companyId: x.companyId })}`),
    (x) => (x.account ? null : 'Не е избрана сметка.'),
  );
  // Only partner accounts (partner categories) and their ancestors can be chosen.
  const { data: accounts = [] } = useAccounts();
  const partnerIds = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const out = new Set<number>();
    for (const a of accounts) {
      if (!isCompanyCategory(a.categoryId)) continue;
      let p: Account | undefined = a;
      while (p && !out.has(p.id)) {
        out.add(p.id);
        p = p.parentId != null ? byId.get(p.parentId) : undefined;
      }
    }
    return out;
  }, [accounts]);
  const accFilter = useMemo(() => (a: Account) => partnerIds.has(a.id), [partnerIds]);

  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.account && `сметка ${a.account} ${accountName(a.account)}`, a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');

  const csv = (d: Row[]): Cell[][] => [
    ['Партньор', 'ЕИК/ДДС номер', 'Начално салдо Дебит', 'Начално салдо Кредит', 'Обороти Дебит', 'Обороти Кредит', 'Крайно салдо Дебит', 'Крайно салдо Кредит'],
    ...d.map((r) => [r.companyName, r.vat, ...AMOUNTS.map((k) => amt(r[k]))]),
    ['Общо:', '', ...AMOUNTS.map((k) => sum(d, (r) => r[k]))],
  ];

  return (
    <ReportFrame<Row[]>
      title="Задължения/вземания по партньори"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} партньори`}
      csvName={`ОВ партньори_${a.account.replace(/\//g, '-')}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Сметка *">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} filter={accFilter} className="w-72" />
          </Field>
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-64" />
          </Field>
        </>
      }
      options={
        <>
          <Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />
          <Checkbox label="Включване на партньори с нулеви салда и обороти" checked={f.zero} onChange={(zero) => setF({ ...f, zero })} />
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr className="hdr1">
              <th rowSpan={2} className="align-bottom">
                Партньор
              </th>
              <th rowSpan={2} className="w-40 align-bottom">
                ЕИК/ДДС номер
              </th>
              <th colSpan={2} className="text-center">
                Начално салдо
              </th>
              <th colSpan={2} className="text-center">
                Обороти
              </th>
              <th colSpan={2} className="text-center">
                Крайно салдо
              </th>
            </tr>
            <tr className="hdr2">
              {[0, 1, 2].map((i) => (
                <Fragment key={i}>
                  <th className="w-32 text-right">Дебит</th>
                  <th className="w-32 text-right">Кредит</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.map((r) => (
              <tr key={r.companyId}>
                <td className="max-w-[26rem] truncate" title={r.companyName}>
                  {r.companyName}
                </td>
                <td className="nowrap">{r.vat}</td>
                {AMOUNTS.map((k) => (
                  <Amt key={k} v={r[k]} />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Общо:</td>
              {AMOUNTS.map((k) => (
                <Amt key={k} v={sum(d, (r) => r[k])} />
              ))}
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
