import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileArchive, FileCog } from 'lucide-react';
import { api, qs } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, Field, Select, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { bgDate, money, monthLabel } from '../../format.ts';
import { Amt, PeriodFields, ReportFrame, amt, periodText, useReport, type Cell } from '../../reports/common.tsx';
import { useSession } from '../../session.tsx';
import { DECLARATION_SECTIONS, PURCHASE_COLUMNS, SALE_COLUMNS, downloadUrl, prevMonth, type DiaryRow, type VatReportResult } from './common.tsx';
import { VirtualRows } from '../../components/VirtualRows.tsx';

/**
 * "ДДС дневници, декларация и VIES" (Alt+D, UI_Reporting_VATDiary; spec 05 7.1-7.5,
 * 04a 1): one options form, tabs for the return, both diaries, VIES and the NAP files.
 */

type Tab = 'declaration' | 'purchases' | 'sales' | 'vies' | 'files';
const TABS: [Tab, string][] = [['declaration', 'ДДС декларация'], ['purchases', 'Дневник покупки'], ['sales', 'Дневник продажби'], ['vies', 'VIES декларация'], ['files', 'Файлове за НАП']];

interface Filters {
  from: string;
  to: string;
  kl33: string;
  kl70: string;
  kl71: string;
  kl80: string;
  kl81: string;
  kl82: string;
  autoFillCell71: boolean;
  sortByEntry: boolean;
  /** "Разширени дневници" (TReportType AllExtended): entry number first, Забележка and Втора забележка last. */
  extended: boolean;
  createVies: boolean;
  subscriberName: string;
  subscriberEgn: string;
  subscriberRole: number;
}

const num = (v: string) => v.replace(',', '.').trim() || '0';
const body = (f: Filters) => ({ ...f, kl33: num(f.kl33), kl70: num(f.kl70), kl71: num(f.kl71), kl80: num(f.kl80), kl81: num(f.kl81), kl82: num(f.kl82) });

