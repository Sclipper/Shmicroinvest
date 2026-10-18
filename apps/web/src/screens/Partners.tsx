import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Save, Trash2, UserPlus } from 'lucide-react';
import { isCompanyCategory, isValidIban } from '@shmi/core';
import { api, qs } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { AccountPicker } from '../components/pickers.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups } from '../session.tsx';
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
  const { data: accounts = [] } = useAccounts();
  const [q, setQ] = useState('');
  const [showUnused, setShowUnused] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);
  const [form, setForm] = useState<Partner | null>(null);
  const [tab, setTab] = useState<TabId>('main');
  const editable = can('UI_Edit_Companies');
  const list = useQuery({ queryKey: ['partners', 'list', q, showUnused], queryFn: () => api.get<PartnerRow[]>(`/partners${qs({ q, all: showUnused })}`), placeholderData: keepPreviousData });
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
    const p = empty();
    const def = accounts.find((a) => a.number === '411') ?? accounts.find((a) => isCompanyCategory(a.categoryId) && a.isLeaf);
    if (def) p.accountIds = [def.id];
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
    if (!form?.id || !(await dialogs.confirm(`Желаете ли да изтриете партньор „${form.name}“?`))) return;
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
        <Checkbox label="Показване и на неизползваните" checked={showUnused} onChange={setShowUnused} />
      </CommandBar>
      <div className="flex min-h-0 flex-1">
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
                        <TextInput value={form.bulstat} onChange={(e) => setForm({ ...form, bulstat: e.target.value, ...(form.isVat && (!form.vatNumber || form.vatNumber === `BG${form.bulstat}`) ? { vatNumber: `BG${e.target.value}` } : {}) })} />
                      </Field>
                      <Field label="ДДС номер">
                        <TextInput value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value.toUpperCase())} disabled={!form.isVat} />
                      </Field>
                    </div>
                    <Checkbox label="Партньорът е регистриран по ЗДДС" checked={form.isVat} onChange={(v) => setForm({ ...form, isVat: v, vatNumber: v && !form.vatNumber && form.bulstat ? `BG${form.bulstat}` : form.vatNumber })} />
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
                    <Checkbox label="Често използван (показва се най-отгоре)" checked={form.priority} onChange={(v) => set('priority', v)} />
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
                                <button className="text-slate-400 hover:text-red-600" onClick={() => set('accountIds', form.accountIds.filter((x) => x !== id))}>✕</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <AccountPicker value={null} leafOnly={false} filter={(a) => isCompanyCategory(a.categoryId) && !form.accountIds.includes(a.id)} onChange={(a) => a && set('accountIds', [...form.accountIds, a.id])} />
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
