import { useMemo, useState } from 'react';
import { CalendarPlus, FileInput, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import {
  MONTH_SHORT_BG, SCHEDULE_MESSAGES, isCompanyCategory, listToMask, maskToList, parseAmount, validateSchedule, type ScheduleDef,
} from '@shmi/core';
import { api } from '../../api.ts';
import { money } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { AccountPicker, PartnerPicker } from '../../components/pickers.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Select, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../../session.tsx';
import { useWorkspace, type ScreenProps } from '../../shell/workspace.tsx';
import { fromServer } from '../EntryEditor.tsx';
import { useTemplates } from './TemplateDialogs.tsx';

interface TLine { accountId: number | null; amount: string; companyId: number | null; companyName?: string | null }
type Mode = 'none' | '0' | '1' | '2';
interface Form {
  id?: number;
  name: string;
  documentTypeId: number | null;
  companyId: number | null;
  companyName?: string | null;
  term: string;
  reference: string;
  transactionTypeId: number;
  debits: TLine[];
  credits: TLine[];
  mode: Mode;
  interval: string;
  weekDays: number[];
  months: number[];
  days: number[];
}

interface FullTemplate {
  id: number; name: string; documentTypeId: number | null; companyId: number | null; companyName: string | null; term: string | null; reference: string | null; transactionTypeId: number | null;
  debits: { accountId: number | null; amount: string; companyId: number | null }[];
  credits: { accountId: number | null; amount: string; companyId: number | null }[];
  schedule: ScheduleDef | null;
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const blankLine = (): TLine => ({ accountId: null, amount: '', companyId: null });
const blank = (): Form => ({ name: '', documentTypeId: 10, companyId: null, term: '', reference: '', transactionTypeId: 1, debits: [blankLine()], credits: [blankLine()], mode: 'none', interval: '1', weekDays: [], months: [], days: [] });
const toInput = (v: string) => (v ? String(Number(v)).replace('.', ',') : '');

function toForm(t: FullTemplate): Form {
  const lines = (ls: FullTemplate['debits']) => (ls.length ? ls.map((l) => ({ accountId: l.accountId, amount: toInput(l.amount), companyId: l.companyId })) : [blankLine()]);
  return {
    id: t.id, name: t.name, documentTypeId: t.documentTypeId, companyId: t.companyId, companyName: t.companyName, term: t.term ?? '', reference: t.reference ?? '', transactionTypeId: t.transactionTypeId ?? 1,
    debits: lines(t.debits), credits: lines(t.credits),
    mode: t.schedule ? (String(t.schedule.mode) as Mode) : 'none',
    interval: String(t.schedule?.interval ?? 1),
    weekDays: t.schedule ? maskToList(t.schedule.weekDays, 7) : [],
    months: t.schedule ? maskToList(t.schedule.months, 12) : [],
    days: t.schedule ? maskToList(t.schedule.days, 31) : [],
  };
}

const scheduleOf = (f: Form): ScheduleDef | null => (f.mode === 'none' ? null : {
  mode: Number(f.mode), interval: /^\d{1,4}$/.test(f.interval.trim()) ? Number(f.interval) : 0,
  weekDays: listToMask(f.weekDays), months: listToMask(f.months), days: listToMask(f.days),
});

/** Шаблони (Shift+F2; spec 02a 9.1-9.2, 07 TemplatesListView / EditTemplateView). */
export function Templates(_: ScreenProps) {
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const { data: accounts = [] } = useAccounts();
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const editable = can('UI_Operations_Templates');
  const [filter, setFilter] = useState({ q: '', account: '' });
  const list = useTemplates(filter);
  const [sel, setSel] = useState<number | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (id: number) => {
    setSel(id);
    try {
      setForm(toForm(await api.get<FullTemplate>(`/templates/${id}`)));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const loadIntoEntry = async (id: number | null) => {
    if (!id) return;
    try {
      const d = await api.get<Record<string, unknown>>(`/templates/${id}/draft?date=${s.workingDate}`);
      ws.open('entry', { title: 'Контиране', params: { draft: fromServer(d) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const remove = async () => {
    const row = list.data?.find((r) => r.id === sel);
    if (!row || !(await dialogs.confirm(SCHEDULE_MESSAGES.strConfirmTemplateVoid))) return;
    try {
      await api.del(`/templates/${row.id}`);
      await invalidate('templates');
      setSel(null);
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const save = async () => {
    if (!form || busy) return;
    if (!form.name.trim()) return dialogs.alert(SCHEDULE_MESSAGES.strTemplateNameError);
    const sched = scheduleOf(form);
    if (sched) {
      const msgs = validateSchedule(sched);
      if (msgs.length) return void dialogs.messages('Графикът не може да бъде записан', msgs);
    }
    const lines = (ls: TLine[]) => ls.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId!, amount: (parseAmount(l.amount) ?? 0).toString(), companyId: l.companyId }));
    const body = {
      name: form.name.trim(), documentTypeId: form.documentTypeId, companyId: form.companyId, term: form.term, reference: form.reference || null,
      transactionTypeId: form.transactionTypeId, debits: lines(form.debits), credits: lines(form.credits), schedule: sched,
    };
    setBusy(true);
    try {
      const r = form.id ? await api.put<{ id: number }>(`/templates/${form.id}`, body) : await api.post<{ id: number }>('/templates', body);
      await invalidate('templates');
      await open(r.id);
    } catch (e) {
      await dialogs.error(e, 'Шаблонът не може да бъде записан');
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!form?.id) return;
    try {
      const r = await api.post<{ generated: number; kept: number }>(`/templates/${form.id}/schedule/generate`);
      await invalidate('template-schedules');
      await dialogs.alert(`Генерирани са ${r.generated} реда в графика за ${s.year.year} г.${r.kept ? ` Запазени осчетоводени редове: ${r.kept}.` : ''}`);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const set = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));
  const toggle = (k: 'weekDays' | 'months' | 'days', v: number) => form && set({ [k]: form[k].includes(v) ? form[k].filter((x) => x !== v) : [...form[k], v] } as Partial<Form>);
  const setLine = (side: 'debits' | 'credits', i: number, p: Partial<TLine>) => form && set({ [side]: form[side].map((l, j) => (j === i ? { ...l, ...p } : l)) } as Partial<Form>);

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={list.data ? <span className="text-[12px] text-slate-500">{list.data.length} шаблона</span> : undefined}>
        <Button variant="primary" icon={<Plus className="size-3.5" />} disabled={!editable} onClick={() => (setSel(null), setForm(blank()))}>
          Добавяне
        </Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!sel} onClick={() => sel && open(sel)}>
          Редакция
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!editable || !sel} onClick={remove}>
          Изтриване
        </Button>
        <Button icon={<FileInput className="size-3.5" />} disabled={!sel || !can('UI_Operations_Accounting')} onClick={() => loadIntoEntry(sel)}>
          Зареждане
        </Button>
        <TextInput className="ml-3 w-56" placeholder="Филтър по име" aria-label="Филтър по име" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <TextInput className="w-28" placeholder="Сметка" aria-label="Филтър по сметка" value={filter.account} onChange={(e) => setFilter({ ...filter, account: e.target.value })} />
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
          {list.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !list.data?.length ? (
            <Empty>Няма шаблони. Използвайте „Добавяне“ или „Запис като шаблон“ (F5) в прозорец Контиране.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Име</th>
                  <th>Тип документ</th>
                  <th>Партньор</th>
                  <th>Дебит</th>
                  <th>Кредит</th>
                  <th className="text-right">Сума</th>
                  <th>Основание</th>
                  <th>График</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id} aria-selected={sel === r.id} onClick={() => open(r.id)} onDoubleClick={() => loadIntoEntry(r.id)} className="cursor-default">
                    <td className="font-medium">{r.name}</td>
                    <td>{r.documentTypeName}</td>
                    <td className="max-w-44 truncate">{r.companyName}</td>
                    <td>{r.debitAccounts}</td>
                    <td>{r.creditAccounts}</td>
                    <td className="num">{money(r.amount)}</td>
                    <td className="max-w-56 truncate">{r.termText}</td>
                    <td>{r.hasSchedule ? 'да' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <aside className="flex w-[560px] shrink-0 flex-col bg-slate-50">
          {!form ? (
            <Empty>Изберете шаблон или „Добавяне“</Empty>
          ) : (
            <>
              <div className="border-b border-slate-300 bg-slate-200 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-slate-600 uppercase">{form.id ? 'Редакция на шаблон' : 'Нов шаблон'}</div>
              <fieldset disabled={!editable} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                <Field label="Име">
                  <TextInput value={form.name} maxLength={255} onChange={(e) => set({ name: e.target.value })} autoFocus={!form.id} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Тип документ">
                    <Select value={form.documentTypeId ?? ''} onChange={(e) => set({ documentTypeId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">—</option>
                      {lookups.data?.documentTypes.filter((t) => t.isVisible || t.id === form.documentTypeId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Тип на сделката">
                    <Select value={form.transactionTypeId} onChange={(e) => set({ transactionTypeId: Number(e.target.value) })}>
                      {lookups.data?.transactionTypes.map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
                    </Select>
                  </Field>
                </div>
                <Field label="Партньор">
                  <PartnerPicker value={form.companyId} valueName={form.companyName} onChange={(p) => set({ companyId: p?.id ?? null, companyName: p?.name ?? null })} />
                </Field>
                <Field label="Основание">
                  <TextInput value={form.term} maxLength={255} onChange={(e) => set({ term: e.target.value })} />
                </Field>
                <Field label="Забележка">
                  <TextInput value={form.reference} maxLength={255} onChange={(e) => set({ reference: e.target.value })} />
                </Field>
                {(['debits', 'credits'] as const).map((side) => (
                  <Panel key={side} title={side === 'debits' ? 'Дебит' : 'Кредит'} actions={<Button variant="ghost" className="h-6 px-2" icon={<Plus className="size-3.5" />} onClick={() => set({ [side]: [...form[side], blankLine()] } as Partial<Form>)}>Ред</Button>}>
                    <table className="grid-table">
                      <tbody>
                        {form[side].map((l, i) => {
                          const a = l.accountId ? byId.get(l.accountId) : undefined;
                          return (
                            <tr key={i}>
                              <td className="w-[45%] p-0.5">
                                <AccountPicker value={l.accountId} onChange={(x) => setLine(side, i, { accountId: x?.id ?? null })} />
                              </td>
                              <td className="w-24 p-0.5">
                                <TextInput className="num" aria-label={`${side === 'debits' ? 'Дебит' : 'Кредит'} сума ${i + 1}`} value={l.amount} inputMode="decimal" onChange={(e) => setLine(side, i, { amount: e.target.value })} />
                              </td>
                              <td className="p-0.5">
                                {isCompanyCategory(a?.categoryId) && <PartnerPicker value={l.companyId ?? form.companyId} valueName={l.companyName ?? (l.companyId ? null : form.companyName)} onChange={(p) => setLine(side, i, { companyId: p?.id ?? null, companyName: p?.name ?? null })} />}
                              </td>
                              <td className="w-7 p-0.5 text-center">
                                <button type="button" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Изтрий ред" onClick={() => set({ [side]: form[side].length > 1 ? form[side].filter((_, j) => j !== i) : [blankLine()] } as Partial<Form>)}>
                                  <Trash2 className="size-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </Panel>
                ))}
                <Panel title="График за изпълнение">
                  <div className="flex flex-col gap-2 p-2">
                    <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="График за изпълнение">
                      {([['none', 'Без график'], ['0', 'Дневен'], ['1', 'Седмичен'], ['2', 'Месечен']] as [Mode, string][]).map(([v, label]) => (
                        <label key={v} className="inline-flex items-center gap-1.5">
                          <input type="radio" name={`sched-${form.id ?? 'new'}`} checked={form.mode === v} onChange={() => set({ mode: v })} className="accent-brand-500" />
                          {label}
                        </label>
                      ))}
                    </div>
                    {(form.mode === '0' || form.mode === '1') && (
                      <Field label={`На всеки (${form.mode === '0' ? 'дни' : 'седмици'})`} className="w-40">
                        <TextInput value={form.interval} maxLength={4} inputMode="numeric" onChange={(e) => set({ interval: e.target.value })} />
                      </Field>
                    )}
                    {form.mode === '1' && (
                      <div className="flex flex-wrap gap-3">
                        {WEEKDAYS.map((d, i) => <Checkbox key={d} label={d} checked={form.weekDays.includes(i + 1)} onChange={() => toggle('weekDays', i + 1)} />)}
                      </div>
                    )}
                    {form.mode === '2' && (
                      <>
                        <div className="text-[12px] text-slate-600">Месеци</div>
                        <div className="grid grid-cols-6 gap-1">
                          {MONTH_SHORT_BG.map((m, i) => <Checkbox key={m} label={m} checked={form.months.includes(i + 1)} onChange={() => toggle('months', i + 1)} />)}
                        </div>
                        <div className="text-[12px] text-slate-600">Дни</div>
                        <div className="grid grid-cols-8 gap-1">
                          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <Checkbox key={d} label={String(d)} checked={form.days.includes(d)} onChange={() => toggle('days', d)} />)}
                        </div>
                      </>
                    )}
                  </div>
                </Panel>
              </fieldset>
              <div className={cx('flex justify-end gap-2 border-t border-slate-300 bg-slate-100 px-3 py-2')}>
                <Button icon={<CalendarPlus className="size-3.5" />} disabled={!editable || !form.id || form.mode === 'none'} onClick={generate} title="Генериране на редовете на графика за активната година">
                  Генериране на графика
                </Button>
                <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={!editable || busy}>
                  Запис
                </Button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