export function VatDiary() {
  const session = useSession();
  const defaults = useQuery({ queryKey: ['vat', 'defaults'], queryFn: () => api.get<{ from: string; to: string; kl33: string; subscriberName: string; subscriberEgn: string; subscriberRole: number }>('/vat/defaults'), staleTime: 0 });
  const [f, setF] = useState<Filters>({
    ...prevMonth(session.workingDate), kl33: '0,00', kl70: '', kl71: '', kl80: '', kl81: '', kl82: '',
    autoFillCell71: false, sortByEntry: false, extended: false, createVies: false, subscriberName: '', subscriberEgn: '', subscriberRole: 1,
  });
  const [init, setInit] = useState(false);
  const [tab, setTab] = useState<Tab>('declaration');
  useEffect(() => {
    if (!defaults.data || init) return;
    const d = defaults.data;
    setF((x) => ({ ...x, from: d.from, to: d.to, kl33: d.kl33.replace('.', ','), subscriberName: d.subscriberName, subscriberEgn: d.subscriberEgn, subscriberRole: d.subscriberRole || 1 }));
    setInit(true);
  }, [defaults.data, init]);

  const report = useReport('vatDiary', f, (x) => api.post<VatReportResult>('/vat/report', body(x)), (x) => (x.from > x.to ? 'Началната дата е след крайната.' : null));
  const a = report.applied ?? f;

  const csv = (d: VatReportResult): Cell[][] => {
    if (tab === 'sales' || tab === 'purchases') {
      const cols = tab === 'sales' ? SALE_COLUMNS : PURCHASE_COLUMNS;
      const rows = tab === 'sales' ? d.sales : d.purchases;
      const totals = tab === 'sales' ? d.salesTotals : d.purchasesTotals;
      const ext = a.extended;
      return [
        [...(ext ? ['Номер на контиране'] : []), '№', 'Клон', 'Вид', 'Номер', 'Дата', 'ИН на контрагента', 'Име на контрагента', 'Вид на стоката/услугата', '8а', ...cols.map(([n]) => `к${n}`), ...(ext ? ['Забележка', 'Втора забележка'] : [])],
        ...rows.map((r, i) => [
          ...(ext ? [r.accountingNumber] : []), i + 1, r.branchCode, r.documentCode, r.documentNumber, bgDate(r.documentDate), r.partnerVat, r.partnerName, r.description, r.vatDiaryCode,
          ...r.cols.map(amt), ...(ext ? [r.reference, r.optionalReference] : []),
        ]),
        [...(ext ? [''] : []), 'Общо:', '', '', '', '', '', '', '', '', ...totals.map(amt), ...(ext ? ['', ''] : [])],
      ];
    }
    if (tab === 'vies') return [['к2', 'к3', 'к4', 'к5', 'к6'], ...d.vies.part1.map((r) => [r.vatNumber ?? '', amt(r.k3), amt(r.k4), amt(r.k5), monthLabel(r.viesMonth)])];
    return [['Клетка', 'Описание', 'Стойност'], ...DECLARATION_SECTIONS.flatMap((s) => s.cells.map(([c, l]) => [c, l, amt(d.declaration[c])]))];
  };

  return (
    <ReportFrame<VatReportResult>
      title={a.extended ? 'ДДС дневници, декларация и VIES (разширени дневници)' : 'ДДС дневници, декларация и VIES'}
      subtitle={`Данъчен период ${periodText(a)}`}
      report={report}
      isEmpty={() => false}
      status={(d) => `${d.sales.length} продажби, ${d.purchases.length} покупки`}
      csvName={`ДДСДневници ДеклVIES${a.extended ? ' разширени' : ''}_${a.from}_${a.to}_${tab}`}
      csv={csv}
      filters={
        <>
          {!defaults.data && <Spinner />}
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Коеф. по кл.33">
            <TextInput className="num w-20" value={f.kl33} onChange={(e) => setF({ ...f, kl33: e.target.value })} aria-label="КЛ33" />
          </Field>
          {(['kl70', 'kl71', 'kl80', 'kl81', 'kl82'] as const).map((k) => (
            <Field key={k} label={`Клетка ${k.slice(2)}`}>
              <TextInput className="num w-24" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={k === 'kl71' && f.autoFillCell71} />
            </Field>
          ))}
          <Field label="Сортиране">
            <Select value={f.sortByEntry ? '1' : '0'} onChange={(e) => setF({ ...f, sortByEntry: e.target.value === '1' })}>
              <option value="0">Дата на документа</option>
              <option value="1">Ред на въвеждане</option>
            </Select>
          </Field>
          <Field label="Подаващ име">
            <TextInput className="w-44" value={f.subscriberName} onChange={(e) => setF({ ...f, subscriberName: e.target.value })} />
          </Field>
          <Field label="Подаващ ЕГН">
            <TextInput className="w-28" value={f.subscriberEgn} onChange={(e) => setF({ ...f, subscriberEgn: e.target.value })} />
          </Field>
          <Field label="В качеството на">
            <Select value={f.subscriberRole} onChange={(e) => setF({ ...f, subscriberRole: Number(e.target.value) })}>
              <option value={1}>Представляващ</option>
              <option value={2}>Пълномощник</option>
            </Select>
          </Field>
        </>
      }
      options={
        <>
          <Checkbox label="Създаване на VIES декларация" checked={f.createVies} onChange={(createVies) => setF({ ...f, createVies })} />
          <Checkbox label="Автоматично попълване на клетка 71" checked={f.autoFillCell71} onChange={(autoFillCell71) => setF({ ...f, autoFillCell71 })} />
          <Checkbox label="Разширени дневници" checked={f.extended} onChange={(extended) => setF({ ...f, extended })} />
        </>
      }
    >
      {(d) => (
        <div className="flex flex-col">
          <div className="flex gap-0.5 border-b border-slate-300 bg-slate-100 px-2 pt-1 print:hidden" role="tablist">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                className={cx('rounded-t-sm border border-b-0 px-3 py-1 text-[13px]', tab === k ? 'border-slate-300 bg-white font-semibold text-slate-900' : 'border-transparent text-slate-600 hover:bg-white/60')}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          {(d.messages.length > 0 || d.info) && (
            <div className="flex flex-col gap-0.5 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 print:hidden">
              {d.messages.map((m) => (
                <span key={m.key}>⚠ {m.text}</span>
              ))}
              {d.info && !a.createVies && <span>ℹ {d.info}</span>}
            </div>
          )}
          {tab === 'declaration' && <Declaration d={d} />}
          {tab === 'purchases' && <Diary rows={d.purchases} totals={d.purchasesTotals} columns={PURCHASE_COLUMNS} extended={a.extended} />}
          {tab === 'sales' && <Diary rows={d.sales} totals={d.salesTotals} columns={SALE_COLUMNS} extended={a.extended} />}
          {tab === 'vies' && <Vies d={d} />}
          {tab === 'files' && <NapFiles f={a} />}
        </div>
      )}
    </ReportFrame>
  );
}

