import { useEffect } from 'react';
import { api, qs } from '../../api.ts';
import { Field, Select } from '../../components/ui.tsx';
import { bgDate } from '../../format.ts';
import { useLookups, useSession } from '../../session.tsx';
import type { ScreenProps } from '../../shell/workspace.tsx';
import { AccountNumberPicker, ReportFrame, rowsToSheet, useReport, useReportFilters, type Cell } from '../common.tsx';
import { ColumnFilter, usePartnerAccountFilter } from './shared.tsx';

interface Row {
  companyId: number;
  companyName: string;
  groupId: number;
  vatNumber: string;
  bulstat: string;
  contactName: string;
  country: string;
  city: string;
  address: string;
  postalCode: string;
  phone: string;
  email: string;
  lastModifiedDate: string;
  accountNumbers: string;
  ibans: string;
}

/** "Филтър по" (05 7.7), "Всички" first. */
const FILTER_COLUMNS: [string, string][] = [
  ['', 'Всички'], ['CompanyNameAndBulstat', 'Име и ЕИК'], ['BulstatAndVATNumber', 'ЕИК и ДДС номер'], ['CompanyName', 'Фирма'], ['VatNumber', 'ДДС номер'],
  ['Bulstat', 'ЕИК'], ['ContactName', 'МОЛ'], ['City', 'Град'], ['Address', 'Адрес'], ['PostalCode', 'Пощенски код'], ['Phone', 'Телефон'],
  ['Email', 'E-mail'], ['LastModifiedDate', 'Дата на създаване'],
];

/** Header row 2 of the Excel layout. */
const HEAD = ['Фирма', 'ЕИК', 'ДДС Номер', 'IBAN', 'МОЛ', 'Държава', 'Град', 'Адрес', 'ПК', 'Телефон', 'E-mail', 'Сметки', 'Дата на създаване'];
const cells = (r: Row): Cell[] => [r.companyName, r.bulstat, r.vatNumber, r.ibans, r.contactName, r.country, r.city, r.address, r.postalCode, r.phone, r.email, r.accountNumbers, bgDate(r.lastModifiedDate)];

/**
 * Справка партньори (spCompaniesReport, 05 7.7): the partner register,
 * limited to a group (with its subgroups) or an attached account, with the
 * free-text filter. Opened from Справки > Фирми and from the partners list
 * (params groupId / account).
 */
export function CompaniesReport({ tab }: ScreenProps) {
  const s = useSession();
  const lookups = useLookups();
  const accFilter = usePartnerAccountFilter();
  const [f, setF] = useReportFilters('companiesReport', { groupId: 1, account: '', filterColumn: '', filterText: '' });
  const paramGroup = tab.params?.groupId as number | undefined;
  const paramAccount = tab.params?.account as string | undefined;
  useEffect(() => {
    if (paramGroup === undefined && paramAccount === undefined) return;
    setF((x) => ({ ...x, groupId: paramGroup ?? 1, account: paramAccount ?? '' }));
    // setF is a new function every render: the effect follows the tab parameters only.
  }, [paramGroup, paramAccount]); // eslint-disable-line react-hooks/exhaustive-deps
  const report = useReport('companiesReport', f, (x) =>
    api.get<Row[]>(`/reports/companies${qs({ groupId: x.groupId === 1 ? undefined : x.groupId, account: x.account, filterColumn: x.filterColumn, filterText: x.filterText.trim() })}`),
  );
  const a = report.applied ?? f;
  const groups = lookups.data?.companyGroups ?? [];
  const groupName = groups.find((g) => g.id === a.groupId)?.name;
  const subtitle = [a.groupId !== 1 && groupName && `група ${groupName}`, a.account && `сметка ${a.account}`].filter(Boolean).join(', ');

  return (
    <ReportFrame<Row[]>
      title="Справка партньори"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} партньора`}
      csvName={`Партньори ${s.company.name}`}
      csv={(d) => [HEAD, ...d.map(cells)]}
      // Excel layout: title row 1 "Партньори на {company}", header row 2.
      xlsx={(d) => [rowsToSheet('Партньори', [[`Партньори на ${s.company.name}`], HEAD, ...d.map(cells)], 1)]}
      filters={
        <>
          <Field label="Група">
            <Select value={f.groupId} onChange={(e) => setF({ ...f, groupId: Number(e.target.value) })} className="w-52" aria-label="Група">
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {'  '.repeat(Math.max(0, g.level - 1))}
                  {g.id === 1 ? 'Всички' : g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} filter={accFilter} className="w-56" />
          </Field>
          <ColumnFilter columns={FILTER_COLUMNS} column={f.filterColumn} text={f.filterText} onChange={(filterColumn, filterText) => setF({ ...f, filterColumn, filterText })} />
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              {HEAD.map((h) => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.map((r) => (
              <tr key={r.companyId}>
                <td className="max-w-[18rem] truncate font-medium" title={r.companyName}>{r.companyName}</td>
                <td className="nowrap">{r.bulstat}</td>
                <td className="nowrap">{r.vatNumber}</td>
                <td className="max-w-[14rem] truncate" title={r.ibans}>{r.ibans}</td>
                <td className="max-w-[10rem] truncate">{r.contactName}</td>
                <td>{r.country}</td>
                <td>{r.city}</td>
                <td className="max-w-[16rem] truncate" title={r.address}>{r.address}</td>
                <td>{r.postalCode}</td>
                <td className="nowrap">{r.phone}</td>
                <td className="max-w-[12rem] truncate">{r.email}</td>
                <td className="max-w-[10rem] truncate" title={r.accountNumbers}>{r.accountNumbers}</td>
                <td className="nowrap">{bgDate(r.lastModifiedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportFrame>
  );
}
