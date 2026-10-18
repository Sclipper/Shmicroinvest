import { useMemo, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api, qs } from '../../api.ts';
import { bgDate } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useCan, useInvalidate, useSession } from '../../session.tsx';
import { EditPane, TabStrip, isDecimal, normDecimal } from './common.tsx';

interface Column<R> { label: string; render: (r: R) => ReactNode; className?: string }

interface ListEditProps<R extends { id: number }, F> {
  queryKey: unknown[];
  url: string;
  basePath: string;
  columns: Column<R>[];
  rowClass?: (r: R) => string | false | undefined;
  search?: (r: R, q: string) => boolean;
  searchPlaceholder?: string;
  empty: () => F;
  toForm: (r: R) => F;
  validate?: (f: F, row: R | null, all: R[]) => string[];
  toBody: (f: F, row: R | null) => unknown;
  renderForm: (f: F, set: (patch: Partial<F>) => void, row: R | null) => ReactNode;
  editable: boolean;
  invalidateKeys: string[];
  newLabel: string;
  entityLabel: string;
  canDelete?: (r: R) => boolean;
  deleteConfirm: (r: R) => string;
  /** Confirmation before saving (null = none). */
  confirmSave?: (f: F, row: R | null, all: R[]) => string | null;
  onDeleted?: (resp: Record<string, unknown>) => void | Promise<void>;
  toolbar?: ReactNode;
  emptyText: string;
  paneWidth?: number;
}

