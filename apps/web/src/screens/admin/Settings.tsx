import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { parseVatTermConfig, vatTermConfigValue } from '@shmi/core';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Panel, Select, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useCan, useInvalidate, useLookups } from '../../session.tsx';
import { DatabasePage, DocumentTypesPage, SequencesPage, useSettingsPages } from '../settings/SettingsPages.tsx';
import { SmtpPage } from '../settings/SmtpPage.tsx';

interface Setting { key: string; label: string; value: string; default: string }

const isBool = (s: Setting) => /^(true|false)$/i.test(s.default);
const isTrue = (v: string | undefined) => (v ?? '').toLowerCase() === 'true';
/** Child settings are only meaningful when the parent is on (BasicSettingsViewModel). */
const PARENT: Record<string, string> = {
  IsAutomaticOpenBindingDocumentsEnabled: 'IsBindingDocumentsEnabled',
  IsShowSeperateAccountingsForeachAccountGroup60: 'IsAllowAccountingAutomaticEnd',
  IsShowAccountingAttachmentsInList: 'IsAllowAccountingAttachments',
};
const NUMERIC = new Set(['QuantityFormat', 'PriceFormat', 'ExchangeRateFormat']);
/** Most-used VAT operation per transaction type (06 3.4 SaleVatTerm / PurchaseVatTerm, enum name). */
const VAT_TERM_SETTINGS: Record<string, 2 | 3> = { SaleVatTerm: 3, PurchaseVatTerm: 2 };

/** Настройки > Основни (spec 06 3.4). */
function BasicSettings() {
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const editable = can('UI_Other_Settings');
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Setting[]>('/settings') });
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setValues(Object.fromEntries(q.data.map((s) => [s.key, s.value])));
  }, [q.data]);

  if (!q.data) return <Empty><Spinner /></Empty>;
  const changed = q.data.filter((s) => values[s.key] !== undefined && values[s.key] !== s.value);
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  const save = async () => {
    for (const s of changed) {
      const v = values[s.key]!;
      if (NUMERIC.has(s.key) && !/^\d$/.test(v)) return dialogs.alert(`„${s.label}“: въведете цяло число от 0 до 9.`);
      if (s.key === 'AccountsSeparator' && v.length !== 1) return dialogs.alert('Разделителят за подсметки трябва да е един символ.');
    }
    try {
      await api.put('/settings', Object.fromEntries(changed.map((s) => [s.key, values[s.key]!])));
      await invalidate('settings', 'session');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const bools = q.data.filter(isBool);
  const vatTerms = q.data.filter((s) => s.key in VAT_TERM_SETTINGS);
  const others = q.data.filter((s) => !isBool(s) && !(s.key in VAT_TERM_SETTINGS));
  return (
    <div className="flex h-full flex-col">
      <CommandBar right={changed.length ? <span className="text-[12px] text-amber-700">Незаписани промени: {changed.length}</span> : undefined}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!editable || !changed.length} onClick={save}>
          Запис
        </Button>
        <Button disabled={!changed.length} onClick={() => setValues(Object.fromEntries(q.data!.map((s) => [s.key, s.value])))}>
          Отказ
        </Button>
        <Button icon={<RotateCcw className="size-3.5" />} disabled={!editable} onClick={() => setValues(Object.fromEntries(q.data!.map((s) => [s.key, s.default])))}>
          Стойности по подразбиране
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="flex max-w-[1000px] flex-wrap items-start gap-3">
          <Panel title="Контиране" className="min-w-[520px] flex-1">
            <div className="flex flex-col gap-1.5 p-3">
              {bools.map((s) => {
                const parent = PARENT[s.key];
                const off = parent !== undefined && !isTrue(values[parent]);
                return (
                  <Checkbox
                    key={s.key}
                    className={cx(parent && 'ml-5', values[s.key] !== s.value && 'font-medium text-amber-800')}
                    label={s.label}
                    checked={isTrue(values[s.key])}
                    disabled={!editable || off}
                    onChange={(v) => set(s.key, v ? 'True' : 'False')}
                  />
                );
              })}
            </div>
          </Panel>
          <Panel title="Операции по ДДС" className="w-[420px]">
            <div className="flex flex-col gap-1.5 p-3">
              {vatTerms.map((s) => {
                const type = VAT_TERM_SETTINGS[s.key]!;
                const current = parseVatTermConfig(values[s.key], type);
                return (
                  <label key={s.key} className={cx('flex flex-col gap-0.5', values[s.key] !== s.value && 'font-medium text-amber-800')}>
                    <span>{s.label}</span>
                    <Select aria-label={s.label} value={current ?? ''} disabled={!editable} onChange={(e) => set(s.key, vatTermConfigValue(Number(e.target.value) || null))}>
                      <option value="">Първата операция от списъка</option>
                      {(lookups.data?.vatTerms ?? []).filter((t) => t.transactionTypeId === type).map((t) => (
                        <option key={t.id} value={t.id}>{t.description}</option>
                      ))}
                    </Select>
                  </label>
                );
              })}
            </div>
          </Panel>
          <Panel title="Формат" className="w-[420px]">
            <table className="grid-table">
              <tbody>
                {others.map((s) => (
                  <tr key={s.key}>
                    <td className={cx('whitespace-normal', values[s.key] !== s.value && 'font-medium text-amber-800')}>{s.label}</td>
                    <td className="w-20 py-0.5">
                      <TextInput className="h-6 text-center" title={`По подразбиране: ${s.default}`} value={values[s.key] ?? ''} maxLength={NUMERIC.has(s.key) ? 1 : 5} disabled={!editable} onChange={(e) => set(s.key, e.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Настройки (spec 06 3.5): pages Основни / База данни / Номерация / Документи. */
export function Settings() {
  const pages = useSettingsPages();
  const [page, setPage] = useState(pages[0]?.id ?? 'database');
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-0.5 border-b border-slate-300 bg-slate-100 px-2 pt-1" role="tablist">
        {pages.map((p) => (
          <button key={p.id} role="tab" aria-selected={page === p.id} onClick={() => setPage(p.id)} className={cx('rounded-t-sm border border-b-0 px-3 py-1 text-[13px]', page === p.id ? 'border-slate-300 bg-white font-medium' : 'border-transparent text-slate-600 hover:bg-slate-200')}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {page === 'basic' && <BasicSettings />}
        {page === 'database' && <DatabasePage />}
        {page === 'sequences' && <SequencesPage />}
        {page === 'documents' && <DocumentTypesPage />}
        {page === 'smtp' && <SmtpPage />}
      </div>
    </div>
  );
}
