import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Button, Checkbox, ErrorText, Field, Select, TextInput } from '../components/ui.tsx';

interface CompanyItem { name: string; companyName: string; version: string }

/** Company selection + identification (Избор на фирма / Идентификация, spec 01b 4). */
export function Login() {
  const qc = useQueryClient();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<CompanyItem[]>('/companies') });
  const [db, setDb] = useState('');
  const [mode, setMode] = useState<'login' | 'new'>('login');
  useEffect(() => {
    if (companies.data && !db) {
      if (companies.data.length === 0) setMode('new');
      else setDb(localStorage.getItem('shmi.lastCompany') ?? companies.data[0]!.name);
    }
  }, [companies.data, db]);
  const onDone = async () => {
    await qc.invalidateQueries();
  };
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className="w-[440px] overflow-hidden rounded-sm bg-white shadow-2xl">
        <div className="flex items-center gap-3 bg-gradient-to-b from-brand-600 to-brand-700 px-5 py-4 text-white">
          <span className="grid size-9 place-items-center rounded-sm bg-white/15 text-xl font-bold">Ш</span>
          <div>
            <div className="text-lg font-semibold">Шмикроинвест Шмелта Про</div>
            <div className="text-[12px] opacity-80">Счетоводство за малки и средни фирми</div>
          </div>
        </div>
        <div className="p-5">
          {companies.isLoading ? null : mode === 'login' ? (
            <LoginForm companies={companies.data ?? []} db={db} setDb={setDb} onDone={onDone} />
          ) : (
            <NewCompanyForm firstRun={(companies.data ?? []).length === 0} onDone={onDone} onCancel={() => setMode('login')} />
          )}
        </div>
      </div>
    </div>
  );
}

function LoginForm({ companies, db, setDb, onDone }: { companies: CompanyItem[]; db: string; setDb: (v: string) => void; onDone: () => void }) {
  const users = useQuery({ queryKey: ['companyUsers', db], queryFn: () => api.get<{ id: number; name: string }[]>(`/companies/${db}/users`), enabled: !!db });
  const [userId, setUserId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (users.data?.length) setUserId(users.data[0]!.id);
  }, [users.data]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/login', { companyDb: db, userId, password });
      localStorage.setItem('shmi.lastCompany', db);
      onDone();
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Фирма">
        <Select value={db} onChange={(e) => setDb(e.target.value)}>
          {companies.map((c) => (
            <option key={c.name} value={c.name}>
              {c.companyName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Потребител">
        <Select value={userId ?? ''} onChange={(e) => setUserId(Number(e.target.value))}>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Парола">
        <TextInput type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      <ErrorText error={error} />
      <div className="mt-1 flex items-center justify-end">
        <Button variant="primary" type="submit" disabled={busy || !userId}>
          Вход
        </Button>
      </div>
    </form>
  );
}

export function NewCompanyForm({ firstRun, onDone, onCancel }: { firstRun: boolean; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ companyName: '', bulstat: '', adminName: 'Администратор', adminPassword: '', confirm: '', year: new Date().getFullYear() });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState({ chartOfAccounts: false, users: false, partners: false, accountings: false, accountingTemplates: false, bankTemplates: false });
  // Entries and templates post to accounts: they bring the chart along (01b 1.2).
  const chartForced = transfer.accountings || transfer.accountingTemplates || transfer.bankTemplates;
  const dupConfirmed = useRef<string | null>(null);
  const [dupWarning, setDupWarning] = useState(false);
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<CompanyItem[]>('/companies') });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: k === 'year' ? Number(e.target.value) : e.target.value });
    if (k === 'companyName') setDupWarning(false);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.adminPassword !== f.confirm) return setError(new Error('Паролите не съвпадат.'));
    // strDatabaseAlreadyExistsWarning (01b 1.2): a duplicate name only asks.
    const name = f.companyName.trim().toLocaleLowerCase('bg');
    if (dupConfirmed.current !== name && companies.data?.some((c) => c.companyName.trim().toLocaleLowerCase('bg') === name)) return setDupWarning(true);
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ name: string }>('/companies', {
        companyName: f.companyName, bulstat: f.bulstat || undefined, adminName: f.adminName, adminPassword: f.adminPassword, year: f.year, chartTemplate: 'commercial',
        transfer: firstRun ? undefined : transfer,
      });
      localStorage.setItem('shmi.lastCompany', r.name);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {firstRun && <div className="font-semibold text-slate-700">Създаване на първата фирма</div>}
      <Field label="Име на фирмата">
        <TextInput autoFocus value={f.companyName} onChange={set('companyName')} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="ЕИК">
          <TextInput value={f.bulstat} onChange={set('bulstat')} inputMode="numeric" />
        </Field>
        <Field label="Счетоводна година">
          <TextInput type="number" value={f.year} onChange={set('year')} min={2000} max={2078} />
        </Field>
      </div>
      <Field label="Администратор">
        <TextInput value={f.adminName} onChange={set('adminName')} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Парола">
          <TextInput type="password" value={f.adminPassword} onChange={set('adminPassword')} autoComplete="new-password" required minLength={6} />
        </Field>
        <Field label="Повтори паролата">
          <TextInput type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        </Field>
      </div>
      {!firstRun && (
        <fieldset className="rounded-sm border border-slate-200 px-3 pt-1 pb-2">
          <legend className="px-1 text-[12px] text-slate-500">Прехвърляне на данни от активната фирма</legend>
          <div className="grid grid-cols-2 gap-1">
            <Checkbox label="Сметкоплан" checked={transfer.chartOfAccounts || chartForced} disabled={chartForced} onChange={(v) => setTransfer({ ...transfer, chartOfAccounts: v })} />
            <Checkbox label="Потребители" checked={transfer.users} onChange={(v) => setTransfer({ ...transfer, users: v })} />
            <Checkbox label="Партньори" checked={transfer.partners || transfer.accountings} disabled={transfer.accountings} onChange={(v) => setTransfer({ ...transfer, partners: v })} />
            <Checkbox label="Контировки" checked={transfer.accountings} onChange={(v) => setTransfer({ ...transfer, accountings: v })} />
            <Checkbox label="Шаблони на контировки" checked={transfer.accountingTemplates} onChange={(v) => setTransfer({ ...transfer, accountingTemplates: v })} />
            <Checkbox label="Шаблони за банков импорт" checked={transfer.bankTemplates} onChange={(v) => setTransfer({ ...transfer, bankTemplates: v })} />
          </div>
        </fieldset>
      )}
      <div className="text-[12px] text-slate-500">
        {transfer.chartOfAccounts || chartForced ? 'Сметкопланът се копира от активната фирма.' : 'Фирмата се създава с Фирмен (Търговски) сметкоплан.'} От 2026 г. основната валута е евро.
      </div>
      {dupWarning && (
        <div role="alert" className="flex items-center gap-2 rounded-sm border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          <span className="flex-1">Вече съществува фирма със същото име! Желаете ли да продължите?</span>
          <Button
            variant="primary"
            onClick={(e) => {
              dupConfirmed.current = f.companyName.trim().toLocaleLowerCase('bg');
              e.currentTarget.form?.requestSubmit();
              setDupWarning(false);
            }}
          >
            Да
          </Button>
          <Button onClick={() => setDupWarning(false)}>Не</Button>
        </div>
      )}
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        {!firstRun && <Button onClick={onCancel}>Отказ</Button>}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Създаване...' : 'Създай'}
        </Button>
      </div>
    </form>
  );
}
