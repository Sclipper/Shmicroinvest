import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus, Save, Trash2 } from 'lucide-react';
import { SEQUENCE_LENGTH_OPTIONS, sequencePreview, validateSequence } from '@shmi/core';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Dialog, Empty, Field, Panel, Select, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useCan, useInvalidate } from '../../session.tsx';

// ---------------------------------------------------------------------------
// 06 3.6 База данни

export function DatabasePage() {
  const q = useQuery({ queryKey: ['settings', 'database'], queryFn: () => api.get<{ server: string; catalog: string; companyName: string; version: string; companies: { name: string; companyName: string; version: string }[] }>('/settings/database') });
  if (!q.data) return <Empty><Spinner /></Empty>;
  return (
    <div className="flex max-w-3xl flex-col gap-3 p-3">
      <Panel title="Връзка">
        <div className="grid grid-cols-2 gap-3 p-3">
          <Field label="Сървър">
            <TextInput value={q.data.server} readOnly />
          </Field>
          <Field label="База данни (каталог)">
            <TextInput value={q.data.catalog} readOnly />
          </Field>
          <Field label="Фирма">
            <TextInput value={q.data.companyName} readOnly />
          </Field>
          <Field label="Версия">
            <TextInput value={q.data.version} readOnly />
          </Field>
        </div>
      </Panel>
      <Panel title="Фирми на сървъра">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Фирма</th>
              <th>Каталог</th>
              <th>Версия</th>
            </tr>
          </thead>
          <tbody>
            {q.data.companies.map((c) => (
              <tr key={c.name} className={cx(c.name === q.data.catalog && 'font-medium')}>
                <td>{c.companyName}</td>
                <td>{c.name}</td>
                <td>{c.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-3 py-2 text-[12px] text-slate-500">Смяната на фирма става от Файл &gt; Избор на фирма; нова фирма — от Файл &gt; Нова фирма.</p>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 06 3.7 Номерация

interface SequenceRow {
  id: number; channel: number; channelName: string; format: string; lastNumber: number; numericLength: number; isNumberResetNextYear: boolean;
  prefix: string; separator: string; selectedNumberLength: number; startNumber: number; preview: string; next: string; users: number; isActive: boolean;
}
interface SeqForm { id?: number; channel: number; prefix: string; separator: string; selectedNumberLength: number; startNumber: string; isNumberResetNextYear: boolean }

export function SequencesPage() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const q = useQuery({ queryKey: ['settings', 'sequences'], queryFn: () => api.get<SequenceRow[]>('/settings/sequences') });
  const [form, setForm] = useState<SeqForm | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const refresh = () => invalidate('settings', 'entries');
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      await dialogs.error(e, 'Номерация');
    }
  };
  const selected = q.data?.find((r) => r.id === sel);
  const start = Number(form?.startNumber ?? 0);
  const preview = form ? sequencePreview(form.prefix, form.selectedNumberLength, start) : '';
  const invalid = form ? validateSequence(form.prefix, form.selectedNumberLength, start).length > 0 : true;

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button icon={<Plus className="size-3.5" />} onClick={() => setForm({ channel: selected?.channel ?? 1, prefix: '', separator: '', selectedNumberLength: 9, startNumber: '1', isNumberResetNextYear: false })}>
          Нова номерация
        </Button>
        <Button disabled={!selected} onClick={() => selected && setForm({ id: selected.id, channel: selected.channel, prefix: selected.prefix, separator: selected.separator, selectedNumberLength: selected.selectedNumberLength, startNumber: String(selected.startNumber), isNumberResetNextYear: selected.isNumberResetNextYear })}>
          Редакция
        </Button>
        <Button disabled={!selected || selected.isActive} onClick={() => selected && act(() => api.post(`/settings/sequences/${selected.id}/activate`))}>
          Активиране
        </Button>
        <Button disabled={!selected || !selected.isActive} onClick={() => selected && act(() => api.post(`/settings/sequences/${selected.id}/deactivate`))}>
          Деактивиране
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!selected} onClick={async () => selected && (await dialogs.confirm('Желаете ли да изтриете избраната номерация?')) && act(() => api.del(`/settings/sequences/${selected.id}`))}>
          Изтриване
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Канал</th>
              <th>Документи</th>
              <th>Формат</th>
              <th className="text-right">Дължина</th>
              <th className="text-right">Последен номер</th>
              <th>Следващ</th>
              <th>Нулиране</th>
              <th>Активна</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((r) => (
              <tr key={r.id} aria-selected={sel === r.id} onClick={() => setSel(r.id)}>
                <td>{r.channel}</td>
                <td>{r.channelName}</td>
                <td>{r.format}</td>
                <td className="num">{r.numericLength}</td>
                <td className="num">{r.lastNumber}</td>
                <td className="font-mono">{r.next}</td>
                <td>{r.isNumberResetNextYear ? 'Да' : ''}</td>
                <td>{r.isActive ? '✓' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && (
        <Dialog
          title={form.id ? 'Редакция на номерация' : 'Нова номерация'}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button
                variant="primary"
                disabled={invalid}
                onClick={() => act(async () => {
                  const body = { channel: form.channel, prefix: form.prefix, separator: form.separator, selectedNumberLength: form.selectedNumberLength, startNumber: start, isNumberResetNextYear: form.isNumberResetNextYear };
                  if (form.id) await api.put(`/settings/sequences/${form.id}`, body);
                  else await api.post('/settings/sequences', body);
                  setForm(null);
                })}
              >
                Запис
              </Button>
              <Button onClick={() => setForm(null)}>Отказ</Button>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Канал">
              <TextInput type="number" value={form.channel} disabled={!!form.id} onChange={(e) => setForm({ ...form, channel: Number(e.target.value) })} aria-label="Канал" />
            </Field>
            <Field label="Дължина на номера">
              <Select value={form.selectedNumberLength} onChange={(e) => setForm({ ...form, selectedNumberLength: Number(e.target.value) })} aria-label="Дължина на номера">
                {SEQUENCE_LENGTH_OPTIONS.map((o, i) => (
                  <option key={o} value={i}>
                    {o}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Префикс">
              <TextInput value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} aria-label="Префикс" />
            </Field>
            <Field label="Разделител">
              <TextInput value={form.separator} maxLength={5} onChange={(e) => setForm({ ...form, separator: e.target.value })} aria-label="Разделител" />
            </Field>
            <Field label="Начален номер">
              <TextInput value={form.startNumber} inputMode="numeric" onChange={(e) => setForm({ ...form, startNumber: e.target.value.replace(/\D/g, '') })} aria-label="Начален номер" />
            </Field>
            <Field label="Преглед">
              <TextInput value={preview} readOnly className={cx('font-mono', invalid && 'text-red-700')} aria-label="Преглед" />
            </Field>
            <Checkbox className="col-span-2" label="Нулиране на номерацията в началото на годината" checked={form.isNumberResetNextYear} onChange={(v) => setForm({ ...form, isNumberResetNextYear: v })} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 06 3.8 Документи (two-list editor)

interface DocType { id: number; name: string; shortName: string; code: string; isVisible: boolean; position: number; accountings: number; isMandatory: boolean }

export function DocumentTypesPage() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const q = useQuery({ queryKey: ['settings', 'document-types'], queryFn: () => api.get<DocType[]>('/settings/document-types') });
  const [visible, setVisible] = useState<number[]>([]);
  const [selL, setSelL] = useState<number | null>(null);
  const [selR, setSelR] = useState<number | null>(null);
  useEffect(() => {
    if (q.data) setVisible(q.data.filter((d) => d.isVisible).map((d) => d.id));
  }, [q.data]);
  if (!q.data) return <Empty><Spinner /></Empty>;
  const byId = new Map(q.data.map((d) => [d.id, d]));
  const hidden = q.data.filter((d) => !visible.includes(d.id));
  const changed = JSON.stringify(visible) !== JSON.stringify(q.data.filter((d) => d.isVisible).map((d) => d.id));
  const move = (dir: -1 | 1) => {
    if (selR === null) return;
    const i = visible.indexOf(selR);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visible.length) return;
    const next = [...visible];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setVisible(next);
  };
  const save = async () => {
    try {
      await api.put('/settings/document-types', { visible });
      await invalidate('settings', 'lookups');
    } catch (e) {
      await dialogs.error(e, 'Документи');
    }
  };
  const list = (items: DocType[], sel: number | null, onSel: (id: number) => void, label: string) => (
    <Panel title={label} className="flex min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 overflow-auto" role="listbox" aria-label={label}>
        {items.map((d) => (
          <li key={d.id} role="option" aria-selected={sel === d.id} onClick={() => onSel(d.id)} className={cx('cursor-default px-2 py-0.5', sel === d.id && 'bg-brand-100')}>
            {d.name} <span className="text-slate-500">({d.shortName})</span>
            {d.isMandatory && <span className="ml-1 text-[11px] text-slate-500">задължителен</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!changed} onClick={save}>
          Запис
        </Button>
        <Button disabled={!changed} onClick={() => setVisible(q.data!.filter((d) => d.isVisible).map((d) => d.id))}>
          Отказ
        </Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1 gap-2 p-3">
        {list(hidden, selL, setSelL, 'Налични типове')}
        <div className="flex flex-col justify-center gap-2">
          <Button icon={<ChevronRight className="size-3.5" />} disabled={selL === null} onClick={() => selL !== null && (setVisible([...visible, selL]), setSelL(null))}>
            Добавяне
          </Button>
          <Button icon={<ChevronLeft className="size-3.5" />} disabled={selR === null} onClick={() => selR !== null && (setVisible(visible.filter((x) => x !== selR)), setSelR(null))}>
            Премахване
          </Button>
          <Button icon={<ArrowUp className="size-3.5" />} disabled={selR === null} onClick={() => move(-1)}>
            Нагоре
          </Button>
          <Button icon={<ArrowDown className="size-3.5" />} disabled={selR === null} onClick={() => move(1)}>
            Надолу
          </Button>
        </div>
        {list(visible.map((id) => byId.get(id)!).filter(Boolean), selR, setSelR, 'Използвани в програмата')}
      </div>
    </div>
  );
}

/** Settings window pages (06 3.5): Basic = 1, DB = 2, Sequences = 3, DocumentTypes = 4; DB always shown. */
export function useSettingsPages() {
  const can = useCan();
  return [
    { id: 'basic', label: 'Основни', visible: can('UI_Other_Settings_Basic') },
    { id: 'database', label: 'База данни', visible: true },
    { id: 'sequences', label: 'Номерация', visible: can('UI_Other_Settings_Sequences') },
    { id: 'documents', label: 'Документи', visible: can('UI_Other_Settings_DocumentTypes') },
    // SmtpConfigurationView: Delta shows it only for TRZ Pro (06 3.5); the web rebuild needs it to e-mail reports.
    { id: 'smtp', label: 'E-mail', visible: can('UI_Other_Settings') },
    // Delta's local keys (06 3.2), per user: e-mail sender and signature, archive password.
    { id: 'local', label: 'Лични', visible: true },
  ].filter((p) => p.visible);
}