function Declaration({ d }: { d: VatReportResult }) {
  return (
    <div className="grid max-w-5xl grid-cols-1 gap-3 p-3 lg:grid-cols-2">
      {DECLARATION_SECTIONS.map((s) => (
        <section key={s.title} className="rounded-sm border border-slate-300 bg-white">
          <h3 className="border-b border-slate-200 bg-slate-100 px-2 py-1 text-[12px] font-semibold">{s.title}</h3>
          <table className="w-full text-[12px]">
            <tbody>
              {s.cells.map(([c, label]) => (
                <tr key={c} className="border-b border-slate-100 last:border-0" data-cell={c}>
                  <td className="px-2 py-0.5 text-slate-700">{label}</td>
                  <td className="w-8 px-1 text-center font-mono text-slate-500">{c}</td>
                  <td className="w-32 px-2 text-right font-mono tabular-nums">{c === '33' ? Number(d.declaration[c]).toFixed(2).replace('.', ',') : money(Number(d.declaration[c]).toFixed(2))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function Diary({ rows, totals, columns, extended }: { rows: DiaryRow[]; totals: string[]; columns: [number, string][]; extended: boolean }) {
  if (!rows.length) return <div className="p-6 text-center text-slate-500">Няма документи за периода.</div>;
  return (
    <table className="grid-table">
      <thead>
        <tr>
          {extended && <th className="w-20">Номер на контиране</th>}
          <th className="w-10">№</th>
          <th>Клон</th>
          <th>Вид</th>
          <th>Номер</th>
          <th>Дата</th>
          <th>ИН на контрагента</th>
          <th>Име на контрагента</th>
          <th>Вид на стоката/услугата</th>
          <th title="Доставка по чл.163а ЗДДС или внос по чл.167а">8а</th>
          {columns.map(([n, t]) => (
            <th key={n} className="w-24 text-right" title={t}>
              к{n}
            </th>
          ))}
          {extended && (
            <>
              <th>Забележка</th>
              <th>Втора забележка</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        <VirtualRows count={rows.length} colSpan={9 + columns.length + (extended ? 3 : 0)} row={(i) => {
          const r = rows[i]!;
          return (
          <tr key={`${r.accountingId}-${i}`}>
            {extended && <td className="nowrap">{r.accountingNumber}</td>}
            <td className="num">{i + 1}</td>
            <td>{r.branchCode}</td>
            <td className="nowrap" title={r.documentCode}>{r.documentType}</td>
            <td className="nowrap">{r.documentNumber}</td>
            <td className="nowrap">{bgDate(r.documentDate)}</td>
            <td className="nowrap">{r.partnerVat}</td>
            <td className="max-w-[16rem] truncate" title={r.partnerName}>{r.partnerName}</td>
            <td className="max-w-[14rem] truncate" title={r.description}>{r.description}</td>
            <td>{r.vatDiaryCode}</td>
            {r.cols.map((c, j) => (
              <Amt key={j} v={c} />
            ))}
            {extended && (
              <>
                <td className="max-w-[14rem] truncate" title={r.reference}>{r.reference}</td>
                <td className="max-w-[14rem] truncate" title={r.optionalReference}>{r.optionalReference}</td>
              </>
            )}
          </tr>
          );
        }} />
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={extended ? 10 : 9}>Общо:</td>
          {totals.map((c, j) => (
            <Amt key={j} v={c} />
          ))}
          {extended && <td colSpan={2} />}
        </tr>
      </tfoot>
    </table>
  );
}

function Vies({ d }: { d: VatReportResult }) {
  const v = d.vies;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex gap-3 text-[12px]">
        {([['01', 'Данъчна основа - общо', money(v.totals['01'])], ['17', 'Данъчна основа на ВОД (сума на к3)', money(v.totals['17'])], ['02', 'Общ брой редове в раздел В', String(v.totals['02'])]] as const).map(([c, l, val]) => (
          <div key={c} className="rounded-sm border border-slate-300 bg-white px-3 py-1.5">
            <div className="text-slate-500">{l} <span className="font-mono">[{c}]</span></div>
            <div className="text-right font-mono text-[14px]">{val}</div>
          </div>
        ))}
      </div>
      <table className="grid-table max-w-5xl">
        <thead>
          <tr>
            <th className="w-12">к1</th>
            <th>к2 ИН по ДДС на получателя</th>
            <th>Име</th>
            <th className="text-right">к3 ВОД на стоки</th>
            <th className="text-right">к4 Посредник в тристранна операция</th>
            <th className="text-right">к5 Услуги по чл.21, ал.2</th>
            <th>к6 Период</th>
          </tr>
        </thead>
        <tbody>
          {v.part1.map((r, i) => (
            <tr key={i}>
              <td className="num">{i + 1}</td>
              <td>{r.vatNumber}</td>
              <td>{r.partnerName}</td>
              <Amt v={r.k3} />
              <Amt v={r.k4} />
              <Amt v={r.k5} />
              <td>{monthLabel(r.viesMonth)}</td>
            </tr>
          ))}
          {v.part2.map((r, i) => (
            <tr key={`p2-${i}`} className="text-slate-700">
              <td className="num">{v.part1.length + i + 1}</td>
              <td>{r.k2}</td>
              <td colSpan={3}>Код {r.k3} {r.k4}</td>
              <td />
              <td>{monthLabel(r.viesMonth)}</td>
            </tr>
          ))}
          {!v.part1.length && !v.part2.length && (
            <tr>
              <td colSpan={7} className="text-center text-slate-500">Няма данни за VIES декларация.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function NapFiles({ f }: { f: Filters }) {
  const dialogs = useDialogs();
  const [files, setFiles] = useState<{ folder: string; files: { name: string; lines: string[]; size: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const q = qs({ ...body(f), createVies: f.createVies, autoFillCell71: f.autoFillCell71, sortByEntry: f.sortByEntry });
  const generate = async () => {
    setBusy(true);
    try {
      setFiles(await api.post('/vat/files', body(f)));
    } catch (e) {
      await dialogs.error(e, 'Грешка при изготвянето на файловете');
    } finally {
      setBusy(false);
    }
  };
  const get = (name: string) => downloadUrl(`/vat/files/${name}${q}`, name).catch((e) => dialogs.error(e));
  const names = ['POKUPKI.TXT', 'PRODAGBI.TXT', 'DEKLAR.TXT', ...(f.createVies ? ['VIES.TXT'] : [])];
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<FileCog className="size-3.5" />} onClick={generate} disabled={busy}>
          Създаване на файловете
        </Button>
        {names.map((n) => (
          <Button key={n} icon={<Download className="size-3.5" />} onClick={() => void get(n)}>
            {n}
          </Button>
        ))}
        <Button icon={<FileArchive className="size-3.5" />} onClick={() => void downloadUrl(`/vat/files.zip${q}`, 'NAP.zip').catch((e) => dialogs.error(e))}>
          Всички (ZIP)
        </Button>
        <span className="text-[12px] text-slate-500">Папка {f.to.slice(5, 7)}.{f.to.slice(0, 4)}, кодировка Windows-1251, редове CR LF.</span>
      </div>
      {busy && <Spinner />}
      {files && (
        <div className="flex flex-col gap-3">
          {files.files.map((x) => (
            <section key={x.name} className="rounded-sm border border-slate-300 bg-white" data-file={x.name}>
              <h3 className="flex justify-between border-b border-slate-200 bg-slate-100 px-2 py-1 text-[12px] font-semibold">
                <span>{files.folder}/{x.name}</span>
                <span className="font-normal text-slate-500">{x.lines.length} реда, {x.size} байта</span>
              </h3>
              <pre className="max-h-56 overflow-auto px-2 py-1 font-mono text-[11px] leading-4 whitespace-pre">{x.lines.join('\n') || '(празен файл)'}</pre>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
