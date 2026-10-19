import { useState } from 'react';
import { REPORT_SHORT_NAMES, depreciationPlanShortName, depreciationQuotasShortName } from '@shmi/core';
import { api, qs } from '../api.ts';
import { Checkbox, Field, Select, TextInput } from '../components/ui.tsx';
import { bgDate, money } from '../format.ts';
import { useSession } from '../session.tsx';
import { AccountNumberPicker, Amt, ReportFrame, amt, useReport, type Cell } from '../reports/common.tsx';
import { LocationSelect, MONTH_SHORT, subtreeIds, useLocations } from './common.tsx';

const endOfMonth = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Location id list of the chosen node and its sub-groups ("" = all). */
function useLocationIds(id: number | null) {
  const { data = [] } = useLocations();
  return id ? subtreeIds(data, id).join(',') : '';
}

/* ------------------------------------------------------------------ */
/* Месечни амортизационни квоти                                        */
/* ------------------------------------------------------------------ */

interface QuotaYear { year: number; months: string[]; total: string; before: string; cost: string; bookValue: string }
interface Quotas { assets: { id: number; inventoryNumber: string; name: string; startDate: string; cost: string; total: string; years: QuotaYear[] }[]; monthTotals: string[]; total: string; currency: string }

export function DepreciationQuotasReport() {
  const s = useSession();
  const [f, setF] = useState({ year: String(s.year.year), type: 'sap', inventoryNumber: '', name: '', account: '', locationId: null as number | null });
  const locationIds = useLocationIds(f.locationId);
  const report = useReport('assetQuotas', { ...f, locationIds }, (x) => api.get<Quotas>(`/reports/assets/quotas${qs({ year: x.year, type: x.type, inventoryNumber: x.inventoryNumber, name: x.name, account: x.account, locationIds: x.locationIds })}`));
  const a = report.applied ?? f;
  const title = a.type === 'sap' ? 'Месечни амортизационни квоти (счетоводни)' : 'Месечни амортизационни квоти (данъчни)';
  const csv = (d: Quotas): Cell[][] => [
    ['Инв. номер', 'Наименование', 'Отчетна стойност', 'Амортизации към предходна година', 'Дата на въвеждане', 'Год.', ...MONTH_SHORT, 'Общо за година', 'Балансова стойност'],
    ...d.assets.flatMap((r) => r.years.map((y) => [r.inventoryNumber, r.name, amt(y.cost), amt(y.before), bgDate(r.startDate), String(y.year), ...y.months.map(amt), amt(y.total), amt(y.bookValue)])),
    ['Общо:', '', '', '', '', '', ...d.monthTotals.map(amt), amt(d.total), ''],
  ];
  return (
    <ReportFrame<Quotas>
      title={title}
      subtitle={a.year ? `за ${a.year} г.` : 'всички години'}
      report={report}
      isEmpty={(d) => d.assets.length === 0}
      status={(d) => `${d.assets.length} актива, ${d.currency}`}
      csvName={`${depreciationQuotasShortName(a.type)}_${a.year || 'all'}`}
      csv={csv}
      filters={
        <>
          <Field label="Година">
            <TextInput className="w-24" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, '') })} placeholder="всички" />
          </Field>
          <Field label="Тип на амортизацията">
            <Select className="w-48" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="sap">Счетоводна (САП)</option>
              <option value="dap">Данъчна (ДАП)</option>
            </Select>
          </Field>
          <Field label="Инвентарен номер"><TextInput className="w-32" value={f.inventoryNumber} onChange={(e) => setF({ ...f, inventoryNumber: e.target.value })} /></Field>
          <Field label="Име на актив"><TextInput className="w-44" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <LocationSelect value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
          <Field label="Сметка"><AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-52" /></Field>
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Инв. №</th><th>Наименование</th><th className="text-right">Отчетна ст-ст</th><th className="text-right">Към предх. год.</th><th>Въведен</th><th>Год.</th>
              {MONTH_SHORT.map((m) => <th key={m} className="text-right">{m}</th>)}
              <th className="text-right">Общо</th><th className="text-right">Балансова ст-ст</th>
            </tr>
          </thead>
          <tbody>
            {d.assets.flatMap((r) => r.years.map((y, i) => (
              <tr key={`${r.id}-${y.year}`}>
                <td>{i === 0 ? r.inventoryNumber : ''}</td>
                <td className="max-w-60 truncate" title={r.name}>{i === 0 ? r.name : ''}</td>
                <Amt v={y.cost} />
                <Amt v={y.before} />
                <td>{i === 0 ? bgDate(r.startDate) : ''}</td>
                <td>{y.year}</td>
                {y.months.map((m, k) => <Amt key={k} v={m} />)}
                <Amt v={y.total} className="font-semibold" />
                <Amt v={y.bookValue} />
              </tr>
            )))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6}>Общо:</td>
              {d.monthTotals.map((m, k) => <Amt key={k} v={m} />)}
              <Amt v={d.total} />
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Инвентарна книга                                                    */
/* ------------------------------------------------------------------ */

