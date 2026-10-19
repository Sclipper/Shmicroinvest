import { Fragment, useState } from 'react';
import { CheckCircle2, FilePen, FileSpreadsheet, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import {
  STATEMENT_FORMATS, STATEMENT_LANGUAGES, STATEMENT_TITLES_EN, captionEn, formatMoney, type StatementFormat, type StatementLanguage, type XlsxCell, type XlsxSheet,
} from '@shmi/core';
import { api, qs } from '../api.ts';
import { bgDate } from '../format.ts';
import { Button, Checkbox, Dialog, Field, Select, TextInput, cx } from '../components/ui.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { PeriodFields, ReportFrame, downloadXlsx, periodText, useReport, useYearPeriod, type Cell } from '../reports/common.tsx';
import { useCan, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import type { Session } from '../types.ts';

/* ------------------------------------------------------------------ */
/* Types of GET /statements/report, /abbreviated and /verify           */
/* ------------------------------------------------------------------ */

export type StatementCode = 'balance' | 'opr' | 'opp' | 'osk' | 'sda' | 'cr';
interface CellValue {
  key: string;
  cp: string;
  ep: string | null;
  /** Abbreviated lines: the aggregation of national cells. */
  source?: string;
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
  abbreviated?: boolean;
  columns: { identifier: string; description: string }[];
  rows: Row[];
}
interface Window {
  start: string;
  end: string;
}
interface GfoSection {
  title: string;
  lines: { key: string; description: string; headings: string[]; bold: boolean; source: string; cp: string; ep: string }[];
}
interface Run {
  periods: { cp: Window; ep: Window };
  lang: StatementLanguage;
  unit: string;
  thousands: boolean;
  statements: Statement[];
  /** "ГФО Микро" (micro format and the abbreviated export). */
  gfo: GfoSection[] | null;
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

/** Statements of the micro-enterprise format (abbreviated balance sheet and ОПР). */
const MICRO_CODES: (StatementCode | '')[] = ['', 'balance', 'opr'];

/** Halves of the two-sided forms. */
const SIDES: Partial<Record<StatementCode, [string, string][]>> = {
  balance: [['BalansCol1', 'А К Т И В'], ['BalansCol2', 'П А С И В']],
  opr: [['OPRCol1', 'Наименование на разходите'], ['OPRCol2', 'Наименование на приходите']],
};

/** Fixed texts of the printed forms and the workbook in both languages. */
const TEXTS = {
  bg: {
    of: (company: string) => `на ${company}`, at: (d: string) => `към ${d}`, period: (a: string, b: string) => `за периода ${a} - ${b}`, unit: (u: string) => `(в ${u})`,
    code: 'Код', current: 'Текуща година', previous: 'Предходна година', captions: 'Раздели, групи, статии', items: 'Показатели', lineCode: 'Код на реда',
    cashFlows: 'Наименование на паричните потоци', curPeriod: 'Текущ период', prevPeriod: 'Предходен период', flows: ['постъпления', 'плащания', 'нетен поток'],
    maker: 'Съставител', manager: 'Ръководител', company: 'Фирмени данни', checks: 'Проверка отчети', gfo: 'ГФО Микро', gfoTitle: 'ГОДИШЕН ФИНАНСОВ ОТЧЕТ НА МИКРОПРЕДПРИЯТИЕ',
    firm: 'Фирма', id: 'Идент. N', reportDate: 'Дата на отчета', start: 'Начална дата', end: 'Крайна дата', unitLabel: 'Мерна единица',
    check: 'Проверка', result: 'Резултат', diff: 'Разлика', message: 'Съобщение', ok: 'OK', error: 'Грешка', warning: 'Предупреждение',
  },
  en: {
    of: (company: string) => company, at: (d: string) => `as at ${d}`, period: (a: string, b: string) => `for the period ${a} - ${b}`, unit: (u: string) => `(in ${u})`,
    code: 'Code', current: 'Current year', previous: 'Previous year', captions: 'Sections, groups, items', items: 'Items', lineCode: 'Line code',
    cashFlows: 'Cash flows', curPeriod: 'Current period', prevPeriod: 'Previous period', flows: ['receipts', 'payments', 'net flow'],
    maker: 'Prepared by', manager: 'Manager', company: 'Company data', checks: 'Checks', gfo: 'Micro AFS', gfoTitle: 'ANNUAL FINANCIAL STATEMENT OF A MICRO-ENTERPRISE',
    firm: 'Company', id: 'ID No.', reportDate: 'Report date', start: 'Start date', end: 'End date', unitLabel: 'Unit',
    check: 'Check', result: 'Result', diff: 'Difference', message: 'Message', ok: 'OK', error: 'Error', warning: 'Warning',
  },
};
const textsOf = (run: Run) => TEXTS[run.lang ?? 'bg'];
const sideTitle = (title: string, run: Run) => (run.lang === 'en' ? captionEn(title) : title);

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
  const dialogs = useDialogs();
  const [f, setF] = useState({
    ...period,
    statement: 'balance' as StatementCode | '',
    format: 'national' as StatementFormat,
    lang: 'bg' as StatementLanguage,
    maker: '',
    contact: '',
    phone: '',
    thousands: false,
    usePrev: false,
    sameInterval: false,
  });
  const [checks, setChecks] = useState<Verification | null>(null);
  const [exporting, setExporting] = useState(false);
  const validate = (x: typeof f) => (x.from > x.to ? 'Началната дата е след крайната дата.' : null);
  /** The language choice applies to the NSI format only (as in Delta). */
  const langOf = (x: typeof f) => (x.format === 'nsi' ? x.lang : 'bg');
  const runQuery = (x: typeof f) => ({ from: x.from, to: x.to, thousands: x.thousands, usePrev: x.usePrev, sameInterval: x.sameInterval });
  const report = useReport(
    'financialStatements',
    f,
    async (x) => {
      const q = qs({ ...runQuery(x), statements: x.statement || undefined, format: x.format, lang: langOf(x) });
      const vq = qs({ ...runQuery(x), balanceOnly: x.statement === 'balance' });
      const [run, verify] = await Promise.all([api.get<Run>(`/statements/report${q}`), api.get<Verification>(`/statements/verify${vq}`)]);
      return { run, verify };
    },
    validate,
  );
  const a = report.applied ?? f;
  const subtitle = `${periodText(a)}${a.thousands ? ', в хиляди' : ''}`;
  const statementOptions = f.format === 'micro' ? STATEMENT_OPTIONS.filter(([v]) => MICRO_CODES.includes(v)) : STATEMENT_OPTIONS;

  /** "Експорт на съкратени отчети": abbreviated balance sheet and ОПР (+ ГФО Микро) as one workbook. */
  const exportAbbreviated = async () => {
    const err = validate(f);
    if (err) return void dialogs.alert(err);
    setExporting(true);
    try {
      const run = await api.get<Run>(`/statements/abbreviated${qs({ ...runQuery(f), lang: langOf(f) })}`);
      downloadXlsx(`Съкратени_отчети_${f.from}_${f.to}`, abbreviatedWorkbook(run, s, f));
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setExporting(false);
    }
  };

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
            <Button icon={<FileSpreadsheet className="size-3.5" />} disabled={exporting} onClick={() => void exportAbbreviated()}>
              Експорт на съкратени отчети
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
              <Select
                value={f.format}
                onChange={(e) => {
                  const format = e.target.value as StatementFormat;
                  setF({ ...f, format, statement: format === 'micro' && !MICRO_CODES.includes(f.statement) ? '' : f.statement });
                }}
                className="w-60"
                aria-label="Тип справка"
              >
                {STATEMENT_FORMATS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Отчети">
              <Select value={f.statement} onChange={(e) => setF({ ...f, statement: e.target.value as StatementCode | '' })} className="w-64" aria-label="Отчети">
                {statementOptions.map(([v, l]) => (
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
                <Field label="Език">
                  <Select value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value as StatementLanguage })} className="w-28" aria-label="Език">
                    {STATEMENT_LANGUAGES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
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
  const { run } = data;
  const t = textsOf(run);
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
        <section key={st.code} className="break-after-page" data-statement={st.code} data-abbreviated={st.abbreviated ? '' : undefined}>
          <FormHeader title={st.title} run={run} at={st.code === 'balance'} />
          <StatementBody st={st} run={run} />
        </section>
      ))}
      {run.gfo && (
        <section className="break-after-page" data-statement="gfo">
          <FormHeader title={t.gfoTitle} run={run} at={false} />
          <GfoTable run={run} sections={run.gfo} />
        </section>
      )}
      <div className="flex justify-between text-[12px]">
        <span>{t.maker}: {maker || '....................'}</span>
        <span>{t.manager}: ....................</span>
      </div>
    </div>
  );
}

