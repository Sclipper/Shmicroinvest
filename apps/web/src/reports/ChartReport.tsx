import { useState } from 'react';
import { api, qs } from '../api.ts';
import { Checkbox, Field, cx } from '../components/ui.tsx';
import { useSession } from '../session.tsx';
import { AccountNumberPicker, LevelSelect, ReportFrame, useReport, type Cell } from './common.tsx';

interface Row {
  number: string;
  description: string;
  englishDescription: string | null;
  level: number;
}

/** Индивидуален сметкоплан, справка (spec 05 4.4, spChartOfAccountsReport). */
export function ChartReport() {
  const s = useSession();
  const [f, setF] = useState({ account: '', level: 5, english: false });
  const report = useReport('chartReport', f, (x) => api.get<Row[]>(`/reports/chart${qs({ level: x.level, account: x.account })}`));
  const a = report.applied ?? f;
  const subtitle = [`${s.year.year} г.`, a.account && `сметка ${a.account}`].filter(Boolean).join(', ');

  const csv = (d: Row[]): Cell[][] => [
    ['Сметка', 'Наименование', ...(a.english ? ['Наименование на чужд език'] : []), 'Ниво'],
    ...d.map((r) => [r.number, r.description, ...(a.english ? [r.englishDescription ?? ''] : []), String(r.level)]),
  ];

  return (
    <ReportFrame<Row[]>
      title="Индивидуален сметкоплан"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} сметки`}
      csvName={`Сметкоплан_${s.year.year}`}
      csv={csv}
      filters={
        <>
          <LevelSelect value={f.level} onChange={(level) => setF({ ...f, level })} />
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} />
          </Field>
        </>
      }
      options={<Checkbox label="Наименование на сметки на чужд език" checked={f.english} onChange={(english) => setF({ ...f, english })} />}
    >
      {(d) => {
        const min = Math.min(...d.map((r) => r.level));
        return (
          <table className="grid-table max-w-[72rem]">
            <thead>
              <tr>
                <th className="w-40">Сметка</th>
                <th>Наименование</th>
                {a.english && <th>Наименование на чужд език</th>}
              </tr>
            </thead>
            <tbody>
              {d.map((r, i) => {
                const parent = (d[i + 1]?.level ?? 0) > r.level;
                const pad = { paddingLeft: 8 + (r.level - min) * 16 };
                return (
                  <tr key={r.number} className={cx(parent && 'font-semibold', r.level === min && 'bg-slate-100!')}>
                    <td className="nowrap" style={pad}>
                      {r.number}
                    </td>
                    <td style={pad}>{r.description}</td>
                    {a.english && <td className="text-slate-600">{r.englishDescription}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        );
      }}
    </ReportFrame>
  );
}