interface BookRow { id: number; inventoryNumber: string; name: string; serialNumber: string; location: string; acquisitionDate: string; startDate: string; finalDate: string | null; endDate: string | null; activeYears: number; cost: string; revaluationReserve: string; personInCharge: string; accrued: string; bookValue: string; account: string }
interface Book { rows: BookRow[]; totals: { cost: string; revaluationReserve: string; accrued: string; bookValue: string }; currency: string }

export function InventoryBookReport() {
  const s = useSession();
  const [f, setF] = useState({ toDate: s.workingDate, inventoryNumber: '', name: '', account: '', mol: '', note: '', serialNumber: '', locationId: null as number | null });
  const locationIds = useLocationIds(f.locationId);
  const report = useReport('assetBook', { ...f, locationIds }, (x) => api.get<Book>(`/reports/assets/inventory-book${qs({ toDate: x.toDate, inventoryNumber: x.inventoryNumber, name: x.name, account: x.account, mol: x.mol, note: x.note, serialNumber: x.serialNumber, locationIds: x.locationIds })}`));
  const a = report.applied ?? f;
  const csv = (d: Book): Cell[][] => [
    ['Инв. номер', 'Дълготраен актив', 'Сериен номер', 'Местоположение', 'Дата на придобиване', 'Дата на въвеждане', 'Дата на отписване', 'Дата на изхабяване', 'Години', 'Отчетна стойност', 'Пр. резерв', 'МОЛ', 'Начислени амортизации', 'Балансова стойност'],
    ...d.rows.map((r) => [r.inventoryNumber, r.name, r.serialNumber, r.location, bgDate(r.acquisitionDate), bgDate(r.startDate), bgDate(r.finalDate), bgDate(r.endDate), String(r.activeYears), amt(r.cost), amt(r.revaluationReserve), r.personInCharge, amt(r.accrued), amt(r.bookValue)]),
    ['Общо:', '', '', '', '', '', '', '', '', amt(d.totals.cost), amt(d.totals.revaluationReserve), '', amt(d.totals.accrued), amt(d.totals.bookValue)],
  ];
  return (
    <ReportFrame<Book>
      title="Инвентарна книга"
      subtitle={`към ${bgDate(a.toDate)}`}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} актива, ${d.currency}`}
      csvName={`${REPORT_SHORT_NAMES.strInventoryBookShortName}_${a.toDate}`}
      csv={csv}
      filters={
        <>
          <Field label="Към дата"><TextInput type="date" className="w-36" value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} required /></Field>
          <Field label="Инвентарен номер"><TextInput className="w-28" value={f.inventoryNumber} onChange={(e) => setF({ ...f, inventoryNumber: e.target.value })} /></Field>
          <Field label="Име на актив"><TextInput className="w-40" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <LocationSelect value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
          <Field label="Сметка"><AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-48" /></Field>
          <Field label="МОЛ"><TextInput className="w-32" value={f.mol} onChange={(e) => setF({ ...f, mol: e.target.value })} /></Field>
          <Field label="Забележка"><TextInput className="w-28" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Field label="Сериен номер"><TextInput className="w-28" value={f.serialNumber} onChange={(e) => setF({ ...f, serialNumber: e.target.value })} /></Field>
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Инв. №</th><th>Дълготраен актив</th><th>Сериен №</th><th>Местоположение</th><th>Придобит</th><th>Въведен</th><th>Отписан</th><th>Изхабяване</th><th className="text-right">Год.</th>
              <th className="text-right">Отчетна ст-ст</th><th className="text-right">Пр. резерв</th><th>МОЛ</th><th className="text-right">Начислени аморт.</th><th className="text-right">Балансова ст-ст</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.inventoryNumber}</td><td className="max-w-60 truncate" title={r.name}>{r.name}</td><td>{r.serialNumber}</td><td className="max-w-40 truncate">{r.location}</td>
                <td>{bgDate(r.acquisitionDate)}</td><td>{bgDate(r.startDate)}</td><td>{bgDate(r.finalDate)}</td><td>{bgDate(r.endDate)}</td><td className="num">{r.activeYears}</td>
                <Amt v={r.cost} /><Amt v={r.revaluationReserve} /><td>{r.personInCharge}</td><Amt v={r.accrued} /><Amt v={r.bookValue} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={9}>Общо:</td><Amt v={d.totals.cost} /><Amt v={d.totals.revaluationReserve} /><td /><Amt v={d.totals.accrued} /><Amt v={d.totals.bookValue} /></tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Амортизационен план                                                 */
/* ------------------------------------------------------------------ */

type PlanRow = Record<string, string | number | null>;
interface PlanReport { rows: PlanRow[]; totals: Record<string, string>; currency: string }
const SORTS: [string, string][] = [['inventoryNumber', 'Инвентарен номер'], ['name', 'Наименование'], ['startDate', 'Дата на въвеждане'], ['endDate', 'Дата на изхабяване']];

export function DepreciationPlanReport() {
  const s = useSession();
  const [f, setF] = useState({ month: s.workingDate.slice(0, 7), type: 'sap', sort: 'inventoryNumber', showWrittenOff: false, inventoryNumber: '', name: '', account: '', note: '', serialNumber: '', locationId: null as number | null });
  const locationIds = useLocationIds(f.locationId);
  const report = useReport('assetPlan', { ...f, locationIds }, (x) => api.get<PlanReport>(`/reports/assets/plan${qs({ month: `${x.month}-01`, type: x.type, sort: x.sort, showWrittenOff: x.showWrittenOff, inventoryNumber: x.inventoryNumber, name: x.name, account: x.account, note: x.note, serialNumber: x.serialNumber, locationIds: x.locationIds })}`), (x) => (x.month ? null : 'Изберете месец.'));
  const a = report.applied ?? f;
  const ias = a.type === 'ias';
  const title = a.type === 'sap' ? 'Амортизационен план (САП)' : a.type === 'dap' ? 'Амортизационен план (ДАП)' : 'Преоценка ДА по МСС';
  const cols: [string, string, 'amt' | 'date' | 'text' | 'pct'][] = [
    ['inventoryNumber', 'Инв. №', 'text'], ['name', 'Наименование', 'text'], ['startDate', 'Въведен', 'date'], ['finalDate', 'Отписан', 'date'], ['years', 'Год.', 'text'],
    ['cost', 'Отчетна ст-ст', 'amt'], ['nonDepreciableAmount', 'Неамортиз. ст-ст', 'amt'], ['depreciableAmount', 'Амортиз. ст-ст', 'amt'], ['accrued', 'Начислени аморт.', 'amt'],
    ['previousYears', 'Към предх. год.', 'amt'], ['remainder', 'Остатъчна ст-ст', 'amt'], ['bookValue', 'Балансова ст-ст', 'amt'], ['percentage', 'Год. норма %', 'pct'],
    ['currentYear', 'Начислени за год.', 'amt'], ['yearQuota', 'Годишна квота', 'amt'], ['monthQuota', 'Месечна квота', 'amt'],
    ...(ias ? ([['oldValue', 'Стара стойност', 'amt'], ['newValue', 'Нова стойност', 'amt'], ['difference', 'Разлика', 'amt']] as [string, string, 'amt'][]) : []),
    ['endDate', 'Изхабяване', 'date'], ['personInCharge', 'МОЛ', 'text'], ['location', 'Местоположение', 'text'],
  ];
  const cell = (r: PlanRow, k: string, t: string) => (t === 'date' ? bgDate(r[k] as string | null) : t === 'pct' ? String(r[k]).replace('.', ',') : r[k] ?? '');
  const csv = (d: PlanReport): Cell[][] => [cols.map((c) => c[1]), ...d.rows.map((r) => cols.map(([k, , t]) => (t === 'amt' ? amt(r[k] as string) : String(cell(r, k, t)))))];
  return (
    <ReportFrame<PlanReport>
      title={title}
      subtitle={`към месец ${a.month.slice(5, 7)}.${a.month.slice(0, 4)} (до ${bgDate(endOfMonth(`${a.month}-01`))})`}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} актива, ${d.currency}`}
      csvName={`${depreciationPlanShortName(a.type)}_${a.month}`}
      csv={csv}
      filters={
        <>
          <Field label="Към месец"><TextInput type="month" className="w-36" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} required /></Field>
          <Field label="Тип">
            <Select className="w-44" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="sap">САП</option>
              <option value="dap">ДАП</option>
              <option value="ias">Преоценка ДА по МСС</option>
            </Select>
          </Field>
          <Field label="Инвентарен номер"><TextInput className="w-28" value={f.inventoryNumber} onChange={(e) => setF({ ...f, inventoryNumber: e.target.value })} /></Field>
          <Field label="Име на актив"><TextInput className="w-40" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <LocationSelect value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
          <Field label="Сметка"><AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-48" /></Field>
          <Field label="Сортиране">
            <Select className="w-40" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Забележка"><TextInput className="w-28" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Field label="Сериен номер"><TextInput className="w-28" value={f.serialNumber} onChange={(e) => setF({ ...f, serialNumber: e.target.value })} /></Field>
        </>
      }
      options={<Checkbox label="Показване на амортизирани активи" checked={f.showWrittenOff} onChange={(showWrittenOff) => setF({ ...f, showWrittenOff })} />}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>{cols.map(([k, l, t]) => <th key={k} className={t === 'amt' || t === 'pct' ? 'text-right' : ''}>{l}</th>)}</tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id as number}>
                {cols.map(([k, , t]) => (t === 'amt' ? <Amt key={k} v={r[k] as string} /> : <td key={k} className={t === 'pct' ? 'num' : k === 'name' ? 'max-w-60 truncate' : ''}>{cell(r, k, t)}</td>))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>{cols.map(([k, , t], i) => (i === 0 ? <td key={k}>Общо:</td> : t === 'amt' && d.totals[k] !== undefined ? <Amt key={k} v={d.totals[k]} /> : <td key={k} />))}</tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Активи по категории (ДАП)                                           */
/* ------------------------------------------------------------------ */

interface CatRow { id: number; inventoryNumber: string; name: string; categoryId: number; category: string; totalValue: string; totalDepreciations: string; currentYear: string }
interface ByCategories { rows: CatRow[]; categories: { categoryId: number; category: string; totalValue: string; totalDepreciations: string; currentYear: string }[]; totals: { totalValue: string; totalDepreciations: string; currentYear: string }; currency: string }

export function AssetsByCategoriesReport() {
  const s = useSession();
  const [f, setF] = useState({ year: String(s.year.year), filterBy: 'name', filter: '', level: 'assets', locationId: null as number | null });
  const locationIds = useLocationIds(f.locationId);
  const report = useReport('assetCategories', { ...f, locationIds }, (x) => api.get<ByCategories>(`/reports/assets/by-categories${qs({ year: x.year, filterBy: x.filterBy, filter: x.filter, locationIds: x.locationIds })}`), (x) => (/^\d{4}$/.test(x.year) ? null : 'Въведете година.'));
  const a = report.applied ?? f;
  const csv = (d: ByCategories): Cell[][] => [
    ['Категория', 'Инв. номер', 'Наименование', 'Данъчна амортизируема стойност', 'Начислени данъчни амортизации', 'Данъчни амортизации за годината'],
    ...d.categories.flatMap((c) => [
      ...(a.level === 'assets' ? d.rows.filter((r) => r.categoryId === c.categoryId).map((r) => [c.category, r.inventoryNumber, r.name, amt(r.totalValue), amt(r.totalDepreciations), amt(r.currentYear)]) : []),
      [c.category, 'Общо за категорията', '', amt(c.totalValue), amt(c.totalDepreciations), amt(c.currentYear)],
    ]),
    ['Общо:', '', '', amt(d.totals.totalValue), amt(d.totals.totalDepreciations), amt(d.totals.currentYear)],
  ];
  return (
    <ReportFrame<ByCategories>
      title={a.level === 'assets' ? 'Активи по категории (ДА НАП по активи)' : 'Активи по категории (ДА НАП)'}
      subtitle={`към 31.12.${a.year} г.`}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} актива, ${d.currency}`}
      csvName={`${a.level === 'assets' ? REPORT_SHORT_NAMES.strAssetsByCategoriesByAssetsShortName : REPORT_SHORT_NAMES.strAssetsByCategoriesShortName}_${a.year}`}
      csv={csv}
      filters={
        <>
          <Field label="Година"><TextInput className="w-24" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Филтър по">
            <Select className="w-40" value={f.filterBy} onChange={(e) => setF({ ...f, filterBy: e.target.value })}>
              <option value="name">Наименование</option>
              <option value="inventoryNumber">Инвентарен номер</option>
            </Select>
          </Field>
          <Field label="Филтър"><TextInput className="w-40" value={f.filter} onChange={(e) => setF({ ...f, filter: e.target.value })} /></Field>
          <LocationSelect value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
          <Field label="Ниво на справка">
            <Select className="w-40" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>
              <option value="assets">По активи</option>
              <option value="categories">По категории</option>
            </Select>
          </Field>
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr><th>Инв. №</th><th>Наименование</th><th className="text-right">Данъчна амортизируема стойност</th><th className="text-right">Начислени данъчни амортизации</th><th className="text-right">Данъчни амортизации за годината</th></tr>
          </thead>
          <tbody>
            {d.categories.flatMap((c) => [
              <tr key={`c${c.categoryId}`} className="grp"><td colSpan={5}>{c.category}</td></tr>,
              ...(a.level === 'assets' ? d.rows.filter((r) => r.categoryId === c.categoryId).map((r) => (
                <tr key={r.id}><td>{r.inventoryNumber}</td><td className="max-w-80 truncate">{r.name}</td><Amt v={r.totalValue} /><Amt v={r.totalDepreciations} /><Amt v={r.currentYear} /></tr>
              )) : []),
              <tr key={`t${c.categoryId}`} className="font-semibold"><td colSpan={2}>Общо за категорията</td><Amt v={c.totalValue} /><Amt v={c.totalDepreciations} /><Amt v={c.currentYear} /></tr>,
            ])}
          </tbody>
          <tfoot>
            <tr><td colSpan={2}>Общо:</td><Amt v={d.totals.totalValue} /><Amt v={d.totals.totalDepreciations} /><Amt v={d.totals.currentYear} /></tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Инвентаризационен опис на ДМА (по МОЛ)                              */
/* ------------------------------------------------------------------ */

interface MolRow { id: number; personInCharge: string; inventoryNumber: string; name: string; serialNumber: string; cost: string; accrued: string; startDate: string; location: string; account: string }
interface MolReport { groups: { personInCharge: string; rows: MolRow[]; cost: string; accrued: string }[]; mols: string[]; totals: { cost: string; accrued: string }; currency: string }

export function InventoryListMolReport() {
  const s = useSession();
  const [f, setF] = useState({ date: s.workingDate, account: '', mol: '', locationId: null as number | null, precept: '', preceptDate: '', accountant: '', chairman: '', members: '', producer: '' });
  const [mols, setMols] = useState<string[]>([]);
  const locationIds = useLocationIds(f.locationId);
  const report = useReport('assetMol', { date: f.date, account: f.account, mol: f.mol, locationIds }, async (x) => {
    const r = await api.get<MolReport>(`/reports/assets/inventory-mol${qs(x)}`);
    setMols(r.mols);
    return r;
  });
  const a = report.applied ?? { date: f.date };
  const csv = (d: MolReport): Cell[][] => [
    ['МОЛ', 'Инв. номер', 'Наименование', 'Сериен номер', 'Отчетна стойност', 'Начислени амортизации', 'Дата на въвеждане', 'Местоположение', 'Наличност', 'Липса', 'Излишък', 'Забележка'],
    ...d.groups.flatMap((g) => g.rows.map((r) => [g.personInCharge, r.inventoryNumber, r.name, r.serialNumber, amt(r.cost), amt(r.accrued), bgDate(r.startDate), r.location, '', '', '', ''])),
  ];
  return (
    <ReportFrame<MolReport>
      title="Инвентаризационен опис на ДМА"
      subtitle={`към ${bgDate(a.date)}${f.precept ? `, по заповед № ${f.precept}${f.preceptDate ? ` от ${bgDate(f.preceptDate)}` : ''}` : ''}`}
      report={report}
      isEmpty={(d) => d.groups.length === 0}
      status={(d) => `${d.groups.length} МОЛ, ${d.currency}`}
      csvName={`ОписДМА_${a.date}`}
      csv={csv}
      filters={
        <>
          <Field label="Към дата"><TextInput type="date" className="w-36" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
          <Field label="Сметка"><AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-48" /></Field>
          <LocationSelect value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
          <Field label="МОЛ">
            <TextInput className="w-40" list="asset-mols" value={f.mol} onChange={(e) => setF({ ...f, mol: e.target.value })} />
            <datalist id="asset-mols">{mols.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
          <Field label="Заповед №"><TextInput className="w-24" value={f.precept} onChange={(e) => setF({ ...f, precept: e.target.value })} /></Field>
          <Field label="От дата"><TextInput type="date" className="w-36" value={f.preceptDate} onChange={(e) => setF({ ...f, preceptDate: e.target.value })} /></Field>
        </>
      }
      options={
        <>
          <Field label="Счетоводител"><TextInput className="w-40" value={f.accountant} onChange={(e) => setF({ ...f, accountant: e.target.value })} /></Field>
          <Field label="Председател"><TextInput className="w-40" value={f.chairman} onChange={(e) => setF({ ...f, chairman: e.target.value })} /></Field>
          <Field label="Членове"><TextInput className="w-56" value={f.members} onChange={(e) => setF({ ...f, members: e.target.value })} /></Field>
          <Field label="Изготвил"><TextInput className="w-40" value={f.producer} onChange={(e) => setF({ ...f, producer: e.target.value })} /></Field>
        </>
      }
    >
      {(d) => (
        <div>
          <table className="grid-table">
            <thead>
              <tr>
                <th>Инв. №</th><th>Наименование</th><th>Сериен №</th><th className="text-right">Отчетна стойност</th><th className="text-right">Начислени амортизации</th><th>Въведен</th><th>Местоположение</th>
                <th>Наличност</th><th>Липса</th><th>Излишък</th><th>Забележка</th>
              </tr>
            </thead>
            <tbody>
              {d.groups.flatMap((g) => [
                <tr key={`g-${g.personInCharge}`} className="grp"><td colSpan={11}>МОЛ: {g.personInCharge || '(без МОЛ)'}</td></tr>,
                ...g.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.inventoryNumber}</td><td className="max-w-72 truncate">{r.name}</td><td>{r.serialNumber}</td><Amt v={r.cost} /><Amt v={r.accrued} /><td>{bgDate(r.startDate)}</td><td>{r.location}</td>
                    <td className="w-20" /><td className="w-20" /><td className="w-20" /><td className="w-28" />
                  </tr>
                )),
                <tr key={`t-${g.personInCharge}`} className="font-semibold"><td colSpan={3}>Общо за {g.personInCharge || '(без МОЛ)'}</td><Amt v={g.cost} /><Amt v={g.accrued} /><td colSpan={6} /></tr>,
              ])}
            </tbody>
            <tfoot>
              <tr><td colSpan={3}>Общо:</td><Amt v={d.totals.cost} /><Amt v={d.totals.accrued} /><td colSpan={6} /></tr>
            </tfoot>
          </table>
          <div className="mt-4 grid grid-cols-2 gap-2 px-3 pb-3 text-[12px]">
            <div>Комисия в състав: председател {f.chairman || '....................'}; членове {f.members || '....................'}</div>
            <div>Счетоводител: {f.accountant || '....................'}; изготвил: {f.producer || '....................'}</div>
            <div>{money(d.totals.cost)} {d.currency} обща отчетна стойност</div>
          </div>
        </div>
      )}
    </ReportFrame>
  );
}