/** Generic nomenclature screen: list on the left, edit pane on the right (Partners pattern). */
function ListEdit<R extends { id: number }, F>(p: ListEditProps<R, F>) {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<R | null>(null);
  const selId = sel?.id ?? null;
  const [form, setForm] = useState<F | null>(null);
  const list = useQuery({ queryKey: p.queryKey, queryFn: () => api.get<R[]>(p.url), placeholderData: keepPreviousData });
  // The edited record stays editable even when the list filter hides it.
  const row = list.data?.find((r) => r.id === selId) ?? sel;
  const rows = (list.data ?? []).filter((r) => !q.trim() || !p.search || p.search(r, q.trim().toLowerCase()));

  const select = (r: R) => {
    setSel(r);
    setForm(p.toForm(r));
  };
  const startNew = () => {
    setSel(null);
    setForm(p.empty());
  };
  const busy = useRef(false);
  const save = async () => {
    if (!form || busy.current) return;
    const errs = p.validate?.(form, row, list.data ?? []) ?? [];
    if (errs.length) {
      await dialogs.messages(`${p.entityLabel} не може да бъде записан(а)`, errs.map((text, i) => ({ key: String(i), text, severity: 'critical' })));
      return;
    }
    const ask = p.confirmSave?.(form, row, list.data ?? []);
    if (ask && !(await dialogs.confirm(ask))) return;
    busy.current = true;
    try {
      const r = row ? await api.put<R>(`${p.basePath}/${row.id}`, p.toBody(form, row)) : await api.post<R>(p.basePath, p.toBody(form, null));
      await invalidate(...p.invalidateKeys);
      setSel(r);
      setForm(p.toForm(r));
      const warnings = (r as { warnings?: { key: string; text: string; severity: 'critical' | 'warning' }[] }).warnings;
      if (warnings?.length) await dialogs.messages(`${p.entityLabel} е записан(а) с предупреждения`, warnings);
    } catch (e) {
      await dialogs.error(e);
    } finally {
      busy.current = false;
    }
  };
  const remove = async () => {
    if (!row || !(await dialogs.confirm(p.deleteConfirm(row)))) return;
    try {
      const r = await api.del<Record<string, unknown>>(`${p.basePath}/${row.id}`);
      await invalidate(...p.invalidateKeys);
      setSel(null);
      setForm(null);
      await p.onDeleted?.(r);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <CommandBar right={list.data ? <span className="text-[12px] text-slate-500">{rows.length} записа</span> : undefined}>
        <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={startNew} disabled={!p.editable}>
          {p.newLabel}
        </Button>
        <Button icon={<Save className="size-3.5" />} onClick={save} disabled={!p.editable || !form}>
          Запис
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove} disabled={!p.editable || !row || (p.canDelete && !p.canDelete(row))}>
          Изтриване
        </Button>
        {p.search && <TextInput className="ml-3 w-64" placeholder={p.searchPlaceholder ?? 'Търсене'} value={q} onChange={(e) => setQ(e.target.value)} />}
        {p.toolbar}
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
          {list.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !rows.length ? (
            <Empty>{p.emptyText}</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  {p.columns.map((c) => (
                    <th key={c.label} className={c.className?.includes('num') ? 'text-right' : undefined}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} aria-selected={r.id === selId} onClick={() => select(r)} className={cx('cursor-default', p.rowClass?.(r))}>
                    {p.columns.map((c) => (
                      <td key={c.label} className={c.className}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {form ? (
          <EditPane
            title={row ? `Редакция` : p.newLabel}
            width={p.paneWidth ?? 380}
            footer={
              <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={!p.editable}>
                Запис
              </Button>
            }
          >
            <fieldset disabled={!p.editable} className="flex flex-col gap-2" onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && save()}>
              {p.renderForm(form, (patch) => setForm({ ...form, ...patch }), row)}
            </fieldset>
          </EditPane>
        ) : (
          <aside className="shrink-0 bg-slate-50" style={{ width: p.paneWidth ?? 380 }}>
            <Empty>Изберете запис или „{p.newLabel}“</Empty>
          </aside>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Валути

interface Currency { id: number; isoCode: string; name: string; exchangeRate: string; fixedRate: string; rateDate: string | null }
interface CurrencyForm { isoCode: string; name: string; exchangeRate: string; fixedRate: string; rateDate: string }

const rate = (v: string) => (v ? Number(v).toLocaleString('bg-BG', { minimumFractionDigits: 5, maximumFractionDigits: 6 }) : '');

/** Валути (Редакция > Валути). BGN and EUR have a fixed rate. */
export function Currencies() {
  const can = useCan();
  const s = useSession();
  const base = s.baseCurrency;
  return (
    <ListEdit<Currency, CurrencyForm>
      queryKey={['currencies']}
      url="/currencies"
      basePath="/currencies"
      editable={can('UI_Edit_Currencies')}
      invalidateKeys={['currencies', 'lookups']}
      newLabel="Нова валута"
      entityLabel="Валутата"
      emptyText="Няма валути."
      search={(r, q) => r.isoCode.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)}
      searchPlaceholder="Търсене по код или име"
      columns={[
        { label: 'Код', render: (r) => r.isoCode, className: 'font-medium' },
        { label: 'Наименование', render: (r) => r.name },
        { label: 'Курс към лев', render: (r) => rate(r.exchangeRate), className: 'num' },
        { label: 'Фиксиран курс', render: (r) => rate(r.fixedRate), className: 'num' },
        { label: 'Дата на курса', render: (r) => (r.rateDate ? bgDate(r.rateDate) : '') },
        { label: 'Бележка', render: (r) => (r.isoCode === base ? <span className="text-brand-600">основна валута</span> : r.id <= 2 ? <span className="text-slate-500">фиксиран курс</span> : '') },
      ]}
      empty={() => ({ isoCode: '', name: '', exchangeRate: '1', fixedRate: '', rateDate: '' })}
      toForm={(r) => ({ isoCode: r.isoCode, name: r.name, exchangeRate: String(Number(r.exchangeRate)), fixedRate: String(Number(r.fixedRate)), rateDate: r.rateDate ?? '' })}
      canDelete={(r) => !['BGN', 'EUR'].includes(r.isoCode)}
      deleteConfirm={(r) => `Желаете ли да изтриете валута ${r.isoCode} – ${r.name}?`}
      validate={(f, row) => {
        const e: string[] = [];
        if (!(row && row.id <= 2)) {
          if (!isDecimal(f.exchangeRate) || Number(normDecimal(f.exchangeRate)) <= 0) e.push('Невалиден курс.');
          if (f.fixedRate.trim() && !isDecimal(f.fixedRate)) e.push('Невалиден фиксиран курс.');
        }
        return e;
      }}
      toBody={(f, row) => {
        const rates = row && row.id <= 2 ? {} : { exchangeRate: normDecimal(f.exchangeRate), ...(f.fixedRate.trim() ? { fixedRate: normDecimal(f.fixedRate) } : {}) };
        return row ? { name: f.name.trim(), ...rates, ...(f.rateDate ? { rateDate: f.rateDate } : {}) } : { isoCode: f.isoCode.trim(), name: f.name.trim(), ...rates };
      }}
      renderForm={(f, set, row) => (
        <>
          <Field label="Код (ISO)">
            <TextInput value={f.isoCode} maxLength={3} disabled={!!row} onChange={(e) => set({ isoCode: e.target.value.toUpperCase() })} autoFocus={!row} />
          </Field>
          <Field label="Наименование">
            <TextInput value={f.name} maxLength={50} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Курс" hint="лева за 1 единица">
              <TextInput value={f.exchangeRate} inputMode="decimal" disabled={!!row && row.id <= 2} onChange={(e) => set({ exchangeRate: e.target.value })} />
            </Field>
            <Field label="Фиксиран курс" hint={!row ? 'празно = като курса' : undefined}>
              <TextInput value={f.fixedRate} inputMode="decimal" disabled={!!row && row.id <= 2} onChange={(e) => set({ fixedRate: e.target.value })} />
            </Field>
          </div>
          {row && (
            <Field label="Дата на курса">
              <TextInput type="date" value={f.rateDate} disabled={row.id <= 2} onChange={(e) => set({ rateDate: e.target.value })} />
            </Field>
          )}
          {row && row.id <= 2 && <div className="text-[12px] text-slate-500">Курсът на лева и еврото е фиксиран (1 EUR = 1,95583 BGN).</div>}
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Държави

interface Country { id: number; code: string; name: string; nameInOtherLang: string }
type CountryForm = Omit<Country, 'id'>;

/** Държави (Редакция > Държави). */
export function Countries() {
  const can = useCan();
  return (
    <ListEdit<Country, CountryForm>
      queryKey={['countries']}
      url="/countries"
      basePath="/countries"
      editable={can('UI_Edit_Administration_EditTermsAndReferences')}
      invalidateKeys={['countries', 'lookups']}
      newLabel="Нова държава"
      entityLabel="Държавата"
      emptyText="Няма държави."
      search={(r, q) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.nameInOtherLang.toLowerCase().includes(q)}
      searchPlaceholder="Търсене по код или име"
      columns={[
        { label: 'Код', render: (r) => r.code, className: 'font-medium w-16' },
        { label: 'Наименование', render: (r) => r.name },
        { label: 'Наименование на английски', render: (r) => r.nameInOtherLang },
      ]}
      empty={() => ({ code: '', name: '', nameInOtherLang: '' })}
      toForm={(r) => ({ code: r.code, name: r.name, nameInOtherLang: r.nameInOtherLang })}
      deleteConfirm={() => 'Желаете ли изтриване на избраната държава?'}
      toBody={(f) => ({ code: f.code.trim().toUpperCase(), name: f.name.trim(), nameInOtherLang: f.nameInOtherLang.trim() })}
      renderForm={(f, set, row) => (
        <>
          <Field label="Код" hint="ISO 3166 (напр. BG, DE, GR)">
            <TextInput value={f.code} maxLength={3} className="w-24" onChange={(e) => set({ code: e.target.value.toUpperCase() })} autoFocus={!row} />
          </Field>
          <Field label="Наименование">
            <TextInput value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Наименование на английски">
            <TextInput value={f.nameInOtherLang} maxLength={80} onChange={(e) => set({ nameInOtherLang: e.target.value })} />
          </Field>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Основания и забележки

interface DictRow { id: number; description: string; isHidden: boolean; usageFrequency: number }
interface DictForm { description: string; isHidden: boolean }
type DictType = 'terms' | 'references' | 'paragraphs';
const DICT_DELETE: Record<DictType, string> = {
  terms: 'Внимание! Избраното основание ще бъде изтрито от всички операции, в които участва. Желаете ли да продължите?',
  references: 'Внимание! Избраната забележка ще бъде изтрита от всички операции, в които участва. Желаете ли да продължите?',
  paragraphs: 'Внимание! Избраният параграф ще бъде изтрит от всички операции, в които участва. Желаете ли да продължите?',
};
const DICT_RENAME: Record<DictType, string> = {
  terms: 'Промяната на основанието ще се отрази във всички контирания, в които е ползвано, включително и в заключени периоди. Желаете ли запис на промените?',
  references: 'Промяната на забележката ще се отрази във всички контирания, в които е ползвана, включително и в заключени периоди. Желаете ли запис на промените?',
  paragraphs: 'Промяната на параграфа ще се отрази във всички контирания, в които е ползван, включително и в заключени периоди. Желаете ли запис на промените?',
};
const DICT_LABEL: Record<DictType, [string, string]> = { terms: ['Основание', 'Основанието'], references: ['Забележка', 'Забележката'], paragraphs: ['Параграф', 'Параграфът'] };

/** Основания и забележки (Редакция > Администриране): the autocomplete dictionaries of the entry screen. */
export function Dictionary() {
  const can = useCan();
  const [type, setType] = useState<DictType>('terms');
  const [showHidden, setShowHidden] = useState(false);
  const [label, labelDef] = DICT_LABEL[type];
  return (
    <div className="flex h-full flex-col">
      <TabStrip<DictType> tabs={[['terms', 'Основания'], ['references', 'Забележки'], ['paragraphs', 'Параграфи']]} value={type} onChange={setType} />
      <ListEdit<DictRow, DictForm>
        key={type}
        queryKey={['dictionary', type, 'admin', showHidden]}
        url={`/dictionary/${type}${qs({ all: showHidden, limit: 10000 })}`}
        basePath={`/dictionary/${type}`}
        editable={can('UI_Edit_Administration_EditTermsAndReferences')}
        invalidateKeys={['dictionary']}
        newLabel={type === 'references' ? 'Нова забележка' : type === 'terms' ? 'Ново основание' : 'Нов параграф'}
        entityLabel={labelDef}
        emptyText={`Няма въведени записи (${label.toLowerCase()}). Те се добавят и автоматично при контиране.`}
        search={(r, q) => r.description.toLowerCase().includes(q)}
        searchPlaceholder="Търсене по текст"
        toolbar={<Checkbox label="Показване и на скритите" checked={showHidden} onChange={setShowHidden} />}
        rowClass={(r) => r.isHidden && 'text-slate-400'}
        columns={[
          { label, render: (r) => r.description, className: 'max-w-[640px] truncate' },
          { label: 'Използвания', render: (r) => r.usageFrequency || '', className: 'num w-28' },
          { label: 'Скрит', render: (r) => (r.isHidden ? 'да' : ''), className: 'w-16 text-center' },
        ]}
        empty={() => ({ description: '', isHidden: false })}
        toForm={(r) => ({ description: r.description, isHidden: r.isHidden })}
        deleteConfirm={() => DICT_DELETE[type]}
        validate={(f) => (!f.description.trim() ? ['Не е въведен текст.'] : [])}
        confirmSave={(f, row, all) => {
          if (!row) return null;
          // 03a 8.1: an existing text is merged into; a rename reaches every posting, also in locked periods.
          if (all.some((r) => r.id !== row.id && r.description === f.description.trim())) return 'Описанието съществува в списъка. При запис ще бъде прибавено към съществуващото описание. Желаете ли да продължите?';
          if (f.description.trim() !== row.description) return DICT_RENAME[type];
          return f.isHidden !== row.isHidden ? 'Желаете ли да запазите направените промени?' : null;
        }}
        toBody={(f, row) => (row ? { description: f.description.trim(), isHidden: f.isHidden } : { description: f.description.trim() })}
        renderForm={(f, set, row) => (
          <>
            <Field label={label}>
              <TextInput value={f.description} maxLength={255} onChange={(e) => set({ description: e.target.value })} autoFocus={!row} />
            </Field>
            {row && <Checkbox label="Скрит (не се предлага при контиране)" checked={f.isHidden} onChange={(v) => set({ isHidden: v })} />}
            {row && <div className="text-[12px] text-slate-500">Използван {row.usageFrequency} пъти.</div>}
          </>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Дефиниране на СМЗ

interface Product { id: number; name: string; code: string | null; measure: string; price: string }
interface ProductForm { name: string; code: string; measure: string; price: string }

/** Дефиниране на СМЗ (Операции > Стоково-материални запаси). */
export function Products() {
  const can = useCan();
  const s = useSession();
  const priceDigits = Number(s.settings.PriceFormat ?? 2);
  const list = useQuery({ queryKey: ['products'], queryFn: () => api.get<Product[]>('/products') });
  const measures = useMemo(() => [...new Set(['бр.', 'кг', 'л', 'м', 'м2', 'м3', 'т', 'к-т', 'оп.', ...(list.data ?? []).map((p) => p.measure)])], [list.data]);
  return (
    <ListEdit<Product, ProductForm>
      queryKey={['products']}
      url="/products"
      basePath="/products"
      editable={can('UI_Operations_Products_DefineProducts')}
      invalidateKeys={['products']}
      newLabel="Нов материал"
      entityLabel="Материалът"
      emptyText="Няма дефинирани стоково-материални запаси."
      search={(r, q) => r.name.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q)}
      searchPlaceholder="Търсене по име или код"
      columns={[
        { label: 'Наименование', render: (r) => r.name },
        { label: 'Код', render: (r) => r.code ?? '' },
        { label: 'Мярка', render: (r) => r.measure, className: 'w-20' },
        { label: `Цена (${s.baseCurrency})`, render: (r) => Number(r.price).toLocaleString('bg-BG', { minimumFractionDigits: priceDigits, maximumFractionDigits: priceDigits }), className: 'num w-32' },
      ]}
      empty={() => ({ name: '', code: '', measure: 'бр.', price: '0' })}
      toForm={(r) => ({ name: r.name, code: r.code ?? '', measure: r.measure, price: String(Number(r.price)) })}
      deleteConfirm={(r) => `Желаете ли да изтриете „${r.name}“?`}
      validate={(f) => {
        const e: string[] = [];
        if (!f.name.trim()) e.push('Не е въведено наименование.');
        if (!f.measure.trim()) e.push('Не е въведена мярка.');
        if (f.price.trim() && !isDecimal(f.price)) e.push('Невалидна цена.');
        return e;
      }}
      toBody={(f) => ({ name: f.name.trim(), code: f.code.trim() || null, measure: f.measure.trim(), price: f.price.trim() ? normDecimal(f.price) : '0' })}
      renderForm={(f, set, row) => (
        <>
          <Field label="Наименование">
            <TextInput value={f.name} maxLength={255} onChange={(e) => set({ name: e.target.value })} autoFocus={!row} />
          </Field>
          <Field label="Код">
            <TextInput value={f.code} maxLength={50} onChange={(e) => set({ code: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Мярка">
              <TextInput value={f.measure} maxLength={50} list="admin-measures" onChange={(e) => set({ measure: e.target.value })} />
            </Field>
            <Field label={`Цена (${s.baseCurrency})`}>
              <TextInput value={f.price} inputMode="decimal" className="text-right" onChange={(e) => set({ price: e.target.value })} />
            </Field>
          </div>
          <datalist id="admin-measures">
            {measures.map((m) => <option key={m} value={m} />)}
          </datalist>
        </>
      )}
    />
  );
}
