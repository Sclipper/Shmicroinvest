import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACTIVITY_DOCUMENT_COLUMNS, USER_ACTIVITIES, USER_ACTIVITY_REPORT_TYPES, type ActivityDocumentCounts } from '@shmi/core';
import { api, qs } from '../../api.ts';
import { Field, Select, TextInput } from '../../components/ui.tsx';
import { useCan } from '../../session.tsx';
import { PeriodFields, ReportFrame, periodText, useReport, useReportFilters, useYearPeriod, type Cell } from '../../reports/common.tsx';

interface LogRow { id: number; userId: number | null; user: string | null; activity: string; entityType: string; entityId: number | null; description: string | null; createdAt: string }
type DocRow = ActivityDocumentCounts & { userId: number | null; userName: string };
type Result = { type: 'menus'; rows: LogRow[] } | { type: 'documents'; rows: DocRow[] };

const ACTIVITY: Record<string, string> = Object.fromEntries(USER_ACTIVITIES.map((a) => [a.code, a.name]));
const ENTITY: Record<string, string> = {
  identification: 'Идентификация', partner: 'Партньори', user: 'Потребители', accounting: 'Контиране', myCompany: 'Моята фирма', account: 'Сметкоплан',
  turnoverReport: 'Оборотна ведомост', analyticalReport: 'Аналитичен регистър', chronologicalReport: 'Хронологичен регистър', document: 'Документ',
  financialYear: 'Счетоводна година', userRole: 'Потребителски групи', userRolePermissions: 'Права на потребителски групи',
  icaReport: 'Протоколи по чл. 117 от ЗДДС', report: 'Справка', usersActivitiesReport: 'Действия по потребители', smtpConfiguration: 'Настройки за e-mail',
};

const p2 = (n: number) => String(n).padStart(2, '0');
const ts = (iso: string) => {
  const d = new Date(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/**
 * Действия по потребители (01b 8, 05 7.7): "По менюта" = the activity log,
 * "По документи" = processed documents per user. Period, user and activity
 * are filtered on the server.
 */
export function Activity() {
  const can = useCan();
  const year = useYearPeriod();
  const [f, setF] = useReportFilters('usersActivities', { ...year, type: 'menus' as 'menus' | 'documents', userId: '', activity: '', q: '' });
  const report = useReport<typeof f, Result>('usersActivities', f, async (x) =>
    x.type === 'documents'
      ? { type: 'documents', rows: await api.get<DocRow[]>(`/activity/by-documents${qs({ from: x.from, to: x.to, userId: x.userId })}`) }
      : { type: 'menus', rows: await api.get<LogRow[]>(`/activity${qs({ from: x.from, to: x.to, userId: x.userId, activity: x.activity, q: x.q, limit: 20000 })}`) },
  );
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ id: number; name: string }[]>('/users'), enabled: can('UI_Edit_Administration_Users') });
  const userOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const u of users.data ?? []) m.set(u.id, u.name);
    const d = report.q.data;
    if (d?.type === 'menus') for (const r of d.rows) if (r.userId != null && r.user) m.set(r.userId, r.user);
    if (d?.type === 'documents') for (const r of d.rows) if (r.userId != null) m.set(r.userId, r.userName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'bg'));
  }, [users.data, report.q.data]);
  const a = report.applied ?? f;
  const typeName = USER_ACTIVITY_REPORT_TYPES.find((t) => t.id === a.type)!.name;

  const csv = (d: Result): Cell[][] =>
    d.type === 'documents'
      ? [['Потребител', ...ACTIVITY_DOCUMENT_COLUMNS.map((c) => c.label)], ...d.rows.map((r) => [r.userName, ...ACTIVITY_DOCUMENT_COLUMNS.map((c) => String(r[c.key]))])]
      : [['Дата и час', 'Потребител', 'Действие', 'Обект', 'Описание'], ...d.rows.map((r) => [ts(r.createdAt), r.user ?? '', ACTIVITY[r.activity] ?? r.activity, ENTITY[r.entityType] ?? r.entityType, r.description ?? ''])];

  return (
    <ReportFrame<Result>
      title={a.type === 'documents' ? 'Брой обработени документи' : 'Действия по потребители'}
      logEntity="usersActivitiesReport"
      subtitle={`${typeName}, ${periodText(a)}`}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} ${d.type === 'documents' ? 'потребители' : 'записа'}`}
      csvName={`${a.type === 'documents' ? 'Брой обработени документи' : 'Действия потребители'}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Тип справка" className="w-36">
            <Select aria-label="Тип справка" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as 'menus' | 'documents' })}>
              {USER_ACTIVITY_REPORT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Потребител" className="w-48">
            <Select aria-label="Потребител" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
              <option value="">Всички</option>
              {userOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </Field>
          {f.type === 'menus' && (
            <>
              <Field label="Действие" className="w-44">
                <Select aria-label="Действие" value={f.activity} onChange={(e) => setF({ ...f, activity: e.target.value })}>
                  <option value="">Всички</option>
                  {USER_ACTIVITIES.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                </Select>
              </Field>
              <Field label="Търсене" className="w-48">
                <TextInput placeholder="Описание, обект" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
              </Field>
            </>
          )}
        </>
      }
    >
      {(d) =>
        d.type === 'documents' ? (
          <table className="grid-table" data-testid="activity-documents">
            <thead>
              <tr>
                <th>Потребител</th>
                {ACTIVITY_DOCUMENT_COLUMNS.map((c) => <th key={c.key} className="w-36 text-right whitespace-normal">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.userId ?? 0}>
                  <td>{r.userName}</td>
                  {ACTIVITY_DOCUMENT_COLUMNS.map((c) => <td key={c.key} className={c.key === 'total' ? 'num font-semibold' : 'num'}>{r[c.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="grid-table" data-testid="activity-log">
            <thead>
              <tr>
                <th>Дата и час</th>
                <th>Потребител</th>
                <th>Действие</th>
                <th>Обект</th>
                <th className="text-right">№</th>
                <th>Описание</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id}>
                  <td className="w-40">{ts(r.createdAt)}</td>
                  <td>{r.user}</td>
                  <td>{ACTIVITY[r.activity] ?? r.activity}</td>
                  <td>{ENTITY[r.entityType] ?? r.entityType}</td>
                  <td className="num">{r.entityId ?? ''}</td>
                  <td className="w-full">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    </ReportFrame>
  );
}
