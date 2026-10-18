import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Panel, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useCan, useInvalidate } from '../../session.tsx';

interface Setting { key: string; label: string; value: string; default: string }

const isBool = (s: Setting) => /^(true|false)$/i.test(s.default);
const isTrue = (v: string | undefined) => (v ?? '').toLowerCase() === 'true';
/** Child settings are only meaningful when the parent is on (BasicSettingsViewModel). */
const PARENT: Record<string, string> = {
  IsAutomaticOpenBindingDocumentsEnabled: 'IsBindingDocumentsEnabled',
  IsShowSeperateAccountingsForeachAccountGroup60: 'IsAllowAccountingAutomaticEnd',
};
const NUMERIC = new Set(['QuantityFormat', 'PriceFormat', 'ExchangeRateFormat']);

/** Настройки (Ctrl+T; spec 06 3.4). */
export function Settings() {
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const editable = can('UI_Other_Settings');
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
  const others = q.data.filter((s) => !isBool(s));
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
