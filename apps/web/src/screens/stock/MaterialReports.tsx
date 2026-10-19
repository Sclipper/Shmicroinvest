import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api.ts';
import { bgDate, money } from '../../format.ts';
import { Checkbox, Field, Select, TextInput } from '../../components/ui.tsx';
import { useLookups, useSession } from '../../session.tsx';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useYearPeriod, type Cell } from '../../reports/common.tsx';

/* ------------------------------------------------------------------ */
/* Shared filters (spec 05 7.9 "Layout to rebuild")                    */
/* ------------------------------------------------------------------ */

interface Filters {
  from: string;
  to: string;
  account: string;
  product: string;
  code: string;
  company: string;
  documentTypeId: string;
  documentNumber: string;
  fromNumber: string;
  toNumber: string;
  english: boolean;
}

const qty = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('bg-BG', { maximumFractionDigits: 6 }));
const qtyCell = (v: string | number | null | undefined): Cell => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));

function useProductNames() {
  const { data = [] } = useQuery({ queryKey: ['products', 'options'], queryFn: () => api.get<{ id: number; name: string; code: string | null }[]>('/stock/product-options'), staleTime: 60_000 });
  return data;
}

function useFilters(): [Filters, (p: Partial<Filters>) => void] {
  const period = useYearPeriod();
  const [f, setF] = useState<Filters>({ ...period, account: '', product: '', code: '', company: '', documentTypeId: '', documentNumber: '', fromNumber: '', toNumber: '', english: false });
  return [f, (p) => setF((x) => ({ ...x, ...p }))];
}

/** The product name box: picking a name from the list matches it exactly, typing matches a substring (05 7.9). */
function ProductNameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const names = useProductNames();
  const id = useId();
  return (
    <Field label="Стока">
      <TextInput value={value} list={id} className="w-48" onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>
        {[...new Set(names.map((n) => n.name))].map((n) => <option key={n} value={n} />)}
      </datalist>
    </Field>
  );
}

function materialQs(f: Filters, names: { name: string }[]) {
  const exact = !!f.product.trim() && names.some((n) => n.name === f.product.trim());
  return qs({
    from: f.from, to: f.to, account: f.account, product: f.product.trim(), nameExact: exact, code: f.code.trim(), company: f.company.trim(),
    documentTypeId: f.documentTypeId, documentNumber: f.documentNumber.trim(), fromNumber: f.fromNumber.trim(), toNumber: f.toNumber.trim(),
  });
}

