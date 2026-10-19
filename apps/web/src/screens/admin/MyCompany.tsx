import { Branches } from './Branches.tsx';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, RotateCcw, Save } from 'lucide-react';
import { isEmail, isValidIban } from '@shmi/core';
import { api, type Message } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { useCan, useInvalidate, useLookups } from '../../session.tsx';
import { TabStrip, nn } from './common.tsx';
import { money, monthLabel } from '../../format.ts';

interface Address { addressTypeId: number | null; countryId: number | null; city: string; postalCode: string; address: string; phone: string; city1?: string | null; address1?: string | null }
interface BankAcc { account: string; bankId: number | null; isEuro: boolean; bankStatementAccountId: number | null }
interface Form {
  name: string; name1: string; contactName: string; contactName1: string; contactPosition: string; accountant: string; accountant1: string; email: string;
  bulstat: string; vatId: string; isVat: boolean; isNotVat: boolean;
  vatDeclarationSubscriberName: string; vatDeclarationSubscriberEgn: string; vatDeclarationSubscriberPosition: string; vatDeclarationSubscriberRole: number | null;
  addresses: Address[]; bankAccounts: BankAcc[];
}
type Raw = Record<string, never>;

const toForm = (m: Raw): Form => ({
  name: m.name ?? '', name1: m.name1 ?? '', contactName: m.contactName ?? '', contactName1: m.contactName1 ?? '', contactPosition: m.contactPosition ?? '',
  accountant: m.accountant ?? '', accountant1: m.accountant1 ?? '', email: m.email ?? '', bulstat: m.bulstat ?? '', vatId: m.vatId ?? '', isVat: !!m.isVat, isNotVat: !!m.isNotVat,
  vatDeclarationSubscriberName: m.vatDeclarationSubscriberName ?? '', vatDeclarationSubscriberEgn: m.vatDeclarationSubscriberEgn ?? '',
  vatDeclarationSubscriberPosition: m.vatDeclarationSubscriberPosition ?? '', vatDeclarationSubscriberRole: m.vatDeclarationSubscriberRole ?? null,
  addresses: ((m.addresses ?? []) as Raw[]).map((a) => ({ addressTypeId: a.addressTypeId ?? null, countryId: a.countryId ?? null, city: a.city ?? '', postalCode: a.postalCode ?? '', address: a.address ?? '', phone: a.phone ?? '', city1: a.city1 ?? null, address1: a.address1 ?? null })),
  bankAccounts: ((m.bankAccounts ?? []) as Raw[]).map((b) => ({ account: b.account ?? '', bankId: b.bankId ?? null, isEuro: !!b.isEuro, bankStatementAccountId: b.bankStatementAccountId ?? null })),
});

type TabId = 'main' | 'addresses' | 'banks' | 'branches' | 'info';

