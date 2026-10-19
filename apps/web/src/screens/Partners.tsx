import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Printer, Save, Search, Trash2, UserPlus } from 'lucide-react';
import { isCompanyCategory, isValidIban } from '@shmi/core';
import { api, qs } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { AccountPicker } from '../components/pickers.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import type { PartnerRow } from '../types.ts';

interface Address { addressTypeId: number | null; countryId: number | null; city: string; postalCode: string; address: string; phone: string }
interface BankAcc { account: string; bankId: number | null }
interface Partner {
  id?: number; name: string; contactName: string; bulstat: string; vatNumber: string; isVat: boolean; priority: boolean; groupId: number; dueDays: number;
  email: string; isNotUsing: boolean; nameInOtherLanguage: string; code: string; accountIds: number[]; addresses: Address[]; bankAccounts: BankAcc[];
}

const empty = (): Partner => ({ name: '', contactName: '', bulstat: '', vatNumber: '', isVat: false, priority: false, groupId: 1, dueDays: 0, email: '', isNotUsing: false, nameInOtherLanguage: '', code: '', accountIds: [], addresses: [], bankAccounts: [] });

type TabId = 'main' | 'other' | 'addresses' | 'banks' | 'accounts';

/** Партньори (Ctrl+P): list + edit pane (spec 03a 2). */
export function Partners() {
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const ws = useWorkspace();
  const { data: accounts = [] } = useAccounts();
  const [q, setQ] = useState('');
  const [showUnused, setShowUnused] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);
  const [form, setForm] = useState<Partner | null>(null);
  const [tab, setTab] = useState<TabId>('main');
  const editable = can('UI_Edit_Companies');
  const [groupId, setGroupId] = useState(1);
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ['partners', 'list', q, showUnused, groupId, accountFilter],
    queryFn: () => api.get<PartnerRow[]>(`/partners${qs({ q, all: showUnused, groupId: groupId === 1 ? undefined : groupId, accountId: accountFilter })}`),
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({ queryKey: ['partners', 'one', selId], queryFn: () => api.get<Record<string, unknown>>(`/partners/${selId}`), enabled: !!selId });

  useEffect(() => {
    if (!detail.data) return;
    const p = detail.data as Record<string, never>;
    setForm({
      id: p.id, name: p.name ?? '', contactName: p.contactName ?? '', bulstat: p.bulstat ?? '', vatNumber: p.vatNumber ?? '', isVat: !!p.isVat, priority: !!p.priority,
      groupId: p.groupId ?? 1, dueDays: p.dueDays ?? 0, email: p.email ?? '', isNotUsing: !!p.isNotUsing, nameInOtherLanguage: p.nameInOtherLanguage ?? '', code: p.code ?? '',
      accountIds: p.accountIds ?? [],
      addresses: ((p.addresses ?? []) as Record<string, never>[]).map((a) => ({ addressTypeId: a.addressTypeId ?? null, countryId: a.countryId ?? null, city: a.city ?? '', postalCode: a.postalCode ?? '', address: a.address ?? '', phone: a.phone ?? '' })),
      bankAccounts: ((p.bankAccounts ?? []) as Record<string, never>[]).map((b) => ({ account: b.account ?? "", bankId: b.bankId ?? null })),
    });
  }, [detail.data]);

  const bgId = lookups.data?.countries.find((c) => c.code === 'BG')?.id ?? null;
  const startNew = () => {
    setSelId(null);
    // New partner: selected group, and the filtered account pre-attached (03a 2.1).
    const p = { ...empty(), groupId };
    const def = accountFilter ?? (accounts.find((a) => a.number === '411') ?? accounts.find((a) => isCompanyCategory(a.categoryId) && a.isLeaf))?.id;
    if (def) p.accountIds = [def];
    setForm(p);
    setTab('main');
  };

  const body = (f: Partner) => ({
    ...f, id: undefined,
    bulstat: f.bulstat || null, vatNumber: f.vatNumber || null, email: f.email || null, code: f.code || null, contactName: f.contactName || null, nameInOtherLanguage: f.nameInOtherLanguage || null,
    addresses: f.addresses.map((a) => ({ ...a, postalCode: a.postalCode || null })),
    bankAccounts: f.bankAccounts.filter((b) => b.account.trim()),
  });

  const save = async () => {
    if (!form) return;
    try {
      const r = form.id ? await api.put<{ id: number; warnings: { key: string; text: string; severity: 'warning' }[] }>(`/partners/${form.id}`, body(form)) : await api.post<{ id: number; warnings: { key: string; text: string; severity: 'warning' }[] }>('/partners', body(form));
      await invalidate('partners');
      setSelId(r.id);
      if (r.warnings.length) await dialogs.messages('Партньорът е записан', r.warnings);
    } catch (e) {
      await dialogs.error(e, 'Партньорът не може да бъде записан');
    }
  };

  const remove = async () => {
    if (!form?.id || !(await dialogs.confirm(`Желаете ли изтриване на избрания партньор?`))) return;
    try {
      await api.del(`/partners/${form.id}`);
      await invalidate('partners');
      setSelId(null);
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const set = <K extends keyof Partner>(k: K, v: Partner[K]) => form && setForm({ ...form, [k]: v });

  // Online lookup (03a 2.5): fills name, EIK, VAT number and the registration address.
  const [looking, setLooking] = useState(false);
  const lookup = async () => {
    if (!form) return;
    setLooking(true);
    try {
      const r = await api.get<{ companyName: string; bulstat: string; vatNumber: string; isVatRegistered: boolean; city: string; postalCode: string; location: string; countryCode: string }>(
        `/partners/lookup${qs({ bulstat: form.bulstat.trim(), vatNumber: form.vatNumber.trim(), name: form.name.trim() })}`,
      );
      const countryId = lookups.data?.countries.find((c) => c.code === r.countryCode)?.id ?? bgId;
      const registration: Address = { addressTypeId: 1, countryId, city: r.city.slice(0, 50), postalCode: /^\d{1,10}$/.test(r.postalCode) ? r.postalCode : '', address: r.location, phone: '' };
      const addresses = r.city || r.location ? [registration, ...form.addresses.filter((x) => x.addressTypeId !== 1)].slice(0, 3) : form.addresses;
      setForm({ ...form, name: r.companyName || form.name, bulstat: r.bulstat || form.bulstat, vatNumber: r.vatNumber, isVat: r.isVatRegistered, addresses });
    } catch (e) {
      await dialogs.error(e, 'Търсене на данните за фирма');
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<UserPlus className="size-3.5" />} onClick={startNew} disabled={!editable}>
          Нова фирма
        </Button>
        <Button icon={<Save className="size-3.5" />} onClick={save} disabled={!editable || !form}>
          Запис
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove} disabled={!editable || !form?.id}>
          Изтриване на фирма
        </Button>
        <TextInput className="ml-3 w-72" placeholder="Търсене по име, ЕИК, ДДС номер, код" value={q} onChange={(e) => setQ(e.target.value)} />
        <AccountPicker className="w-56" value={accountFilter} leafOnly={false} filter={(a) => isCompanyCategory(a.categoryId)} onChange={(a) => setAccountFilter(a?.id ?? null)} />
        <Checkbox label="Показване и на неизползваните" checked={showUnused} onChange={setShowUnused} />
        {/* The list's print: Справка партньори for the selected group and account (05 7.7). */}
        <Button
          className="ml-auto"
          icon={<Printer className="size-3.5" />}
          disabled={!can('UI_Reporting_Companies')}
          onClick={() => ws.open('companiesReport', { params: { groupId, account: accounts.find((a) => a.id === accountFilter)?.number ?? '' } })}
        >
          Справка партньори
        </Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <GroupTree selected={groupId} onSelect={setGroupId} editable={editable} />
        <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
          {list.isLoading ? (
            <Empty><Spinner /></Empty>
          ) : !list.data?.length ? (
            <Empty>Няма партньори.</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Име на фирмата</th>
                  <th>Идент. №</th>
                  <th>ДДС номер</th>
                  <th>Град</th>
                  <th>Адрес</th>
                  <th>МОЛ</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id} aria-selected={p.id === selId} onClick={() => setSelId(p.id)} className={cx('cursor-default', p.isNotUsing && 'text-slate-400')}>
                    <td className={cx(p.priority === 1 && 'font-semibold')}>{p.name}</td>
                    <td>{p.bulstat}</td>
                    <td>{p.isVat ? p.vatNumber : ''}</td>
                    <td>{p.city}</td>
                    <td className="max-w-64 truncate">{p.address}</td>
                    <td>{p.contactName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <aside className="flex w-[500px] shrink-0 flex-col bg-slate-50">
          {!form ? (
            <Empty>Изберете партньор или „Нова фирма“</Empty>
          ) : (
            <>
              <div className="flex gap-px border-b border-slate-300 bg-slate-200 px-2 pt-1 text-[12.5px]">
                {([['main', 'Основни данни'], ['other', 'Други данни'], ['addresses', 'Адреси'], ['banks', 'Банкови сметки'], ['accounts', 'Сметки']] as [TabId, string][]).map(([id, label]) => (
                  <button key={id} onClick={() => setTab(id)} className={cx('rounded-t-sm px-2 py-1 whitespace-nowrap', tab === id ? 'bg-slate-50 font-medium' : 'text-slate-600 hover:bg-slate-100')}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-auto p-3">
                {tab === 'main' && (
                  <div className="flex flex-col gap-2">
                    <Field label="Име">
                      <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus={!form.id} />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Идент. № (ЕИК/ЕГН)">
                        <div className="flex gap-1">
                          <TextInput
                            value={form.bulstat}
                            onChange={(e) => setForm({ ...form, bulstat: e.target.value, ...(form.isVat && e.target.value.trim() ? { vatNumber: `BG${e.target.value.trim()}` } : {}) })}
                            onKeyDown={(e) => {
                              if (e.ctrlKey && e.key.toLowerCase() === 's') {
                                e.preventDefault();
                                void lookup();
                              }
                            }}
                          />
                          <Button className="px-2" title="Търсене на данните по ЕИК / ДДС номер (Ctrl+S)" icon={<Search className="size-3.5" />} disabled={looking || !(form.bulstat.trim() || form.vatNumber.trim())} onClick={lookup}>
                            Търсене
                          </Button>
                        </div>
                      </Field>
                      <Field label="ДДС номер">
                        <div className="flex gap-1">
                          <TextInput value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value.toUpperCase())} disabled={!form.isVat} />
                          <Button className="px-2" title="Служебен ДДС номер" disabled={!form.isVat} onClick={() => set('vatNumber', '999999999999999')}>
                            --&gt;9999
                          </Button>
                        </div>
                      </Field>
                    </div>
                    <Checkbox label="Партньорът е регистриран по ЗДДС" checked={form.isVat} onChange={(v) => setForm({ ...form, isVat: v, vatNumber: v && form.bulstat.trim() ? `BG${form.bulstat.trim()}` : form.vatNumber })} />
                    <Field label="МОЛ">
                      <TextInput value={form.contactName} onChange={(e) => set('contactName', e.target.value)} />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Група">
                        <Select value={form.groupId} onChange={(e) => set('groupId', Number(e.target.value))}>
                          {lookups.data?.companyGroups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {'  '.repeat(Math.max(0, g.level - 1))}
                              {g.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Дни за падеж">
                        <TextInput type="number" min={0} max={999} value={form.dueDays} onChange={(e) => set('dueDays', Number(e.target.value))} />
                      </Field>
                    </div>
                    <Field label="E-mail">
                      <TextInput type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
                    </Field>
                    <Checkbox label="Партньорът се използва често" checked={form.priority} onChange={(v) => set('priority', v)} />
                    <Checkbox label="Партньорът не се използва" checked={form.isNotUsing} onChange={(v) => set('isNotUsing', v)} />
                  </div>
                )}
                {tab === 'other' && (
                  <div className="flex flex-col gap-2">
                    <Field label="Име на чужд език">
                      <TextInput value={form.nameInOtherLanguage} onChange={(e) => set('nameInOtherLanguage', e.target.value)} />
                    </Field>
                    <Field label="Код">
                      <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} />
                    </Field>
                  </div>
                )}
                {tab === 'addresses' && (
                  <div className="flex flex-col gap-3">
                    {form.addresses.map((a, i) => (
                      <div key={i} className="rounded-sm border border-slate-300 bg-white p-2">
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="Тип">
                            <Select value={a.addressTypeId ?? ''} onChange={(e) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, addressTypeId: e.target.value ? Number(e.target.value) : null } : x)))}>
                              <option value="" />
                              {lookups.data?.addressTypes.map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
                            </Select>
                          </Field>
                          <Field label="Държава">
                            <Select value={a.countryId ?? ''} onChange={(e) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, countryId: e.target.value ? Number(e.target.value) : null } : x)))}>
                              <option value="" />
                              {lookups.data?.countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </Select>
                          </Field>
                          <Field label="Град">
                            <TextInput value={a.city} onChange={(e) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, city: e.target.value } : x)))} />
                          </Field>
                          <Field label="Пощенски код">
                            <TextInput value={a.postalCode} inputMode="numeric" onChange={(e) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, postalCode: e.target.value } : x)))} />
                          </Field>
                        </div>
                        <Field label="Адрес" className="mt-2">
                          <TextInput value={a.address} onChange={(e) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))} />
                        </Field>
                        <div className="mt-2 flex items-end gap-2">
                          <Field label="Телефон" className="flex-1">
                            <TextInput value={a.phone} onChange={(e) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
                          </Field>
                          <Button variant="danger" onClick={() => set('addresses', form.addresses.filter((_, j) => j !== i))}>
                            Премахни
                          </Button>
                        </div>
                      </div>
                    ))}
                    {form.addresses.length < 3 && (
                      <Button icon={<Plus className="size-3.5" />} onClick={() => set('addresses', [...form.addresses, { addressTypeId: (lookups.data?.addressTypes.find((t) => !form.addresses.some((a) => a.addressTypeId === t.id))?.id) ?? null, countryId: bgId, city: '', postalCode: '', address: '', phone: '' }])}>
                        Добави адрес
                      </Button>
                    )}
                  </div>
                )}
                {tab === 'banks' && (
                  <div className="flex flex-col gap-2">
                    {form.bankAccounts.map((b, i) => (
                      <div key={i} className="flex items-end gap-2">
                        <Field label="IBAN" className="flex-1" hint={b.account && !isValidIban(b.account) ? <span className="text-amber-700">Въведен е невалиден IBAN!</span> : undefined}>
                          <TextInput value={b.account} onChange={(e) => set('bankAccounts', form.bankAccounts.map((x, j) => (j === i ? { ...x, account: e.target.value.toUpperCase() } : x)))} />
                        </Field>
                        <Field label="Банка" className="w-44">
                          <Select value={b.bankId ?? ''} onChange={(e) => set('bankAccounts', form.bankAccounts.map((x, j) => (j === i ? { ...x, bankId: e.target.value ? Number(e.target.value) : null } : x)))}>
                            <option value="">(по IBAN)</option>
                            {lookups.data?.banks.map((bk) => <option key={bk.id} value={bk.id}>{bk.name}</option>)}
                          </Select>
                        </Field>
                        <Button variant="danger" onClick={() => set('bankAccounts', form.bankAccounts.filter((_, j) => j !== i))}>✕</Button>
                      </div>
                    ))}
                    <Button icon={<Plus className="size-3.5" />} onClick={() => set('bankAccounts', [...form.bankAccounts, { account: '', bankId: null }])}>
                      Добави сметка
                    </Button>
                  </div>
                )}
                {tab === 'accounts' && (
                  <div className="flex flex-col gap-2">
                    <div className="text-[12px] text-slate-600">Счетоводни сметки, по които партньорът участва (само сметки с категория за партньори).</div>
                    <table className="grid-table">
                      <tbody>
                        {form.accountIds.map((id) => {
                          const a = accounts.find((x) => x.id === id);
                          return (
                            <tr key={id}>
                              <td className="font-medium">{a?.number}</td>
                              <td>{a?.description}</td>
                              <td className="w-8 text-center">
                                <button className="text-slate-400 hover:text-red-600" onClick={async () => (await dialogs.confirm('Желаете ли премахване на избраната сметка?')) && set('accountIds', form.accountIds.filter((x) => x !== id))}>✕</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <AccountPicker value={null} leafOnly={false} filter={(a) => isCompanyCategory(a.categoryId)} onChange={(a) => {
                      if (!a) return;
                      if (form.accountIds.includes(a.id)) void dialogs.alert('Вече е добавена сметка с този номер!');
                      else set('accountIds', [...form.accountIds, a.id]);
                    }} />
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

interface Group { id: number; name: string; parentId: number | null; level: number }

/** Partner groups tree (03a 2.7): root "Основна група" is read-only. */
function GroupTree({ selected, onSelect, editable }: { selected: number; onSelect: (id: number) => void; editable: boolean }) {
  const lookups = useLookups();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const groups = (lookups.data?.companyGroups ?? []) as Group[];
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const ordered: Group[] = [];
  const walk = (pid: number | null) => {
    for (const g of groups.filter((x) => x.parentId === pid).sort((a, b) => a.name.localeCompare(b.name, 'bg'))) {
      ordered.push(g);
      walk(g.id);
    }
  };
  walk(null);
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await invalidate('lookups', 'partners');
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-slate-300 bg-slate-50">
      <div className="flex gap-1 border-b border-slate-200 p-1.5">
        <Button className="h-6 px-2" disabled={!editable} onClick={() => run(() => api.post('/partner-groups', { parentId: selected }))} title="Нова група">
          <Plus className="size-3.5" />
        </Button>
        <Button className="h-6 px-2" disabled={!editable || selected === 1} onClick={() => setRenaming({ id: selected, name: groups.find((g) => g.id === selected)?.name ?? '' })}>
          Редакция
        </Button>
        <Button className="h-6 px-2" variant="danger" disabled={!editable || selected === 1} onClick={async () => {
          if (!(await dialogs.confirm('Желаете ли изтриване на избраната група?'))) return;
          await run(() => api.del(`/partner-groups/${selected}`));
          onSelect(1);
        }}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto py-1 text-[12.5px]">
        {ordered.map((g) => (
          <div key={g.id}>
            {renaming?.id === g.id ? (
              <form
                className="px-2 py-0.5"
                style={{ paddingLeft: 8 + (g.level - 1) * 14 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await run(() => api.put(`/partner-groups/${g.id}`, { name: renaming.name }));
                  setRenaming(null);
                }}
              >
                <TextInput autoFocus value={renaming.name} maxLength={50} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onBlur={() => setRenaming(null)} />
              </form>
            ) : (
              <button
                onClick={() => onSelect(g.id)}
                onDoubleClick={() => editable && g.id !== 1 && setRenaming({ id: g.id, name: g.name })}
                style={{ paddingLeft: 8 + (g.level - 1) * 14 }}
                className={cx('block w-full truncate py-1 pr-2 text-left', g.id === selected ? 'bg-brand-100 font-medium' : 'hover:bg-slate-100')}
              >
                {g.name}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
