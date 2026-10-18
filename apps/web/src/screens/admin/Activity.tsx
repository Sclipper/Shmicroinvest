import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, qs } from '../../api.ts';
import { Button, CommandBar, Empty, Field, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { useCan } from '../../session.tsx';

interface Row { id: number; userId: number | null; user: string | null; activity: string; entityType: string; entityId: number | null; description: string | null; createdAt: string }

const ACTIVITY: Record<string, string> = { login: 'Вписване', logout: 'Изход', add: 'Добавяне', edit: 'Редакция', delete: 'Изтриване', print: 'Печат', export: 'Експорт' };
const ENTITY: Record<string, string> = {
  identification: 'Идентификация', partner: 'Партньори', user: 'Потребители', accounting: 'Контиране', myCompany: 'Моята фирма', account: 'Сметкоплан',
  turnoverReport: 'Оборотна ведомост', analyticalReport: 'Аналитичен регистър', chronologicalReport: 'Хронологичен регистър', document: 'Документ',
};

const p2 = (n: number) => String(n).padStart(2, '0');
const ts = (iso: string) => {
  const d = new Date(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/** Действия по потребители (audit log). */
export function Activity() {
  const can = useCan();
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ id: number; name: string }[]>('/users'), enabled: can('UI_Edit_Administration_Users') });
  const list = useQuery({ queryKey: ['activity', userId], queryFn: () => api.get<Row[]>(`/activity${qs({ userId, limit: 5000 })}`), placeholderData: keepPreviousData });

  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (list.data ?? []).filter((r) => {
      const day = new Date(r.createdAt).toLocaleDateString('sv-SE'); // yyyy-mm-dd in local time
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (kind && r.activity !== kind) return false;
      if (f && !`${r.user ?? ''} ${r.description ?? ''} ${ENTITY[r.entityType] ?? r.entityType}`.toLowerCase().includes(f)) return false;
      return true;
    });
  }, [list.data, from, to, kind, q]);
  // Users seen in the log are offered even without access to the users list.
  const userOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const u of users.data ?? []) m.set(u.id, u.name);
    for (const r of list.data ?? []) if (r.userId != null && r.user) m.set(r.userId, r.user);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'bg'));
  }, [users.data, list.data]);

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{rows.length} записа</span>}>
        <Field label="Потребител" className="w-48">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Всички</option>
            {userOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </Field>
        <Field label="Действие" className="w-36">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Всички</option>
            {Object.entries(ACTIVITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="От дата" className="w-36">
          <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="До дата" className="w-36">
          <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Търсене" className="w-56">
          <TextInput placeholder="Описание, обект" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Button className="self-end" icon={<RefreshCw className="size-3.5" />} onClick={() => list.refetch()}>
          Обнови
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {list.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : list.error ? (
          <Empty>{(list.error as Error).message}</Empty>
        ) : !rows.length ? (
          <Empty>Няма действия за избраните критерии.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Дата и час</th>
                <th>Потребител</th>
                <th>Действие</th>
                <th>Обект</th>
                <th className="text-right">№</th>
                <th>Описание</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="w-40">{ts(r.createdAt)}</td>
                  <td>{r.user}</td>
                  <td>{ACTIVITY[r.activity] ?? r.activity}</td>
                  <td>{ENTITY[r.entityType] ?? r.entityType}</td>
                  <td className="num">{r.entityId ?? ''}</td>
                  <td className="w-full">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
