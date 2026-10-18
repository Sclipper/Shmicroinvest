import { Fragment, useState } from 'react';
import { CheckCircle2, FilePen, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { formatMoney, type XlsxCell, type XlsxSheet } from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate } from '../format.ts';
import { Button, Checkbox, Dialog, Field, Select, TextInput, cx } from '../components/ui.tsx';
import { PeriodFields, ReportFrame, periodText, useReport, useYearPeriod, type Cell } from '../reports/common.tsx';
import { useCan, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import type { Session } from '../types.ts';

/* ------------------------------------------------------------------ */
/* Types of GET /statements/report and /statements/verify              */
/* ------------------------------------------------------------------ */

export type StatementCode = 'balance' | 'opr' | 'opp' | 'osk' | 'sda' | 'cr';
interface CellValue {
  key: string;
  cp: string;
  ep: string | null;
}
interface Row {
  identifier: string;
  description: string;
  headings: string[];
  bold: boolean;
  cells: Record<string, CellValue>;
}
interface Statement {
  code: StatementCode;
  name: string;
  title: string;
  columns: { identifier: string; description: string }[];
  rows: Row[];
}
interface Window {
  start: string;
  end: string;
}
interface Run {
  periods: { cp: Window; ep: Window };
  unit: string;
  thousands: boolean;
  statements: Statement[];
  issues: { key?: string; message: string }[];
}
interface Verification {
  ok: boolean;
  message: string;
  checks: { id: string; ok: boolean; severity: 'critical' | 'warning'; difference: string; message: string | null }[];
}
interface Result {
  run: Run;
  verify: Verification;
}

export const STATEMENT_OPTIONS: [StatementCode | '', string][] = [
  ['', 'Всички отчети'],
  ['balance', 'Баланс'],
  ['opr', 'Отчет за приходите и разходите'],
  ['opp', 'Отчет за паричните потоци'],
  ['osk', 'Отчет за собствения капитал'],
  ['sda', 'Справка за нетекущите (дълготрайни) активи'],
  ['cr', 'Касова наличност и вземания'],
];

/** Halves of the two-sided forms. */
const SIDES: Partial<Record<StatementCode, [string, string][]>> = {
  balance: [['BalansCol1', 'А К Т И В'], ['BalansCol2', 'П А С И В']],
  opr: [['OPRCol1', 'Наименование на разходите'], ['OPRCol2', 'Наименование на приходите']],
};

const num = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 0 : Number(v));