function CommonFields({ f, set, partner, entryNumbers }: { f: Filters; set: (p: Partial<Filters>) => void; partner?: boolean; entryNumbers?: boolean }) {
  const lookups = useLookups();
  return (
    <>
      <PeriodFields value={f} onChange={(p) => set(p)} />
      {entryNumbers && (
        <>
          <Field label="От № контиране">
            <TextInput value={f.fromNumber} inputMode="numeric" className="w-24" onChange={(e) => set({ fromNumber: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="До № контиране">
            <TextInput value={f.toNumber} inputMode="numeric" className="w-24" onChange={(e) => set({ toNumber: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </>
      )}
      <Field label="Сметка">
        <AccountNumberPicker value={f.account} onChange={(account) => set({ account })} className="w-48" />
      </Field>
      <ProductNameField value={f.product} onChange={(product) => set({ product })} />
      <Field label="Код">
        <TextInput value={f.code} className="w-24" onChange={(e) => set({ code: e.target.value })} />
      </Field>
      {partner && (
        <>
          <Field label="Партньор">
            <TextInput value={f.company} className="w-48" onChange={(e) => set({ company: e.target.value })} />
          </Field>
          <Field label="Тип документ">
            <Select value={f.documentTypeId} className="w-44" onChange={(e) => set({ documentTypeId: e.target.value })}>
              <option value="">Всички</option>
              {lookups.data?.documentTypes.filter((d) => d.isVisible).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Документ №">
            <TextInput value={f.documentNumber} className="w-32" onChange={(e) => set({ documentNumber: e.target.value })} />
          </Field>
        </>
      )}
    </>
  );
}

const englishBox = (f: Filters, set: (p: Partial<Filters>) => void) => <Checkbox label="Наименование на сметки на чужд език" checked={f.english} onChange={(english) => set({ english })} />;

function subtitleOf(f: Filters, extra: (string | false)[] = []) {
  return [periodText(f), f.account && `сметка ${f.account}`, f.product.trim() && `стока ${f.product.trim()}`, f.code.trim() && `код ${f.code.trim()}`, f.company.trim() && `партньор ${f.company.trim()}`, ...extra].filter(Boolean).join(', ');
}

/* ------------------------------------------------------------------ */
/* Доставки / Продажби                                                 */
/* ------------------------------------------------------------------ */

interface DeliveryRow {
  accounting_number: string; accounting_date: string; account_number: string; account_description: string; english_description: string | null;
  product_code: string | null; product_name: string; product_measure: string; quantity: string; price: string;
  company_name: string | null; document_number: string | null; document_date: string | null; document_type: string | null; amount: string;
}

function DeliverySale({ isPurchase }: { isPurchase: boolean }) {
  const [f, set] = useFilters();
  const names = useProductNames();
  const url = isPurchase ? '/reports/stock/purchases' : '/reports/stock/sales';
  const report = useReport(isPurchase ? 'stockPurchases' : 'stockSales', f, (x) => api.get<DeliveryRow[]>(`${url}${materialQs(x, names)}`));
  const a = report.applied ?? f;
  const title = isPurchase ? 'Доставки' : 'Продажби';
  const head = ['№ контиране', 'Дата', 'Сметка', ...(a.english ? ['Наименование на чужд език'] : []), 'Код', 'Стока', 'Мярка', 'Количество', 'Цена', 'Стойност', 'Партньор', 'Вид документ', 'Документ №', 'Дата на документа'];
  return (
    <ReportFrame<DeliveryRow[]>
      title={title}
      subtitle={subtitleOf(a)}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа`}
      csvName={`СМЗ_${title}_${a.from}_${a.to}`}
      csv={(d) => [
        head,
        ...d.map((r) => [r.accounting_number, bgDate(r.accounting_date), r.account_number, ...(a.english ? [r.english_description ?? ''] : []), r.product_code ?? '', r.product_name, r.product_measure, qtyCell(r.quantity), qtyCell(r.price), amt(r.amount), r.company_name ?? '', r.document_type ?? '', r.document_number ?? '', bgDate(r.document_date)]),
        ['Общо:', '', '', ...(a.english ? [''] : []), '', '', '', '', '', amt(sum(d, (r) => r.amount))],
      ]}
      filters={<CommonFields f={f} set={set} partner entryNumbers />}
      options={englishBox(f, set)}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>{head.map((h) => <th key={h} className={['Количество', 'Цена', 'Стойност'].includes(h) ? 'text-right' : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.map((r, i) => (
              <tr key={i}>
                <td>{r.accounting_number}</td>
                <td className="nowrap">{bgDate(r.accounting_date)}</td>
                <td className="nowrap">{r.account_number}</td>
                {a.english && <td>{r.english_description}</td>}
                <td>{r.product_code}</td>
                <td>{r.product_name}</td>
                <td>{r.product_measure}</td>
                <td className="num">{qty(r.quantity)}</td>
                <td className="num">{qty(r.price)}</td>
                <Amt v={r.amount} />
                <td>{r.company_name}</td>
                <td>{r.document_type}</td>
                <td>{r.document_number}</td>
                <td className="nowrap">{bgDate(r.document_date)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={a.english ? 9 : 8}>Общо:</td>
              <td className="num">{money(sum(d, (r) => r.amount))}</td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

/** Справки > СМЗ > Доставки (spDeliverySaleMaterialReport, IsPurchase = 1). */
export function PurchaseReport() {
  return <DeliverySale isPurchase />;
}

/** Справки > СМЗ > Продажби (spDeliverySaleMaterialReport, IsPurchase = 0). */
export function SaleReport() {
  return <DeliverySale isPurchase={false} />;
}

/* ------------------------------------------------------------------ */
/* Движение на стоки                                                   */
/* ------------------------------------------------------------------ */

interface MovementRow {
  product_name: string; english_description: string | null; product_code: string | null; product_measure: string; account_number: string;
  price: string; quantity: string; amount: string; document_type: string | null; document_number: string | null; document_date: string | null;
  company_name: string | null; term: string | null;
}

/** Движение на стоки (spGoodsMovementMaterialReport): receipts positive, issues negative. */
export function GoodsMovementReport() {
  const [f, set] = useFilters();
  const names = useProductNames();
  const report = useReport('stockMovement', f, (x) => api.get<MovementRow[]>(`/reports/stock/goods-movement${materialQs({ ...x, fromNumber: '', toNumber: '' }, names)}`));
  const a = report.applied ?? f;
  const head = ['Стока', 'Код на стоката', 'Мерна единица', 'Сметка', ...(a.english ? ['Наименование на чужд език'] : []), 'Ед. цена', 'Количество', 'Сума', 'Док. вид', 'Документ №', 'Дата на документа', 'Партньор', 'Основание'];
  return (
    <ReportFrame<MovementRow[]>
      title="Движение на стоки"
      subtitle={subtitleOf(a)}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа`}
      csvName={`СМЗ_Движение_${a.from}_${a.to}`}
      csv={(d) => [
        head,
        ...d.map((r) => [r.product_name, r.product_code ?? '', r.product_measure, r.account_number, ...(a.english ? [r.english_description ?? ''] : []), qtyCell(r.price), qtyCell(r.quantity), amt(r.amount), r.document_type ?? '', r.document_number ?? '', bgDate(r.document_date), r.company_name ?? '', r.term ?? '']),
      ]}
      filters={<CommonFields f={f} set={set} partner />}
      options={englishBox(f, set)}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>{head.map((h) => <th key={h} className={['Ед. цена', 'Количество', 'Сума'].includes(h) ? 'text-right' : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.map((r, i) => (
              <tr key={i}>
                <td>{r.product_name}</td>
                <td>{r.product_code}</td>
                <td>{r.product_measure}</td>
                <td className="nowrap">{r.account_number}</td>
                {a.english && <td>{r.english_description}</td>}
                <td className="num">{qty(r.price)}</td>
                <td className="num">{qty(r.quantity)}</td>
                <Amt v={r.amount} />
                <td>{r.document_type}</td>
                <td>{r.document_number}</td>
                <td className="nowrap">{bgDate(r.document_date)}</td>
                <td>{r.company_name}</td>
                <td className="max-w-64 truncate">{r.term}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Средно претеглена цена и изписване / Стойност за изписване          */
/* ------------------------------------------------------------------ */

interface AverageRow {
  accountId: number; accountNumber: string; accountDescription: string; englishDescription: string | null; productName: string; code: string | null; measure: string;
  materialInitialBalance: string; initialBalance: string; debitTurnover: string; creditTurnover: string; materialDebitTurnover: string; materialCreditTurnover: string;
  averagePrice: string; writeOutValue: string; finalBalance: string; materialFinalBalance: string;
}

/** Формиране на средно претеглена цена и изписване на СМЗ (spAveragePriceMaterialReport). */
export function AveragePriceReport() {
  const [f, set] = useFilters();
  const names = useProductNames();
  const report = useReport('stockAverage', f, (x) => api.get<AverageRow[]>(`/reports/stock/average-price${materialQs(x, names)}`));
  const a = report.applied ?? f;
  const head = ['Сметка', ...(a.english ? ['Наименование на чужд език'] : []), 'Код', 'Мерна единица', 'Стока', 'Начално салдо кол.', 'Начално салдо ст-ст', 'Заприходено кол-во', 'Заприходени ст-сти', 'Средна цена', 'Кол. Изписани', 'Стойност за изписване', 'Кр. салдо кол.', 'Кр. салдо стойност'];
  const textCols = a.english ? 5 : 4;
  return (
    <ReportFrame<AverageRow[]>
      title="Формиране на средно претеглена цена и изписване на СМЗ"
      subtitle={subtitleOf(a)}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа`}
      csvName={`СМЗ_СрПретеглена_${a.from}_${a.to}`}
      csv={(d) => [
        head,
        ...d.map((r) => [r.accountNumber, ...(a.english ? [r.englishDescription ?? ''] : []), r.code ?? '', r.measure, r.productName, qtyCell(r.materialInitialBalance), amt(r.initialBalance), qtyCell(r.materialDebitTurnover), amt(r.debitTurnover), qtyCell(r.averagePrice), qtyCell(r.materialCreditTurnover), amt(r.writeOutValue), qtyCell(r.materialFinalBalance), amt(r.finalBalance)]),
        ['Общо:', ...Array(textCols - 1).fill(''), '', amt(sum(d, (r) => r.initialBalance)), '', amt(sum(d, (r) => r.debitTurnover)), '', '', amt(sum(d, (r) => r.writeOutValue)), '', amt(sum(d, (r) => r.finalBalance))],
      ]}
      filters={<CommonFields f={f} set={set} />}
      options={englishBox(f, set)}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>{head.map((h, i) => <th key={h} className={i >= textCols ? 'text-right' : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.map((r) => (
              <tr key={`${r.accountId}:${r.productName}`}>
                <td className="nowrap">{r.accountNumber}</td>
                {a.english && <td>{r.englishDescription}</td>}
                <td>{r.code}</td>
                <td>{r.measure}</td>
                <td>{r.productName}</td>
                <td className="num">{qty(r.materialInitialBalance)}</td>
                <Amt v={r.initialBalance} />
                <td className="num">{qty(r.materialDebitTurnover)}</td>
                <Amt v={r.debitTurnover} />
                <td className="num">{qty(r.averagePrice)}</td>
                <td className="num">{qty(r.materialCreditTurnover)}</td>
                <Amt v={r.writeOutValue} />
                <td className="num">{qty(r.materialFinalBalance)}</td>
                <Amt v={r.finalBalance} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={textCols + 1}>Общо:</td>
              <td className="num">{money(sum(d, (r) => r.initialBalance))}</td>
              <td />
              <td className="num">{money(sum(d, (r) => r.debitTurnover))}</td>
              <td colSpan={2} />
              <td className="num">{money(sum(d, (r) => r.writeOutValue))}</td>
              <td />
              <td className="num">{money(sum(d, (r) => r.finalBalance))}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

interface WriteOutRow {
  accountNumber: string; productName: string; englishDescription: string | null; productCode: string | null; measure: string;
  initialBalance: string; initialBalanceQtty: string; bookedSum: string; bookedQtty: string; averagePrice: string; chargedQtty: string; writeOff: string;
}

/** Стойност за изписване при продажба на СМЗ (spWriteOutMaterialReport). */
export function WriteOutReport() {
  const [f, set] = useFilters();
  const names = useProductNames();
  const report = useReport('stockWriteOut', f, (x) => api.get<WriteOutRow[]>(`/reports/stock/write-out${materialQs(x, names)}`));
  const a = report.applied ?? f;
  const head = ['Сметка', ...(a.english ? ['Наименование на чужд език'] : []), 'Стока', 'Код', 'Мярка', 'Начално кол.', 'Начална стойност', 'Заприходено кол.', 'Заприходена стойност', 'Средна цена', 'Изписано кол.', 'Стойност за изписване'];
  const textCols = a.english ? 5 : 4;
  return (
    <ReportFrame<WriteOutRow[]>
      title="Стойност за изписване при продажба на СМЗ"
      subtitle={subtitleOf(a)}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа`}
      csvName={`СМЗ_Изписване_${a.from}_${a.to}`}
      csv={(d) => [
        head,
        ...d.map((r) => [r.accountNumber, ...(a.english ? [r.englishDescription ?? ''] : []), r.productName, r.productCode ?? '', r.measure, qtyCell(r.initialBalanceQtty), amt(r.initialBalance), qtyCell(r.bookedQtty), amt(r.bookedSum), qtyCell(r.averagePrice), qtyCell(r.chargedQtty), amt(r.writeOff)]),
        ['Общо:', ...Array(textCols + 5).fill(''), amt(sum(d, (r) => r.writeOff))],
      ]}
      filters={<CommonFields f={f} set={set} />}
      options={englishBox(f, set)}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>{head.map((h, i) => <th key={h} className={i >= textCols ? 'text-right' : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.map((r, i) => (
              <tr key={i}>
                <td className="nowrap">{r.accountNumber}</td>
                {a.english && <td>{r.englishDescription}</td>}
                <td>{r.productName}</td>
                <td>{r.productCode}</td>
                <td>{r.measure}</td>
                <td className="num">{qty(r.initialBalanceQtty)}</td>
                <Amt v={r.initialBalance} />
                <td className="num">{qty(r.bookedQtty)}</td>
                <Amt v={r.bookedSum} />
                <td className="num">{qty(r.averagePrice)}</td>
                <td className="num">{qty(r.chargedQtty)}</td>
                <Amt v={r.writeOff} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={textCols + 6}>Общо:</td>
              <td className="num">{money(sum(d, (r) => r.writeOff))}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Инвентаризационен опис                                              */
/* ------------------------------------------------------------------ */

interface InventoryRow {
  no: number; accountId: number; accountNumber: string; accountDescription: string; englishDescription: string | null;
  productName: string; productMeasure: string; finalBalance: string; materialFinalBalance: string; averagePrice: string;
}

interface InventoryFilters {
  date: string; account: string; withoutZero: boolean; english: boolean;
  preceptNumber: string; startDate: string; store: string; mol: string; accountant: string; chairman: string;
  member1: string; member2: string; member3: string; producer: string;
}

/** Инвентаризационен опис (spInventoryListReport): quantity and value per stock account at a date, with the print header of the commission. */
export function InventoryListReport() {
  const s = useSession();
  const [f, setF] = useState<InventoryFilters>({
    date: `${s.year.year}-12-31`, account: '', withoutZero: false, english: false,
    preceptNumber: '', startDate: '', store: '', mol: '', accountant: '', chairman: '', member1: '', member2: '', member3: '', producer: '',
  });
  const set = (p: Partial<InventoryFilters>) => setF((x) => ({ ...x, ...p }));
  const report = useReport('stockInventory', f, (x) => api.get<InventoryRow[]>(`/reports/stock/inventory-list${qs({ date: x.date, account: x.account, withoutZero: x.withoutZero })}`));
  const a = report.applied ?? f;
  const text = (label: string, key: keyof InventoryFilters, w = 'w-40') => (
    <Field label={label}>
      <TextInput value={f[key] as string} className={w} onChange={(e) => set({ [key]: e.target.value } as Partial<InventoryFilters>)} />
    </Field>
  );
  const subtitle = [
    `към ${bgDate(a.date)}`, a.account && `сметка ${a.account}`, a.preceptNumber && `заповед № ${a.preceptNumber}${a.startDate ? ` от ${bgDate(a.startDate)}` : ''}`,
    a.store && `склад ${a.store}`, a.mol && `МОЛ ${a.mol}`,
  ].filter(Boolean).join(', ');
  const head = ['№', 'Сметка', 'Наименование', 'Мярка', 'Количество', 'Средна цена', 'Стойност', 'Налично при инвентаризация', 'Липса', 'Излишък', 'Забележка'];
  const signature = (label: string, v: string): ReactNode => (
    <div className="flex gap-2">
      <span className="w-28">{label}:</span>
      <span className="min-w-48 border-b border-dotted border-slate-500">{v}</span>
    </div>
  );
  return (
    <ReportFrame<InventoryRow[]>
      title="Инвентаризационен опис"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} записа`}
      csvName={`СМЗ_Инвентаризационен_опис_${a.date}`}
      csv={(d) => [
        head,
        ...d.map((r) => [String(r.no), r.accountNumber, a.english ? (r.englishDescription ?? r.productName) : r.productName, r.productMeasure, qtyCell(r.materialFinalBalance), qtyCell(r.averagePrice), amt(r.finalBalance), '', '', '', '']),
        ['Общо:', '', '', '', '', '', amt(sum(d, (r) => r.finalBalance))],
      ]}
      filters={
        <>
          <Field label="Към дата">
            <TextInput type="date" value={f.date} className="w-36" required onChange={(e) => set({ date: e.target.value })} />
          </Field>
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => set({ account })} className="w-48" />
          </Field>
          {text('Заповед №', 'preceptNumber', 'w-28')}
          <Field label="От дата">
            <TextInput type="date" value={f.startDate} className="w-36" onChange={(e) => set({ startDate: e.target.value })} />
          </Field>
          {text('На склад', 'store')}
          {text('МОЛ', 'mol')}
          {text('Счетоводител', 'accountant')}
          {text('Председател', 'chairman')}
          <Field label="Членове">
            <div className="flex gap-1">
              <TextInput aria-label="Член 1" value={f.member1} className="w-36" onChange={(e) => set({ member1: e.target.value })} />
              <TextInput aria-label="Член 2" value={f.member2} className="w-36" onChange={(e) => set({ member2: e.target.value })} />
              <TextInput aria-label="Член 3" value={f.member3} className="w-36" onChange={(e) => set({ member3: e.target.value })} />
            </div>
          </Field>
          {text('Изготвил', 'producer')}
        </>
      }
      options={
        <>
          <Checkbox label="Наименование на сметки на чужд език" checked={f.english} onChange={(english) => set({ english })} />
          <Checkbox label="Без нулеви салда" checked={f.withoutZero} onChange={(withoutZero) => set({ withoutZero })} />
        </>
      }
    >
      {(d) => (
        <>
          <table className="grid-table">
            <thead>
              <tr>{head.map((h, i) => <th key={h} className={i >= 4 && i <= 6 ? 'text-right' : undefined}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {d.map((r) => (
                <tr key={`${r.accountId}:${r.no}`}>
                  <td className="num">{r.no}</td>
                  <td className="nowrap">{r.accountNumber}</td>
                  <td>{a.english ? (r.englishDescription ?? r.productName) : r.productName}</td>
                  <td>{r.productMeasure}</td>
                  <td className="num">{qty(r.materialFinalBalance)}</td>
                  <td className="num">{qty(r.averagePrice)}</td>
                  <td className="num">{money(r.finalBalance)}</td>
                  <td className="w-32" />
                  <td className="w-20" />
                  <td className="w-20" />
                  <td className="w-40" />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>Общо:</td>
                <td className="num">{money(sum(d, (r) => r.finalBalance))}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
          <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 px-3 pb-4 text-[12px]">
            {signature('Председател', a.chairman)}
            {signature('МОЛ', a.mol)}
            {signature('Членове', [a.member1, a.member2, a.member3].filter(Boolean).join(', '))}
            {signature('Счетоводител', a.accountant)}
            {signature('Изготвил', a.producer)}
          </div>
        </>
      )}
    </ReportFrame>
  );
}