function FormHeader({ title, run, at }: { title: string; run: Run; at: boolean }) {
  const s = useSession();
  const t = textsOf(run);
  return (
    <header className="mb-2 text-center">
      <h2 className="text-[15px] font-bold tracking-wide">{title}</h2>
      <div className="text-[12px]">{t.of(s.company.name)}{s.company.bulstat ? `, ${run.lang === 'en' ? 'UIC' : 'ЕИК'} ${s.company.bulstat}` : ''}</div>
      <div className="text-[12px]">{at ? t.at(bgDate(run.periods.cp.end)) : t.period(bgDate(run.periods.cp.start), bgDate(run.periods.cp.end))}</div>
      <div className="text-[11px] text-slate-600">{t.unit(run.unit)}</div>
    </header>
  );
}

/** ГФО Микро: one table, the three sections as group rows. */
function GfoTable({ run, sections }: { run: Run; sections: GfoSection[] }) {
  const v = useValue(run.thousands);
  const t = textsOf(run);
  return (
    <table className="grid-table max-w-[64rem] [&_thead_th]:bg-slate-200!" data-gfo>
      <thead>
        <tr className="hdr1">
          <th>{t.items}</th>
          <th className="w-20 text-center">{t.lineCode}</th>
          <th className="w-36 text-right">{t.current}</th>
          <th className="w-36 text-right">{t.previous}</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((sec) => (
          <Fragment key={sec.title}>
            <tr className="grp">
              <td colSpan={4}>{sec.title}</td>
            </tr>
            {sec.lines.map((l) => (
              <Fragment key={l.key}>
                {l.headings.map((h) => (
                  <tr key={h}>
                    <td colSpan={4} className="font-semibold">{h}</td>
                  </tr>
                ))}
                <tr data-key={l.key} title={l.source}>
                  <td className={cx('whitespace-normal', l.bold && 'font-semibold')}>{l.description}</td>
                  <td className="text-center text-[11px] text-slate-500">{l.key}</td>
                  <td className={cx('num', l.bold && 'font-semibold')}>{v(l.cp)}</td>
                  <td className={cx('num', l.bold && 'font-semibold')}>{v(l.ep)}</td>
                </tr>
              </Fragment>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
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
  const t = textsOf(run);
  return (
    <div className="flex flex-col gap-4">
      {SIDES[st.code]!.map(([col, title]) => {
        const rows = st.rows.filter((r) => r.cells[col]);
        return (
          <table key={col} className="grid-table max-w-[64rem] [&_thead_th]:bg-slate-200!" data-side={col}>
            <thead>
              <tr className="hdr1">
                <th className="text-center">{sideTitle(title, run)}</th>
                <th className="w-16 text-center">{t.code}</th>
                <th className="w-36 text-right">{t.current}</th>
                <th className="w-36 text-right">{t.previous}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = r.cells[col]!;
                return (
                  <Fragment key={r.identifier}>
                    <Headings r={r} span={4} />
                    <tr data-key={c.key} title={c.source}>
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
  const t = textsOf(run);
  return (
    <table className="grid-table max-w-[80rem] [&_thead_th]:bg-slate-200!">
      <thead>
        <tr className="hdr1">
          <th rowSpan={2}>{t.cashFlows}</th>
          <th colSpan={3} className="text-center">{t.curPeriod}</th>
          <th colSpan={3} className="text-center">{t.prevPeriod}</th>
        </tr>
        <tr className="hdr2">
          {[...t.flows, ...t.flows].map((h, i) => (
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
            <th className="min-w-72">{textsOf(run).items}</th>
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
const ABBREVIATED_SHEET_NAMES: Partial<Record<StatementCode, [string, string]>> = { balance: ['Съкратен баланс', 'Abbreviated balance'], opr: ['Съкратен ОПР', 'Abbreviated P&L'] };

const sheetName = (code: StatementCode, run: Run) => (run.lang === 'en' ? STATEMENT_TITLES_EN[code].sheet : SHEET_NAMES[code]);
const amountCell = (run: Run) => (v: string | null | undefined): XlsxCell => (v === null || v === undefined ? null : { v: Number(v), format: run.thousands ? 'integer' : 'amount' });

/** Title block of a form sheet: title, company, date or period, unit. */
function headerRows(title: string, run: Run, s: Session, at: boolean): XlsxCell[][] {
  const t = textsOf(run);
  return [[title], [t.of(s.company.name)], [at ? t.at(bgDate(run.periods.cp.end)) : t.period(bgDate(run.periods.cp.start), bgDate(run.periods.cp.end))], [t.unit(run.unit)], []];
}

function statementSheet(st: Statement, run: Run, s: Session, name = sheetName(st.code, run)): XlsxSheet {
  const n = amountCell(run);
  const t = textsOf(run);
  const rows = headerRows(st.title, run, s, st.code === 'balance');
  const bold: number[] = [0];
  const push = (r: XlsxCell[], isBold = false) => {
    if (isBold) bold.push(rows.length);
    rows.push(r);
  };
  if (SIDES[st.code]) {
    for (const [col, title] of SIDES[st.code]!) {
      push([sideTitle(title, run)], true);
      push([t.captions, t.code, t.current, t.previous], true);
      for (const r of st.rows.filter((x) => x.cells[col])) {
        for (const h of r.headings) push([h], true);
        const c = r.cells[col]!;
        push([r.description, c.key, n(c.cp), n(c.ep)], r.bold);
      }
      push([]);
    }
    return { name, rows, boldRows: bold, widths: [70, 8, 16, 16] };
  }
  if (st.code === 'opp') {
    push([t.cashFlows, t.curPeriod, '', '', t.prevPeriod], true);
    push(['', ...t.flows, ...t.flows], true);
    for (const r of st.rows) {
      for (const h of r.headings) push([h], true);
      const vals = [...cashFlowValues(r, 'cp'), ...cashFlowValues(r, 'ep')].map((x): XlsxCell => (x === null ? null : { v: x, format: run.thousands ? 'integer' : 'amount' }));
      push([r.description, ...vals], r.bold);
    }
    return { name, rows, boldRows: bold, widths: [70, 14, 14, 14, 14, 14, 14], merges: ['B6:D6', 'E6:G6'] };
  }
  push([t.items, ...st.columns.map((c) => c.description)], true);
  for (const r of st.rows) {
    for (const h of r.headings) push([h], true);
    push([r.description, ...st.columns.map((c) => n(r.cells[c.identifier]?.cp))], r.bold);
  }
  return { name, rows, boldRows: bold, widths: [60, ...st.columns.map(() => 16)] };
}

/** "ГФО Микро" sheet of the _micro workbook. */
function gfoSheet(run: Run, s: Session): XlsxSheet {
  const n = amountCell(run);
  const t = textsOf(run);
  const rows = headerRows(t.gfoTitle, run, s, false);
  const bold: number[] = [0];
  const push = (r: XlsxCell[], isBold = false) => {
    if (isBold) bold.push(rows.length);
    rows.push(r);
  };
  push([t.items, t.lineCode, t.current, t.previous], true);
  for (const sec of run.gfo ?? []) {
    push([sec.title], true);
    for (const l of sec.lines) {
      for (const h of l.headings) push([h], true);
      push([l.description, l.key, n(l.cp), n(l.ep)], l.bold);
    }
  }
  return { name: t.gfo, rows, boldRows: bold, widths: [70, 10, 16, 16] };
}

function companySheet(run: Run, s: Session, maker: string): XlsxSheet {
  const t = textsOf(run);
  const rows: XlsxCell[][] = [
    [t.company], [],
    [t.firm, s.company.name], [t.id, s.company.bulstat], [t.maker, maker], [t.reportDate, bgDate(s.workingDate)],
    [t.start, bgDate(run.periods.cp.start)], [t.end, bgDate(run.periods.cp.end)], [t.unitLabel, run.unit],
  ];
  return { name: t.company, rows, boldRows: [0], widths: [22, 50] };
}

/**
 * FinancialReportsAllExport: Фирмени данни, Проверка отчети and one sheet per
 * statement; the micro format adds "ГФО Микро", the NSI language choice gives
 * the English workbook.
 */
function workbook(d: Result, s: Session, f: { from: string; to: string; maker: string }): XlsxSheet[] {
  const t = textsOf(d.run);
  const checks: XlsxCell[][] = [
    [t.checks], [], [t.check, t.result, t.diff, t.message],
    ...d.verify.checks.map((c) => [c.id, c.ok ? t.ok : c.severity === 'critical' ? t.error : t.warning, Number(c.difference), c.message ?? ''] as XlsxCell[]),
    [], [d.verify.ok ? 'Данните са попълнени коректно.' : d.verify.message],
  ];
  return [
    companySheet(d.run, s, f.maker),
    { name: t.checks, rows: checks, boldRows: [0, 2], widths: [18, 16, 14, 100] },
    ...d.run.statements.map((st) => statementSheet(st, d.run, s)),
    ...(d.run.gfo ? [gfoSheet(d.run, s)] : []),
  ];
}

/** "Експорт на съкратени отчети": Фирмени данни, the abbreviated balance sheet and ОПР, ГФО Микро. */
function abbreviatedWorkbook(run: Run, s: Session, f: { maker: string }): XlsxSheet[] {
  const en = run.lang === 'en' ? 1 : 0;
  return [
    companySheet(run, s, f.maker),
    ...run.statements.map((st) => statementSheet(st, run, s, ABBREVIATED_SHEET_NAMES[st.code]?.[en] ?? sheetName(st.code, run))),
    gfoSheet(run, s),
  ];
}