function useValue(thousands: boolean) {
  return (v: string | null | undefined) => (v === null || v === undefined || Number(v) === 0 ? '' : formatMoney(v, thousands ? 0 : 2));
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

/** Отчети и баланс (Alt+B, spec 05 section 9). */
export function FinancialStatements() {
  const period = useYearPeriod();
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const [f, setF] = useState({
    ...period,
    statement: 'balance' as StatementCode | '',
    format: 'national' as 'national' | 'nsi',
    maker: '',
    contact: '',
    phone: '',
    thousands: false,
    usePrev: false,
    sameInterval: false,
  });
  const [checks, setChecks] = useState<Verification | null>(null);
  const report = useReport(
    'financialStatements',
    f,
    async (x) => {
      const q = qs({ from: x.from, to: x.to, statements: x.statement || undefined, thousands: x.thousands, usePrev: x.usePrev, sameInterval: x.sameInterval, nsi: x.format === 'nsi' });
      const vq = qs({ from: x.from, to: x.to, thousands: x.thousands, usePrev: x.usePrev, sameInterval: x.sameInterval, balanceOnly: x.statement === 'balance' });
      const [run, verify] = await Promise.all([api.get<Run>(`/statements/report${q}`), api.get<Verification>(`/statements/verify${vq}`)]);
      return { run, verify };
    },
    (x) => (x.from > x.to ? 'Началната дата е след крайната дата.' : null),
  );
  const a = report.applied ?? f;
  const subtitle = `${periodText(a)}${a.thousands ? ', в хиляди' : ''}`;

  return (
    <>
      <ReportFrame<Result>
        title="Отчети и баланс"
        subtitle={subtitle}
        report={report}
        isEmpty={(d) => d.run.statements.length === 0}
        status={(d) => `${d.run.statements.reduce((n, x) => n + x.rows.length, 0)} реда, ${d.run.unit}`}
        csvName={`Отчети_${a.from}_${a.to}`}
        csv={(d) => d.run.statements.flatMap((st) => [...statementSheet(st, d.run, s).rows.map((r) => r.map(cellText)), []])}
        xlsx={(d) => workbook(d, s, a)}
        actions={(d) => (
          <>
            <Button icon={<ShieldCheck className="size-3.5" />} disabled={!d} onClick={() => d && setChecks(d.verify)}>
              Проверка на данните
            </Button>
            {can('UI_Edit_Administration_StatementFormulas') && (
              <Button icon={<FilePen className="size-3.5" />} onClick={() => ws.open('statementFormulas', { params: { statement: f.statement || 'balance' } })}>
                Редакция на формули
              </Button>
            )}
          </>
        )}
        filters={
          <>
            <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
            <Field label="Тип справка">
              <Select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as 'national' | 'nsi' })} className="w-52">
                <option value="national">Национален формат</option>
                <option value="nsi">Формат НСИ</option>
              </Select>
            </Field>
            <Field label="Отчети">
              <Select value={f.statement} onChange={(e) => setF({ ...f, statement: e.target.value as StatementCode | '' })} className="w-64" aria-label="Отчети">
                {STATEMENT_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Съставител">
              <TextInput value={f.maker} onChange={(e) => setF({ ...f, maker: e.target.value })} className="w-44" />
            </Field>
            {f.format === 'nsi' && (
              <>
                <Field label="Лице за контакт">
                  <TextInput value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} className="w-40" />
                </Field>
                <Field label="Телефон">
                  <TextInput value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="w-32" />
                </Field>
              </>
            )}
          </>
        }
        options={
          <>
            <Checkbox label={s.baseCurrency === 'EUR' ? 'В хиляди евро' : 'В хиляди лева'} checked={f.thousands} onChange={(thousands) => setF({ ...f, thousands })} />
            <Checkbox label="Попълване на ръчно въведени данни за предходен период" checked={f.usePrev} onChange={(usePrev) => setF({ ...f, usePrev })} />
            <Checkbox label="Попълване на данни от същия период на предходната година" checked={f.sameInterval} onChange={(sameInterval) => setF({ ...f, sameInterval })} />
          </>
        }
      >
        {(d) => <StatementsView data={d} maker={a.maker} />}
      </ReportFrame>
      {checks && <VerificationDialog v={checks} onClose={() => setChecks(null)} />}
    </>
  );
}

