import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FolderPlus, Plus, Save, Trash2 } from 'lucide-react';
import { ACCOUNT_CATEGORIES } from '@shmi/core';
import { api } from '../api.ts';
import { compareAccountNumbers as cmp, money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../session.tsx';
import type { Account } from '../types.ts';

interface Form {
  id?: number;
  parentId: number;
  number: string;
  description: string;
  englishDescription: string;
  accountCategoryId: number | null;
  currencyId: number;
  isActive: boolean | null;
  isHidden: boolean;
  iban: string;
}

/** Индивидуален сметкоплан (Ctrl+H): tree + edit pane (spec 01a 4, 06 ChartOfAccountsView). */
export function ChartOfAccounts() {
  const s = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const { data: accounts = [], isLoading } = useAccounts();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selId, setSelId] = useState<number | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const editable = can('UI_Operations_ChartOfAccounts_IndividualChartOfAccounts');
  const baseCurrencyId = s.baseCurrency === 'EUR' ? 2 : 1;

  const children = useMemo(() => {
    const m = new Map<number, Account[]>();
    for (const a of accounts) if (a.parentId != null) m.set(a.parentId, [...(m.get(a.parentId) ?? []), a]);
    return m;
  }, [accounts]);
  const root = accounts.find((a) => a.number === '0');

  // Initial state: classes expanded, groups collapsed.
  useEffect(() => {
    if (accounts.length && collapsed.size === 0) setCollapsed(new Set(accounts.filter((a) => a.level === 3 && children.has(a.id)).map((a) => a.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length]);

  const visible = useMemo(() => {
    const out: Account[] = [];
    const q = filter.trim().toLowerCase();
    if (q) return accounts.filter((a) => a.number !== '0' && (a.number.startsWith(q) || a.description.toLowerCase().includes(q)));
    const walk = (id: number) => {
      for (const c of (children.get(id) ?? []).slice().sort((x, y) => cmp(x.number, y.number))) {
        out.push(c);
        if (!collapsed.has(c.id)) walk(c.id);
      }
    };
    if (root) walk(root.id);
    return out;
  }, [accounts, children, collapsed, filter, root]);

  const selected = accounts.find((a) => a.id === selId) ?? null;
  const balance = useQuery({
    queryKey: ['reports', 'balance', selId],
    queryFn: () => api.get<{ closingDebit: string; closingCredit: string; debitTurnover: string; creditTurnover: string; openingDebit: string; openingCredit: string }>(`/accounts/${selId}/balance`),
    enabled: !!selId,
  });

  const select = (a: Account) => {
    setSelId(a.id);
    setForm({ id: a.id, parentId: a.parentId!, number: a.number, description: a.description, englishDescription: a.englishDescription ?? '', accountCategoryId: a.categoryId, currencyId: a.currencyId, isActive: a.isActive, isHidden: a.isHidden, iban: a.iban ?? '' });
  };

  const newAccount = async (parent: Account | undefined) => {
    if (!parent) return;
    let number = '';
    if (parent.number !== '0') number = (await api.get<{ number: string }>(`/accounts/${parent.id}/next-number`)).number;
    setForm({ parentId: parent.id, number, description: '', englishDescription: '', accountCategoryId: parent.categoryId, currencyId: parent.currencyId || baseCurrencyId, isActive: parent.isActive, isHidden: false, iban: '' });
    setSelId(null);
  };

  const save = async () => {
    if (!form) return;
    const body = { ...form, iban: form.iban || null, id: undefined };
    try {
      const r = form.id ? await api.put<{ id: number }>(`/accounts/${form.id}`, body) : await api.post<{ id: number }>('/accounts', body);
      await invalidate('accounts');
      setSelId(r.id);
      if (!form.id) setForm({ ...form, id: r.id });
      if (form.parentId) setCollapsed((c) => new Set([...c].filter((x) => x !== form.parentId)));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const remove = async () => {
    if (!selected || !(await dialogs.confirm(`Желаете ли да изтриете сметка ${selected.number} ${selected.description}?`))) return;
    try {
      await api.del(`/accounts/${selected.id}`);
      await invalidate('accounts');
      setSelId(null);
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const toggle = (id: number) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  if (isLoading) return <Empty><Spinner /></Empty>;

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">Сметкоплан {s.year.year >= 2026 ? 'в евро (от 2026)' : 'в лева (до 2025)'} · {accounts.length - 1} сметки</span>}>
        <Button icon={<Plus className="size-3.5" />} disabled={!editable} onClick={() => newAccount(root)}>
          Нова сметка
        </Button>
        <Button icon={<FolderPlus className="size-3.5" />} disabled={!editable || !selected} onClick={() => newAccount(selected ?? undefined)} title="Ctrl+F3">
          Нова подсметка
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!editable || !selected} onClick={remove}>
          Изтриване
        </Button>
        <TextInput className="ml-3 w-64" placeholder="Търсене по номер или име" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {!filter && (
          <>
            <Button variant="ghost" onClick={() => setCollapsed(new Set())}>Разгъни всички</Button>
            <Button variant="ghost" onClick={() => setCollapsed(new Set(accounts.filter((a) => children.has(a.id) && a.number !== '0').map((a) => a.id)))}>Свий всички</Button>
          </>
        )}
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
          {accounts.length <= 1 ? (
            <Empty>Сметкопланът е празен. Използвайте „Избор на сметкоплан“.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Наименование</th>
                  <th>Характер</th>
                  <th>Категория</th>
                  <th>Вид</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => {
                  const hasKids = children.has(a.id);
                  return (
                    <tr key={a.id} aria-selected={a.id === selId} onClick={() => select(a)} className={cx('cursor-default', a.isHidden && 'text-slate-400')}>
                      <td style={{ paddingLeft: 8 + (filter ? 0 : (a.level - 2) * 16) }} className={cx(a.level <= 3 && 'font-semibold')}>
                        {hasKids && !filter ? (
                          <button className="mr-1 inline-flex align-middle text-slate-500" onClick={(e) => (e.stopPropagation(), toggle(a.id))}>
                            {collapsed.has(a.id) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                          </button>
                        ) : (
                          <span className="mr-1 inline-block w-3.5" />
                        )}
                        {a.number}
                      </td>
                      <td className={cx(a.level <= 3 && 'font-semibold')}>{a.description}</td>
                      <td>{a.isActive === true ? 'А' : a.isActive === false ? 'П' : 'АП'}</td>
                      <td className="max-w-56 truncate text-slate-600">{ACCOUNT_CATEGORIES.find((c) => c.id === a.categoryId)?.description}</td>
                      <td className="text-slate-600">{a.isForeignCurrency ? 'Валутна' : a.isMaterial ? 'Материална' : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <aside className="w-[380px] shrink-0 overflow-auto bg-slate-50 p-3">
          {form ? (
            <div className="flex flex-col gap-3">
              <Panel title={form.id ? `Сметка ${form.number}` : 'Нова сметка'}>
                <div className="flex flex-col gap-2 p-3">
                  <Field label="Номер">
                    <TextInput value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} disabled={!editable || (selected?.isUsed ?? false)} />
                  </Field>
                  <Field label="Наименование">
                    <TextInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!editable} autoFocus={!form.id} />
                  </Field>
                  <Field label="Наименование на английски">
                    <TextInput value={form.englishDescription} onChange={(e) => setForm({ ...form, englishDescription: e.target.value })} disabled={!editable} />
                  </Field>
                  <Field label="Характер на сметка">
                    <Select value={form.isActive === null ? 'ap' : form.isActive ? 'a' : 'p'} onChange={(e) => setForm({ ...form, isActive: e.target.value === 'ap' ? null : e.target.value === 'a' })} disabled={!editable}>
                      <option value="a">Активна</option>
                      <option value="p">Пасивна</option>
                      <option value="ap">Активно-пасивна</option>
                    </Select>
                  </Field>
                  <Field label="Валута" hint={form.currencyId !== baseCurrencyId ? 'Валутна сметка: при контиране се въвеждат валутна сума и курс.' : undefined}>
                    <Select value={form.currencyId} onChange={(e) => setForm({ ...form, currencyId: Number(e.target.value) })} disabled={!editable || (selected?.isUsed ?? false)}>
                      {lookups.data?.currencies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.isoCode} – {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Категория">
                    <Select value={form.accountCategoryId ?? ''} onChange={(e) => setForm({ ...form, accountCategoryId: e.target.value ? Number(e.target.value) : null })} disabled={!editable}>
                      <option value="">—</option>
                      {ACCOUNT_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.description}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="IBAN към сметка">
                    <TextInput value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} disabled={!editable} />
                  </Field>
                  <Checkbox label="Сметката не се ползва" checked={form.isHidden} onChange={(v) => setForm({ ...form, isHidden: v })} disabled={!editable} />
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={!editable || !form.description.trim()}>
                      Запис
                    </Button>
                  </div>
                </div>
              </Panel>
              {selected && balance.data && (
                <Panel title={`Салдо към 31.12.${s.year.year}`}>
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th />
                        <th className="text-right">Дебит</th>
                        <th className="text-right">Кредит</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td>Начално салдо</td><td className="num">{money(balance.data.openingDebit)}</td><td className="num">{money(balance.data.openingCredit)}</td></tr>
                      <tr><td>Обороти</td><td className="num">{money(balance.data.debitTurnover)}</td><td className="num">{money(balance.data.creditTurnover)}</td></tr>
                      <tr className="font-semibold"><td>Крайно салдо</td><td className="num">{money(balance.data.closingDebit)}</td><td className="num">{money(balance.data.closingCredit)}</td></tr>
                    </tbody>
                  </table>
                </Panel>
              )}
            </div>
          ) : (
            <Empty>Изберете сметка</Empty>
          )}
        </aside>
      </div>
    </div>
  );
}
