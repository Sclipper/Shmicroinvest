import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Copy, FolderPlus, Plus, Save, Trash2 } from 'lucide-react';
import { ACCOUNT_CATEGORIES, SHELL_MESSAGES, STOCK_MESSAGES, canHaveConcludeAccount } from '@shmi/core';
import { api } from '../api.ts';
import { compareAccountNumbers as cmp, money } from '../format.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { AccountPicker } from '../components/pickers.tsx';
import { Button, Checkbox, CommandBar, Dialog, Empty, Field, Panel, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../session.tsx';
import type { Account } from '../types.ts';
import { useWorkspace } from '../shell/workspace.tsx';

interface Form {
  id?: number;
  parentId: number;
  number: string;
  description: string;
  englishDescription: string;
  accountCategoryId: number | null;
  currencyId: number;
  isActive: boolean | null;
  concludeAccountId: number | null;
  isHidden: boolean;
  isForBanks: boolean;
  iban: string;
  accountType: AccountType;
  measure: string;
  productCode: string;
}

type AccountType = 'standard' | 'currency' | 'material';
/** Server account row: the web Account plus the product fields of a material account. */
type ChartAccount = Account & { measure?: string | null; productCode?: string | null };
interface Template { number: string; description: string; categoryId: number | null; isActive: boolean | null; parentNumber: string | null }

const typeOf = (a: Account): AccountType => (a.isMaterial ? 'material' : a.isForeignCurrency ? 'currency' : 'standard');

/** Индивидуален сметкоплан (Ctrl+H): tree + edit pane (spec 01a 4, 06 ChartOfAccountsView). */
export function ChartOfAccounts() {
  const s = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const ws = useWorkspace();
  // 03a 1.1: without a chart type (config ChartOfAccountsType) the message comes first, then the type selection.
  const askedType = useRef(false);
  useEffect(() => {
    if (askedType.current || s.chartOfAccountsType === undefined || s.chartOfAccountsType) return;
    askedType.current = true;
    void (async () => {
      if (!can('UI_Operations_ChartOfAccounts_ChartOfAccountsSelection')) {
        await dialogs.alert(SHELL_MESSAGES.strSelectChartOfAccountsNotAllowed, 'Индивидуален сметкоплан');
        return;
      }
      await dialogs.alert(SHELL_MESSAGES.strChartOfAccountsNotDefined, 'Индивидуален сметкоплан');
      ws.open('chartSelection', { params: { notDefined: true } });
    })();
  }, [s.chartOfAccountsType, can, dialogs, ws]);
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const { data: accountsRaw, isLoading } = useAccounts();
  const accounts = useMemo(() => (accountsRaw ?? []) as ChartAccount[], [accountsRaw]);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selId, setSelId] = useState<number | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  /** Accounts ticked for "Копиране на подсметки". */
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [copying, setCopying] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const measures = useQuery({ queryKey: ['products', 'measures'], queryFn: () => api.get<string[]>('/products/measures'), enabled: form?.accountType === 'material', staleTime: 60_000 });
  const templates = useQuery({ queryKey: ['accounts', 'templates'], queryFn: () => api.get<Template[]>('/accounts/templates'), enabled: !!form && !form.id, staleTime: 60_000 });
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

  const select = (a: ChartAccount) => {
    setSelId(a.id);
    setForm({ id: a.id, parentId: a.parentId!, number: a.number, description: a.description, englishDescription: a.englishDescription ?? '', accountCategoryId: a.categoryId, currencyId: a.currencyId, isActive: a.isActive, concludeAccountId: a.concludeAccountId, isHidden: a.isHidden, isForBanks: a.isForBanks, iban: a.iban ?? '', accountType: typeOf(a), measure: a.measure ?? '', productCode: a.productCode ?? '' });
  };
  const parentOf = (f: Form) => accounts.find((a) => a.id === f.parentId);
  // Material type only for a leaf below the group level (03a 1.5).
  const materialAllowed = (f: Form) => (f.id ? !!selected && selected.level > 2 && selected.isLeaf : (parentOf(f)?.level ?? 0) + 1 > 2);
  /** Template account picked (F4) or typed: fill the number and the template's name, nature and category (03a 1.6). */
  const applyTemplate = (f: Form, t: Template) => {
    const parent = t.parentNumber ? accounts.find((a) => a.number === t.parentNumber) : undefined;
    setForm({ ...f, number: t.number, description: t.description, accountCategoryId: t.categoryId, isActive: t.isActive, parentId: parent && f.parentId === root?.id ? parent.id : f.parentId });
  };

  const newAccount = async (parent: Account | undefined) => {
    if (!parent) return;
    let number = '';
    if (parent.number !== '0') number = (await api.get<{ number: string }>(`/accounts/${parent.id}/next-number`)).number;
    const currencyId = parent.currencyId || baseCurrencyId;
    setForm({ parentId: parent.id, number, description: '', englishDescription: '', accountCategoryId: parent.categoryId, currencyId, isActive: parent.isActive, concludeAccountId: null, isHidden: false, isForBanks: false, iban: '', accountType: currencyId !== baseCurrencyId ? 'currency' : 'standard', measure: '', productCode: '' });
    setSelId(null);
  };

  const save = async () => {
    if (!form) return;
    const body = {
      ...form, iban: form.iban || null, id: undefined,
      concludeAccountId: canHaveConcludeAccount(form.isActive) ? form.concludeAccountId : null,
      currencyId: form.accountType === 'currency' ? form.currencyId : baseCurrencyId,
      measure: form.accountType === 'material' ? form.measure : null, productCode: form.accountType === 'material' ? form.productCode || null : null,
    };
    try {
      const r = form.id ? await api.put<{ id: number }>(`/accounts/${form.id}`, body) : await api.post<{ id: number }>('/accounts', body);
      await invalidate('accounts', 'products');
      setSelId(r.id);
      if (!form.id) setForm({ ...form, id: r.id });
      if (form.parentId) setCollapsed((c) => new Set([...c].filter((x) => x !== form.parentId)));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  // 03a 1.8: the confirmation names partners and bank accounts linked to the account.
  const remove = async () => {
    if (!selected) return;
    const info = await api.get<{ hasPartners: boolean; hasBankAccount: boolean }>(`/accounts/${selected.id}/delete-info`);
    const text = info.hasPartners
      ? 'Към избраната сметка има партньор/и. Желаете ли да я изтриете?'
      : info.hasBankAccount
        ? 'Счетоводната сметка е обвързана с банкова сметка! Желаете ли да продължите?'
        : 'Желаете ли да изтриете избраната сметка?';
    if (!(await dialogs.confirm(text))) return;
    try {
      await api.del(`/accounts/${selected.id}`);
      await invalidate('accounts');
      setSelId(null);
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const copy = async (targetId: number) => {
    if (!(await dialogs.confirm(STOCK_MESSAGES.strCopyAccountsConfirm))) return;
    try {
      const r = await api.post<{ copied: number }>('/accounts/copy', { ids: [...checked], targetId });
      await invalidate('accounts');
      setCopying(false);
      setChecked(new Set());
      setCollapsed((c) => new Set([...c].filter((x) => x !== targetId)));
      await dialogs.alert(`Копирани сметки: ${r.copied}.`);
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
        <Button icon={<Copy className="size-3.5" />} disabled={!editable || checked.size === 0} onClick={() => setCopying(true)} title="Копира отметнатите сметки с подсметките им под избрана сметка">
          Копиране на подсметки{checked.size ? ` (${checked.size})` : ''}
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
                  <th className="w-6" />
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
                      <td className="text-center" onClick={(e) => e.stopPropagation()}>
                        {a.level > 2 && (
                          <input
                            type="checkbox"
                            aria-label={`Отметни ${a.number}`}
                            className="size-3.5 accent-brand-500"
                            checked={checked.has(a.id)}
                            onChange={(e) => setChecked((c) => {
                              const n = new Set(c);
                              if (e.target.checked) n.add(a.id);
                              else n.delete(a.id);
                              return n;
                            })}
                          />
                        )}
                      </td>
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
                  <Field label="Номер" hint={!form.id ? 'F4 – избор от шаблонни сметки' : undefined}>
                    <TextInput
                      value={form.number}
                      disabled={!editable || (selected?.isUsed ?? false)}
                      onChange={(e) => {
                        const number = e.target.value.trim();
                        const t = !form.id && !form.description.trim() ? templates.data?.find((x) => x.number === number) : undefined;
                        if (t) applyTemplate(form, t);
                        else setForm({ ...form, number: e.target.value });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'F4' && !form.id) {
                          e.preventDefault();
                          setTemplatesOpen(true);
                        }
                      }}
                    />
                  </Field>
                  <Field label="Наименование">
                    <TextInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!editable} autoFocus={!form.id} />
                  </Field>
                  <Field label="Наименование на английски">
                    <TextInput value={form.englishDescription} onChange={(e) => setForm({ ...form, englishDescription: e.target.value })} disabled={!editable} />
                  </Field>
                  <Field label="Характер на сметка">
                    <Select value={form.isActive === null ? 'ap' : form.isActive ? 'a' : 'p'} onChange={(e) => setForm({ ...form, isActive: e.target.value === 'ap' ? null : e.target.value === 'a' })} disabled={!editable} aria-label="Характер на сметка">
                      <option value="a">Активна</option>
                      <option value="p">Пасивна</option>
                      <option value="ap">Активно-пасивна</option>
                    </Select>
                  </Field>
                  <Field label="Сметка за приключване" hint={!canHaveConcludeAccount(form.isActive) ? 'Не се задава за активно-пасивни сметки.' : undefined}>
                    <AccountPicker
                      value={canHaveConcludeAccount(form.isActive) ? form.concludeAccountId : null}
                      onChange={(a) => setForm({ ...form, concludeAccountId: a?.id ?? null })}
                      filter={(a) => a.id !== form.id}
                      disabled={!editable || !canHaveConcludeAccount(form.isActive)}
                      ariaLabel="Сметка за приключване"
                    />
                  </Field>
                  <fieldset className="flex flex-col gap-1" disabled={!editable || (selected?.isUsed ?? false)}>
                    <legend className="mb-0.5 text-[12px] text-slate-600">Тип на сметката</legend>
                    <div className="flex gap-4">
                      {([['standard', 'Стандартна'], ['currency', 'Валутна'], ['material', 'Материална']] as const).map(([t, label]) => (
                        <label key={t} className={cx('inline-flex items-center gap-1.5', t === 'material' && !materialAllowed(form) && 'opacity-50')}>
                          <input
                            type="radio"
                            name="account-type"
                            className="accent-brand-500"
                            checked={form.accountType === t}
                            disabled={t === 'material' && !materialAllowed(form)}
                            onChange={() => setForm({ ...form, accountType: t, currencyId: t === 'currency' ? (form.currencyId !== baseCurrencyId ? form.currencyId : (lookups.data?.currencies.find((c) => c.id !== baseCurrencyId)?.id ?? form.currencyId)) : baseCurrencyId })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {form.accountType === 'currency' && (
                    <Field label="Валута" hint="Валутна сметка: при контиране се въвеждат валутна сума и курс.">
                      <Select value={form.currencyId} onChange={(e) => setForm({ ...form, currencyId: Number(e.target.value) })} disabled={!editable || (selected?.isUsed ?? false)}>
                        {lookups.data?.currencies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.isoCode} – {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {form.accountType === 'material' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Мярка">
                        <TextInput value={form.measure} maxLength={50} list="chart-measures" onChange={(e) => setForm({ ...form, measure: e.target.value })} disabled={!editable} />
                      </Field>
                      <Field label="Код">
                        <TextInput value={form.productCode} maxLength={50} onChange={(e) => setForm({ ...form, productCode: e.target.value })} disabled={!editable} />
                      </Field>
                      <datalist id="chart-measures">
                        {(measures.data ?? []).map((m) => <option key={m} value={m} />)}
                      </datalist>
                    </div>
                  )}
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
                  <Checkbox label="Сметката се използва за банкови извлечения" checked={form.isForBanks} onChange={(v) => setForm({ ...form, isForBanks: v })} disabled={!editable} />
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
      {copying && <CopyDialog count={checked.size} onOk={copy} onClose={() => setCopying(false)} />}
      {templatesOpen && form && (
        <TemplateDialog
          templates={templates.data ?? []}
          initial={form.number}
          onPick={(t) => (applyTemplate(form, t), setTemplatesOpen(false))}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
    </div>
  );
}

/** Target of "Копиране на подсметки" (03a 1.7). */
function CopyDialog({ count, onOk, onClose }: { count: number; onOk: (targetId: number) => void; onClose: () => void }) {
  const [target, setTarget] = useState<number | null>(null);
  return (
    <Dialog
      title="Копиране на подсметки"
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" disabled={!target} onClick={() => target && onOk(target)}>
            Копиране
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div>Избрани сметки: {count}. Те се копират с подсметките си под:</div>
        <Field label="Сметка, под която се копира">
          <AccountPicker value={target} leafOnly={false} onChange={(a) => setTarget(a?.id ?? null)} filter={(a) => a.level >= 2 && !a.isMaterial} />
        </Field>
      </div>
    </Dialog>
  );
}

/** F4 on the account number: template accounts of the chart type not yet in the chart (03a 1.6). */
function TemplateDialog({ templates, initial, onPick, onClose }: { templates: Template[]; initial: string; onPick: (t: Template) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const [hi, setHi] = useState(0);
  const needle = q.trim().toLowerCase();
  const rows = templates.filter((t) => !needle || t.number.startsWith(needle) || t.description.toLowerCase().includes(needle)).slice(0, 300);
  return (
    <Dialog title="Шаблонни сметки" width={620} onClose={onClose} footer={<Button onClick={onClose}>Отказ</Button>}>
      <TextInput
        aria-label="Търсене в шаблонните сметки"
        placeholder="Номер или наименование"
        className="mb-2 w-72"
        value={q}
        onChange={(e) => (setQ(e.target.value), setHi(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, rows.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
          else if (e.key === 'Enter' && rows[hi]) (e.preventDefault(), onPick(rows[hi]!));
        }}
      />
      {rows.length === 0 ? (
        <Empty>Няма шаблонни сметки, които липсват в сметкоплана.</Empty>
      ) : (
        <table className="grid-table">
          <thead>
            <tr><th className="w-24">Номер</th><th>Наименование</th></tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.number} aria-selected={i === hi} className="cursor-default" onMouseEnter={() => setHi(i)} onClick={() => onPick(t)}>
                <td>{t.number}</td>
                <td>{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