function VerificationDialog({ v, onClose }: { v: Verification; onClose: () => void }) {
  const failed = v.checks.filter((c) => !c.ok);
  return (
    <Dialog title="Проверка на данните" onClose={onClose} width={640} footer={<Button variant="primary" data-autofocus onClick={onClose}>OK</Button>}>
      {failed.length === 0 ? (
        <div className="flex items-center gap-2 text-green-700">
          <CheckCircle2 className="size-5" /> Данните са попълнени коректно.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {failed.map((c) => (
            <li key={c.id} className={cx('flex gap-2', c.severity === 'critical' ? 'text-red-700' : 'text-amber-700')}>
              {c.severity === 'critical' ? <XCircle className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
              <span>{c.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 text-[11px] text-slate-500">Проверки: {v.checks.length}, успешни: {v.checks.length - failed.length}.</div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function StatementsView({ data, maker }: { data: Result; maker: string }) {
  const s = useSession();
  const { run } = data;
  return (
    <div className="flex flex-col gap-6 p-3">
      {run.issues.length > 0 && (
        <div className="rounded-sm border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          {run.issues.map((i, n) => (
            <div key={n}>
              {i.key ? `${i.key}: ` : ''}
              {i.message}
            </div>
          ))}
        </div>
      )}
      {run.statements.map((st) => (
        <section key={st.code} className="break-after-page" data-statement={st.code}>
          <header className="mb-2 text-center">
            <h2 className="text-[15px] font-bold tracking-wide">{st.title}</h2>
            <div className="text-[12px]">на {s.company.name}{s.company.bulstat ? `, ЕИК ${s.company.bulstat}` : ''}</div>
            <div className="text-[12px]">{st.code === 'balance' ? `към ${bgDate(run.periods.cp.end)}` : `за периода ${bgDate(run.periods.cp.start)} - ${bgDate(run.periods.cp.end)}`}</div>
            <div className="text-[11px] text-slate-600">(в {run.unit})</div>
          </header>
          <StatementBody st={st} run={run} />
        </section>
      ))}
      <div className="flex justify-between text-[12px]">
        <span>Съставител: {maker || '....................'}</span>
        <span>Ръководител: ....................</span>
      </div>
    </div>
  );
}

function StatementBody({ st, run }: { st: Statement; run: Run }) {
  if (SIDES[st.code]) return <TwoSided st={st} run={run} />;
  if (st.code === 'opp') return <CashFlow st={st} run={run} />;
  return <Grid st={st} run={run} />;
}

function Caption({ r }: { r: Row }) {
  return <span className={cx('whitespace-normal', r.bold && 'font-semibold')}>{r.description}</span>;
}

function Headings({ r, span }: { r: Row; span: number }) {
  return (
    <>
      {r.headings.map((h) => (
        <tr key={h} className="grp">
          <td colSpan={span} className="whitespace-normal">
            {h}
          </td>
        </tr>
      ))}
    </>
  );
}

function TwoSided({ st, run }: { st: Statement; run: Run }) {
  const v = useValue(run.thousands);
  return (
    <div className="flex flex-col gap-4">
      {SIDES[st.code]!.map(([col, title]) => {
        const rows = st.rows.filter((r) => r.cells[col]);
        return (
          <table key={col} className="grid-table max-w-[64rem] [&_thead_th]:bg-slate-200!" data-side={col}>
            <thead>
              <tr className="hdr1">
                <th className="text-center">{title}</th>
                <th className="w-16 text-center">Код</th>
                <th className="w-36 text-right">Текуща година</th>
                <th className="w-36 text-right">Предходна година</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = r.cells[col]!;
                return (
                  <Fragment key={r.identifier}>
                    <Headings r={r} span={4} />
                    <tr data-key={c.key}>
                      <td>
                        <Caption r={r} />
                      </td>
                      <td className="text-center text-[11px] text-slate-500">{c.key}</td>
                      <td className={cx('num', r.bold && 'font-semibold')}>{v(c.cp)}</td>
                      <td className={cx('num', r.bold && 'font-semibold')}>{v(c.ep)}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

/** ОПП: Постъпления / Плащания / Нетен поток (column 3 cell, else 1 - 2) for both periods. */
function cashFlowValues(r: Row, period: 'cp' | 'ep') {
  const p = (col: string) => (r.cells[col] ? num(r.cells[col]![period]) : null);
  const inflow = p('OPPCol1');
  const outflow = p('OPPCol2');
  const net = p('OPPCol3') ?? (inflow !== null || outflow !== null ? (inflow ?? 0) - (outflow ?? 0) : null);
  return [inflow, outflow, net] as const;
}

function CashFlow({ st, run }: { st: Statement; run: Run }) {
  const fmt = (n: number | null) => (n === null || n === 0 ? '' : formatMoney(n, run.thousands ? 0 : 2));
  return (
    <table className="grid-table max-w-[80rem] [&_thead_th]:bg-slate-200!">
      <thead>
        <tr className="hdr1">
          <th rowSpan={2}>Наименование на паричните потоци</th>
          <th colSpan={3} className="text-center">Текущ период</th>
          <th colSpan={3} className="text-center">Предходен период</th>
        </tr>
        <tr className="hdr2">
          {['постъпления', 'плащания', 'нетен поток', 'постъпления', 'плащания', 'нетен поток'].map((h, i) => (
            <th key={i} className="w-28 text-right">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {st.rows.map((r) => (
          <Fragment key={r.identifier}>
            <Headings r={r} span={7} />
            <tr data-key={Object.values(r.cells)[0]?.key}>
              <td className="max-w-[36rem]">
                <Caption r={r} />
              </td>
              {[...cashFlowValues(r, 'cp'), ...cashFlowValues(r, 'ep')].map((n, i) => (
                <td key={i} className={cx('num', r.bold && 'font-semibold')}>
                  {fmt(n)}
                </td>
              ))}
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function Grid({ st, run }: { st: Statement; run: Run }) {
  const v = useValue(run.thousands);
  return (
    <div className="overflow-x-auto">
      <table className="grid-table [&_thead_th]:bg-slate-200!">
        <thead>
          <tr className="hdr1">
            <th className="min-w-72">Показатели</th>
            {st.columns.map((c, i) => (
              <th key={c.identifier} className="w-28 max-w-32 text-center align-bottom text-[11px] whitespace-normal!" title={c.identifier}>
                <div className="font-normal text-slate-500">{i + 1}</div>
                {c.description}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {st.rows.map((r) => (
            <Fragment key={r.identifier}>
              <Headings r={r} span={st.columns.length + 1} />
              <tr>
                <td className="max-w-[28rem]">
                  <Caption r={r} />
                </td>
                {st.columns.map((c) => (
                  <td key={c.identifier} className={cx('num', r.bold && 'font-semibold')} data-key={r.cells[c.identifier]?.key} title={r.cells[c.identifier]?.key}>
                    {v(r.cells[c.identifier]?.cp)}
                  </td>
                ))}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export (FinancialReportsAllExport: one workbook for all statements) */
/* ------------------------------------------------------------------ */

const cellText = (c: XlsxCell): Cell => (c !== null && typeof c === 'object' ? (c.v as Cell) : (c as Cell));
const SHEET_NAMES: Record<StatementCode, string> = { balance: 'БАЛАНС', opr: 'ОПР', opp: 'ОПП', osk: 'ОСК', sda: 'Справка ДА', cr: 'Касова наличност' };

function statementSheet(st: Statement, run: Run, s: Session): XlsxSheet {
  const n = (v: string | null | undefined): XlsxCell => (v === null || v === undefined ? null : { v: Number(v), format: run.thousands ? 'integer' : 'amount' });
  const rows: XlsxCell[][] = [[st.title], [`на ${s.company.name}`], [st.code === 'balance' ? `към ${bgDate(run.periods.cp.end)}` : `за периода ${bgDate(run.periods.cp.start)} - ${bgDate(run.periods.cp.end)}`], [`(в ${run.unit})`], []];
  const bold: number[] = [0];
  const push = (r: XlsxCell[], isBold = false) => {
    if (isBold) bold.push(rows.length);
    rows.push(r);
  };
  if (SIDES[st.code]) {
    for (const [col, title] of SIDES[st.code]!) {
      push([title], true);
      push(['Раздели, групи, статии', 'Код', 'Текуща година', 'Предходна година'], true);
      for (const r of st.rows.filter((x) => x.cells[col])) {
        for (const h of r.headings) push([h], true);
        const c = r.cells[col]!;
        push([r.description, c.key, n(c.cp), n(c.ep)], r.bold);
      }
      push([]);
    }
    return { name: SHEET_NAMES[st.code], rows, boldRows: bold, widths: [70, 8, 16, 16] };
  }
  if (st.code === 'opp') {
    push(['Наименование на паричните потоци', 'Текущ период', '', '', 'Предходен период'], true);
    push(['', 'постъпления', 'плащания', 'нетен поток', 'постъпления', 'плащания', 'нетен поток'], true);
    for (const r of st.rows) {
      for (const h of r.headings) push([h], true);
      const vals = [...cashFlowValues(r, 'cp'), ...cashFlowValues(r, 'ep')].map((x): XlsxCell => (x === null ? null : { v: x, format: run.thousands ? 'integer' : 'amount' }));
      push([r.description, ...vals], r.bold);
    }
    return { name: SHEET_NAMES.opp, rows, boldRows: bold, widths: [70, 14, 14, 14, 14, 14, 14], merges: ['B6:D6', 'E6:G6'] };
  }
  push(['Показатели', ...st.columns.map((c) => c.description)], true);
  for (const r of st.rows) {
    for (const h of r.headings) push([h], true);
    push([r.description, ...st.columns.map((c) => n(r.cells[c.identifier]?.cp))], r.bold);
  }
  return { name: SHEET_NAMES[st.code], rows, boldRows: bold, widths: [60, ...st.columns.map(() => 16)] };
}

function workbook(d: Result, s: Session, f: { from: string; to: string; maker: string }): XlsxSheet[] {
  const company: XlsxCell[][] = [
    ['Фирмени данни'], [],
    ['Фирма', s.company.name], ['Идент. N', s.company.bulstat], ['Съставител', f.maker], ['Дата на отчета', bgDate(s.workingDate)],
    ['Начална дата', bgDate(d.run.periods.cp.start)], ['Крайна дата', bgDate(d.run.periods.cp.end)], ['Мерна единица', d.run.unit],
  ];
  const checks: XlsxCell[][] = [['Проверка отчети'], [], ['Проверка', 'Резултат', 'Разлика', 'Съобщение'], ...d.verify.checks.map((c) => [c.id, c.ok ? 'OK' : c.severity === 'critical' ? 'Грешка' : 'Предупреждение', Number(c.difference), c.message ?? ''] as XlsxCell[]), [], [d.verify.ok ? 'Данните са попълнени коректно.' : d.verify.message]];
  return [
    { name: 'Фирмени данни', rows: company, boldRows: [0], widths: [22, 50] },
    { name: 'Проверка отчети', rows: checks, boldRows: [0, 2], widths: [18, 16, 14, 100] },
    ...d.run.statements.map((st) => statementSheet(st, d.run, s)),
  ];
}