/** Моята фирма (Ctrl+F; spec 03a 3). */
export function MyCompany() {
  const can = useCan();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const editable = can('UI_Edit_Administration_MyCompany');
  const q = useQuery({ queryKey: ['my-company'], queryFn: () => api.get<Raw>('/my-company') });
  const [form, setForm] = useState<Form | null>(null);
  const [tab, setTab] = useState<TabId>('main');
  useEffect(() => {
    if (q.data) setForm(toForm(q.data));
  }, [q.data]);

  if (!form) return <Empty><Spinner /></Empty>;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const setAddr = (i: number, patch: Partial<Address>) => set('addresses', form.addresses.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setBank = (i: number, patch: Partial<BankAcc>) => set('bankAccounts', form.bankAccounts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const bgId = lookups.data?.countries.find((c) => c.code === 'BG')?.id ?? null;

  const validate = (f: Form): Message[] => {
    const out: Message[] = [];
    const crit = (key: string, text: string) => out.push({ key, text, severity: 'critical' });
    const warn = (key: string, text: string) => out.push({ key, text, severity: 'warning' });
    if (!f.name.trim()) crit('strMyCompanyNameIsEmpty', 'Не е попълнено име на фирмата');
    if (!f.bulstat.trim()) warn('strMyCompanyBulstatIsEmpty', 'Не е попълнен ЕИК за фирмата');
    if (f.isVat && !f.vatId.trim()) crit('strMyCompanyVatNumberIsEmpty', 'Не е попълнен данъчен номер за фирмата');
    if (!f.contactName.trim()) warn('strMyCompanyContactNameIsEmpty', 'Не е въведен МОЛ на фирмата');
    if (f.email.trim() && !isEmail(f.email.trim())) warn('strInvalidEmail', 'Невалиден E-mail!');
    if (f.isVat && !f.vatDeclarationSubscriberName.trim()) warn('strMyCompanyVATSubscriberNameIsEmpty', 'Не е попълнено име на подаващия ДДС декларацията');
    if (f.isVat && !f.vatDeclarationSubscriberPosition.trim()) warn('strMyCompanyVATSubscriberPositionIsEmpty', 'Не е попълнена длъжност за СД на подаващия ДДС декларацията');
    for (const a of f.addresses) if (a.postalCode && !/^\d{1,10}$/.test(a.postalCode)) crit('strInvalidAddressPostalCode', 'Невалиден пощенски код');
    const types = f.addresses.map((a) => a.addressTypeId).filter(Boolean);
    if (new Set(types).size !== types.length) crit('strDuplicateAddressType', 'Може да има само по един адрес от тип.');
    for (const b of f.bankAccounts) if (b.account.trim() && !isValidIban(b.account)) warn('strInvalidIBAN', 'Въведен е невалиден IBAN!');
    return out;
  };

  const save = async () => {
    const msgs = validate(form);
    if (msgs.length) {
      const critical = msgs.some((m) => m.severity === 'critical');
      const go = await dialogs.messages(critical ? 'Данните не могат да бъдат записани' : 'Предупреждение', msgs, !critical);
      if (critical || !go) return;
    }
    const f = form;
    const body = {
      name: f.name.trim(), name1: nn(f.name1), contactName: nn(f.contactName), contactName1: nn(f.contactName1), contactPosition: nn(f.contactPosition),
      accountant: f.accountant.trim(), accountant1: nn(f.accountant1), email: nn(f.email), bulstat: f.bulstat.trim(), vatId: nn(f.vatId),
      vatDeclarationSubscriberName: nn(f.vatDeclarationSubscriberName), vatDeclarationSubscriberEgn: nn(f.vatDeclarationSubscriberEgn),
      vatDeclarationSubscriberPosition: nn(f.vatDeclarationSubscriberPosition), vatDeclarationSubscriberRole: f.vatDeclarationSubscriberRole ?? (f.isVat ? 1 : null),
      isVat: f.isVat, isNotVat: f.isNotVat,
      addresses: f.addresses.map((a) => ({ addressTypeId: a.addressTypeId, countryId: a.countryId, city: nn(a.city), postalCode: nn(a.postalCode), address: nn(a.address), phone: nn(a.phone), city1: a.city1 ?? null, address1: a.address1 ?? null })),
      bankAccounts: f.bankAccounts.filter((b) => b.account.trim()).map((b) => ({ account: b.account.trim(), bankId: b.bankId, isEuro: b.isEuro, bankStatementAccountId: b.bankStatementAccountId })),
    };
    try {
      const r = await api.put<{ ok: true; warnings: Message[] }>('/my-company', body);
      await invalidate('my-company', 'session');
      if (r.warnings.length) await dialogs.messages('Данните са записани', r.warnings);
    } catch (e) {
      await dialogs.error(e, 'Данните не могат да бъдат записани');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save} disabled={!editable}>
          Запис
        </Button>
        <Button icon={<RotateCcw className="size-3.5" />} onClick={() => q.data && setForm(toForm(q.data))}>
          Отказ от промените
        </Button>
      </CommandBar>
      <TabStrip<TabId> tabs={[['main', 'Основни данни'], ['addresses', `Адреси (${form.addresses.length})`], ['banks', `Банкови сметки (${form.bankAccounts.length})`], ['branches', 'Клонове'], ['info', 'Информация']]} value={tab} onChange={setTab} />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <fieldset disabled={!editable} className="max-w-[920px]">
          {tab === 'main' && (
            <div className="grid grid-cols-2 gap-3">
              <Panel title="Фирма">
                <div className="flex flex-col gap-2 p-3">
                  <Field label="Име на фирмата">
                    <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={255} />
                  </Field>
                  <Field label="Име на фирмата на английски">
                    <TextInput value={form.name1} onChange={(e) => set('name1', e.target.value)} maxLength={255} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="ЕИК">
                      <TextInput
                        value={form.bulstat}
                        maxLength={50}
                        onChange={(e) => setForm({ ...form, bulstat: e.target.value, ...(form.isVat && (!form.vatId || form.vatId === `BG${form.bulstat}`) ? { vatId: e.target.value ? `BG${e.target.value}` : '' } : {}) })}
                      />
                    </Field>
                    <Field label="ДДС номер">
                      <TextInput value={form.vatId} maxLength={50} disabled={!form.isVat} onChange={(e) => set('vatId', e.target.value.toUpperCase())} />
                    </Field>
                  </div>
                  <Checkbox label="Фирмата е регистрирана по ЗДДС" checked={form.isVat} disabled={form.isNotVat} onChange={(v) => setForm({ ...form, isVat: v, vatId: v && !form.vatId && form.bulstat ? `BG${form.bulstat}` : form.vatId })} />
                  <Checkbox label="Фирмата не подлежи на регистрация по ЗДДС" checked={form.isNotVat} disabled={form.isVat} onChange={(v) => set('isNotVat', v)} />
                  <Field label="E-mail">
                    <TextInput type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={255} />
                  </Field>
                </div>
              </Panel>
              <Panel title="Представляващи лица">
                <div className="flex flex-col gap-2 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="МОЛ">
                      <TextInput value={form.contactName} onChange={(e) => set('contactName', e.target.value)} maxLength={255} />
                    </Field>
                    <Field label="МОЛ на английски">
                      <TextInput value={form.contactName1} onChange={(e) => set('contactName1', e.target.value)} maxLength={255} />
                    </Field>
                  </div>
                  <Field label="Длъжност на МОЛ">
                    <TextInput value={form.contactPosition} onChange={(e) => set('contactPosition', e.target.value)} maxLength={255} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Главен счетоводител">
                      <TextInput value={form.accountant} onChange={(e) => set('accountant', e.target.value)} maxLength={255} />
                    </Field>
                    <Field label="Гл. счетоводител на английски">
                      <TextInput value={form.accountant1} onChange={(e) => set('accountant1', e.target.value)} maxLength={255} />
                    </Field>
                  </div>
                </div>
              </Panel>
              {form.isVat && (
                <Panel title="Подаващ ДДС декларацията" className="col-span-2">
                  <div className="grid grid-cols-4 gap-2 p-3">
                    <Field label="Име на подаващия" className="col-span-2">
                      <TextInput value={form.vatDeclarationSubscriberName} onChange={(e) => set('vatDeclarationSubscriberName', e.target.value)} maxLength={255} />
                    </Field>
                    <Field label="ЕГН">
                      <TextInput value={form.vatDeclarationSubscriberEgn} inputMode="numeric" maxLength={10} onChange={(e) => set('vatDeclarationSubscriberEgn', e.target.value.replace(/\D/g, ''))} />
                    </Field>
                    <Field label="В качеството на">
                      <Select value={form.vatDeclarationSubscriberRole ?? 1} onChange={(e) => set('vatDeclarationSubscriberRole', Number(e.target.value))}>
                        <option value={1}>Представляващ</option>
                        <option value={2}>Пълномощник</option>
                      </Select>
                    </Field>
                    <Field label="Длъжност на подаващия" className="col-span-2">
                      <TextInput value={form.vatDeclarationSubscriberPosition} onChange={(e) => set('vatDeclarationSubscriberPosition', e.target.value)} maxLength={255} />
                    </Field>
                  </div>
                </Panel>
              )}
              <VatTurnover />
            </div>
          )}

          {tab === 'addresses' && (
            <div className="flex max-w-[620px] flex-col gap-3">
              {!form.addresses.length && <div className="text-slate-500">Няма въведени адреси.</div>}
              {form.addresses.map((a, i) => (
                <div key={i} className="rounded-sm border border-slate-300 bg-white p-2">
                  <div className="grid grid-cols-4 gap-2">
                    <Field label="Тип">
                      <Select value={a.addressTypeId ?? ''} onChange={(e) => setAddr(i, { addressTypeId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="" />
                        {lookups.data?.addressTypes.map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
                      </Select>
                    </Field>
                    <Field label="Държава">
                      <Select value={a.countryId ?? ''} onChange={(e) => setAddr(i, { countryId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="" />
                        {lookups.data?.countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Град">
                      <TextInput value={a.city} maxLength={50} onChange={(e) => setAddr(i, { city: e.target.value })} />
                    </Field>
                    <Field label="Пощенски код">
                      <TextInput value={a.postalCode} maxLength={10} inputMode="numeric" onChange={(e) => setAddr(i, { postalCode: e.target.value })} />
                    </Field>
                  </div>
                  <div className="mt-2 grid grid-cols-4 items-end gap-2">
                    <Field label="Адрес" className="col-span-2">
                      <TextInput value={a.address} maxLength={255} onChange={(e) => setAddr(i, { address: e.target.value })} />
                    </Field>
                    <Field label="Телефон">
                      <TextInput value={a.phone} maxLength={100} onChange={(e) => setAddr(i, { phone: e.target.value })} />
                    </Field>
                    <Button variant="danger" className="justify-self-end" onClick={() => set('addresses', form.addresses.filter((_, j) => j !== i))}>
                      Премахни
                    </Button>
                  </div>
                </div>
              ))}
              {form.addresses.length < 3 && (
                <Button
                  className="self-start"
                  icon={<Plus className="size-3.5" />}
                  onClick={() => set('addresses', [...form.addresses, { addressTypeId: lookups.data?.addressTypes.find((t) => !form.addresses.some((a) => a.addressTypeId === t.id))?.id ?? null, countryId: bgId, city: '', postalCode: '', address: '', phone: '' }])}
                >
                  Добави адрес
                </Button>
              )}
            </div>
          )}

          {tab === 'banks' && (
            <div className="flex max-w-[720px] flex-col gap-2">
              {!form.bankAccounts.length && <div className="text-slate-500">Няма въведени банкови сметки.</div>}
              {form.bankAccounts.map((b, i) => (
                <div key={i} className="flex items-end gap-2">
                  <Field label="IBAN" className="flex-1" hint={b.account && !isValidIban(b.account) ? <span className="text-amber-700">Въведен е невалиден IBAN!</span> : undefined}>
                    <TextInput value={b.account} maxLength={50} onChange={(e) => setBank(i, { account: e.target.value.toUpperCase() })} />
                  </Field>
                  <Field label="Банка" className="w-56">
                    <Select value={b.bankId ?? ''} onChange={(e) => setBank(i, { bankId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">(по IBAN)</option>
                      {lookups.data?.banks.map((bk) => <option key={bk.id} value={bk.id}>{bk.name}</option>)}
                    </Select>
                  </Field>
                  <Checkbox className="mb-1.5" label="Сметка в евро" checked={b.isEuro} onChange={(v) => setBank(i, { isEuro: v })} />
                  <Button variant="danger" onClick={() => set('bankAccounts', form.bankAccounts.filter((_, j) => j !== i))}>✕</Button>
                </div>
              ))}
              <Button className="self-start" icon={<Plus className="size-3.5" />} onClick={() => set('bankAccounts', [...form.bankAccounts, { account: '', bankId: null, isEuro: false, bankStatementAccountId: null }])}>
                Добави сметка
              </Button>
            </div>
          )}
          {tab === 'branches' && <Branches />}
          {tab === 'info' && <CompanyInfo />}
        </fieldset>
      </div>
    </div>
  );
}

interface Turnover { months: { month: string; amount: string }[]; total: string; currency: string; limit: string; exceeded: boolean }

/** Оборот за регистрация по ЗДДС (03a 3.3): the 12 months up to the working date. */
function VatTurnover() {
  const q = useQuery({ queryKey: ['my-company', 'vat-turnover'], queryFn: () => api.get<Turnover>('/my-company/vat-turnover') });
  const r = q.data;
  return (
    <Panel title="Оборот за регистрация по ЗДДС" className="col-span-2">
      {!r ? (
        <div className="p-3"><Spinner /></div>
      ) : (
        <div className="p-3">
          <table className="grid-table w-full" aria-label="Оборот за регистрация по ЗДДС">
            <thead>
              <tr>{r.months.map((m) => <th key={m.month} className="num">{monthLabel(`${m.month}-01`)}</th>)}</tr>
            </thead>
            <tbody>
              <tr>{r.months.map((m) => <td key={m.month} className="num">{money(m.amount)}</td>)}</tr>
            </tbody>
          </table>
          <div className="mt-2 flex items-center gap-4">
            <span>Общо за периода: <b data-testid="vat-turnover-total">{money(r.total)} {r.currency === 'EUR' ? 'EUR' : 'лв.'}</b></span>
            <span className="text-slate-500">Праг за задължителна регистрация: {money(r.limit)} {r.currency === 'EUR' ? 'EUR' : 'лв.'}</span>
            {r.exceeded && <span className="font-medium text-red-700">Оборотът достига прага за задължителна регистрация по ЗДДС.</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}

interface YearInfo { year: number; accountings: number; fixedAssets: number; documents: { type: string; count: number }[] }

/** Информация (MyCompanyInfoView): counts of entries, documents by type and fixed assets per year. */
function CompanyInfo() {
  const q = useQuery({ queryKey: ['my-company', 'info'], queryFn: () => api.get<YearInfo[]>('/my-company/info') });
  if (!q.data) return <Spinner />;
  return (
    <div className="flex max-w-[620px] flex-col gap-3">
      {q.data.map((y) => (
        <Panel key={y.year} title={`${y.year} г.`}>
          <table className="grid-table w-full" aria-label={`Информация за ${y.year} г.`}>
            <tbody>
              <tr><td>Контировки</td><td className="num">{y.accountings}</td></tr>
              <tr><td>Дълготрайни активи</td><td className="num">{y.fixedAssets}</td></tr>
              {y.documents.map((d) => <tr key={d.type}><td>{d.type}</td><td className="num">{d.count}</td></tr>)}
            </tbody>
          </table>
        </Panel>
      ))}
    </div>
  );
}
