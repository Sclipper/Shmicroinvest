import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, FolderPlus, Pencil, Save, Trash2, UserPlus, X } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../../components/ui.tsx';
import { useInvalidate, useSession } from '../../session.tsx';
import { EditPane, PromptDialog, TabStrip } from './common.tsx';

interface Role { id: number; name: string; parentId: number | null; level: number; isReadOnly: boolean }
interface User { id: number; name: string; roleId: number; email: string | null; hasPassword: boolean }
interface Perm { id: number; key: string; name: string; parentId: number | null; groupOrder: number; value: boolean | null; effective: boolean }
interface UserForm { id?: number; name: string; roleId: number | null; email: string; password: string; password2: string }

const ROOT_ROLE = 1;
const ADMIN_ROLE = 2;

type TabId = 'users' | 'rights';

/** Потребители (Ctrl+U; spec 01b 3.4): groups, users and the permission tree per group. */
export function Users() {
  const session = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const [roleId, setRoleId] = useState<number>(ROOT_ROLE);
  const [tab, setTab] = useState<TabId>('users');
  const [prompt, setPrompt] = useState<null | { mode: 'add' | 'rename' }>(null);
  const [copyRights, setCopyRights] = useState(false);
  const role = roles.data?.find((r) => r.id === roleId) ?? null;
  const groups = (roles.data ?? []).filter((r) => r.id !== ROOT_ROLE);
  const roleDepth = (r: Role) => {
    let d = 0;
    for (let p = r.parentId; p != null && d < 10; p = roles.data?.find((x) => x.id === p)?.parentId ?? null) d++;
    return d;
  };

  // ---- Groups ----
  const addRole = async (name: string) => {
    try {
      const r = await api.post<{ id: number }>('/roles', { name, copyFromId: copyRights && roleId !== ROOT_ROLE ? roleId : undefined });
      await invalidate('roles');
      setRoleId(r.id);
      setPrompt(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const renameRole = async (name: string) => {
    try {
      await api.put(`/roles/${roleId}`, { name });
      await invalidate('roles');
      setPrompt(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const removeRole = async () => {
    if (!role || !(await dialogs.confirm(`Желаете ли да изтриете група „${role.name}“?`))) return;
    try {
      await api.del(`/roles/${role.id}`);
      await invalidate('roles');
      setRoleId(ROOT_ROLE);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  // ---- Users ----
  const [form, setForm] = useState<UserForm | null>(null);
  const visibleUsers = (users.data ?? []).filter((u) => roleId === ROOT_ROLE || u.roleId === roleId);
  const roleName = (id: number) => roles.data?.find((r) => r.id === id)?.name ?? '';
  const newUser = () => {
    setForm({ name: '', roleId: roleId === ROOT_ROLE ? null : roleId, email: '', password: '', password2: '' });
    setTab('users');
  };
  const editUser = (u: User) => setForm({ id: u.id, name: u.name, roleId: u.roleId, email: u.email ?? '', password: '', password2: '' });

  const saveUser = async () => {
    if (!form) return;
    const errs: string[] = [];
    if (!form.name.trim()) errs.push('Попълнете потребителско име');
    if (!form.roleId || form.roleId === ROOT_ROLE) errs.push('Изберете потребителска група.');
    const changingPw = !form.id || form.password !== '' || form.password2 !== '';
    if (changingPw) {
      if (form.password !== form.password2) errs.push('Паролите не съвпадат');
      else if (form.password.length < 6) errs.push('Паролата трябва да е поне 6 символа.');
    }
    if ((users.data ?? []).some((u) => u.id !== form.id && u.name.toLowerCase() === form.name.trim().toLowerCase())) errs.push('Вече съществува потребител с такова име.');
    if (errs.length) {
      await dialogs.messages('Потребителят не може да бъде записан', errs.map((text, i) => ({ key: String(i), text, severity: 'critical' })));
      return;
    }
    const body = { name: form.name.trim(), roleId: form.roleId!, email: form.email.trim() || null, ...(changingPw ? { password: form.password } : {}) };
    try {
      const id = form.id ?? (await api.post<{ id: number }>('/users', body)).id;
      if (form.id) await api.put(`/users/${form.id}`, body);
      await invalidate('users');
      if (id === session.user.id) await invalidate('session');
      setForm({ ...form, id, password: '', password2: '' });
    } catch (e) {
      await dialogs.error(e, 'Потребителят не може да бъде записан');
    }
  };
  const removeUser = async () => {
    if (!form?.id || !(await dialogs.confirm('Желаете ли изтриване на избрания потребител?'))) return;
    try {
      await api.del(`/users/${form.id}`);
      await invalidate('users');
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  if (roles.isLoading || users.isLoading) return <Empty><Spinner /></Empty>;
  if (users.error) return <Empty>{String((users.error as Error).message)}</Empty>;

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button icon={<FolderPlus className="size-3.5" />} onClick={() => (setCopyRights(false), setPrompt({ mode: 'add' }))}>
          Нова група
        </Button>
        <Button icon={<Pencil className="size-3.5" />} disabled={!role || role.isReadOnly} onClick={() => setPrompt({ mode: 'rename' })}>
          Преименуване
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!role || role.isReadOnly} onClick={removeRole}>
          Изтриване на група
        </Button>
        <span className="mx-1 h-5 w-px bg-slate-300" />
        <Button variant="primary" icon={<UserPlus className="size-3.5" />} onClick={newUser}>
          Нов потребител
        </Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-auto border-r border-slate-300 bg-white">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Групи</th>
              </tr>
            </thead>
            <tbody>
              {(roles.data ?? []).map((r) => (
                <tr key={r.id} aria-selected={r.id === roleId} onClick={() => setRoleId(r.id)} className="cursor-default">
                  <td style={{ paddingLeft: 8 + roleDepth(r) * 16 }} className={cx(r.id === ROOT_ROLE && 'font-semibold')}>
                    {r.name}
                    <span className="ml-1.5 text-[11px] text-slate-400">
                      {r.id === ROOT_ROLE ? `(${users.data?.length ?? 0})` : `(${users.data?.filter((u) => u.roleId === r.id).length ?? 0})`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <TabStrip<TabId> tabs={[['users', 'Потребители'], ['rights', 'Права']]} value={tab} onChange={setTab} />
          {tab === 'users' ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 overflow-auto border-r border-slate-300">
                {!visibleUsers.length ? (
                  <Empty>Няма потребители в групата.</Empty>
                ) : (
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th>Потребител</th>
                        <th>Група</th>
                        <th>E-mail</th>
                        <th>Парола</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleUsers.map((u) => (
                        <tr key={u.id} aria-selected={u.id === form?.id} onClick={() => editUser(u)} className="cursor-default">
                          <td className={cx(u.id === session.user.id && 'font-semibold')}>{u.name}</td>
                          <td>{roleName(u.roleId)}</td>
                          <td>{u.email}</td>
                          <td>{u.hasPassword ? 'да' : <span className="text-amber-700">няма</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {form ? (
                <EditPane
                  title={form.id ? 'Редакция на потребител' : 'Нов потребител'}
                  width={360}
                  footer={
                    <>
                      <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!form.id || form.id === session.user.id} onClick={removeUser}>
                        Изтриване
                      </Button>
                      <Button variant="primary" icon={<Save className="size-3.5" />} onClick={saveUser}>
                        Запис
                      </Button>
                    </>
                  }
                >
                  <div className="flex flex-col gap-2">
                    <Field label="Потребителско име">
                      <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={255} autoFocus={!form.id} />
                    </Field>
                    <Field label="Група">
                      <Select value={form.roleId ?? ''} onChange={(e) => setForm({ ...form, roleId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">— изберете —</option>
                        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="E-mail">
                      <TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={255} />
                    </Field>
                    <Field label="Парола" hint={form.id ? 'Оставете празно, за да не се променя паролата.' : 'Поне 6 символа.'}>
                      <TextInput type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                    </Field>
                    <Field label="Повторете паролата" hint={form.password2 && form.password !== form.password2 ? <span className="text-red-700">Паролите не съвпадат</span> : undefined}>
                      <TextInput type="password" autoComplete="new-password" value={form.password2} onChange={(e) => setForm({ ...form, password2: e.target.value })} />
                    </Field>
                    {form.id === session.user.id && <div className="text-[12px] text-slate-500">Това е активният потребител – не може да бъде изтрит.</div>}
                  </div>
                </EditPane>
              ) : (
                <aside className="w-[360px] shrink-0 bg-slate-50">
                  <Empty>Изберете потребител или „Нов потребител“</Empty>
                </aside>
              )}
            </div>
          ) : role && role.id !== ROOT_ROLE ? (
            <RoleRights key={role.id} role={role} />
          ) : (
            <Empty>Изберете потребителска група, за да видите правата ѝ.</Empty>
          )}
        </div>
      </div>
      {prompt && (
        <PromptDialog
          title={prompt.mode === 'add' ? 'Нова потребителска група' : 'Преименуване на група'}
          label="Име на групата"
          initial={prompt.mode === 'rename' ? role?.name : ''}
          onClose={() => setPrompt(null)}
          onOk={prompt.mode === 'add' ? addRole : renameRole}
          extra={prompt.mode === 'add' && role && role.id !== ROOT_ROLE ? <Checkbox label={`Копиране на правата от „${role.name}“`} checked={copyRights} onChange={setCopyRights} /> : undefined}
        />
      )}
    </div>
  );
}

/** Permission tree of one role: each node inherits, allows or denies; effective value walks up to the nearest explicit value. */
function RoleRights({ role }: { role: Role }) {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const readOnly = role.id === ADMIN_ROLE || role.isReadOnly;
  const q = useQuery({ queryKey: ['roles', role.id, 'permissions'], queryFn: () => api.get<Perm[]>(`/roles/${role.id}/permissions`) });
  const [edits, setEdits] = useState<Map<number, boolean | null>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  useEffect(() => setEdits(new Map()), [q.data]);

  const perms = q.data ?? [];
  const byId = useMemo(() => new Map(perms.map((p) => [p.id, p])), [perms]);
  const kids = useMemo(() => {
    const m = new Map<number | null, Perm[]>();
    for (const p of perms) m.set(p.parentId, [...(m.get(p.parentId) ?? []), p]);
    for (const l of m.values()) l.sort((a, b) => a.groupOrder - b.groupOrder || a.id - b.id);
    return m;
  }, [perms]);
  // Collapse below the menu level by default.
  useEffect(() => {
    if (!perms.length) return;
    const depth = (p: Perm) => {
      let d = 0;
      for (let x = p; x.parentId != null && byId.get(x.parentId); x = byId.get(x.parentId)!) d++;
      return d;
    };
    setCollapsed(new Set(perms.filter((p) => kids.has(p.id) && depth(p) >= 2).map((p) => p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms.length]);

  const valueOf = (p: Perm) => (edits.has(p.id) ? edits.get(p.id)! : p.value);
  const effective = (p: Perm): boolean => {
    if (role.id === ADMIN_ROLE) return true;
    for (let x: Perm | undefined = p; x; x = x.parentId != null ? byId.get(x.parentId) : undefined) {
      const v = valueOf(x);
      if (v !== null) return v;
    }
    return true; // DefaultValue = 1 for every permission (spec 01b 3.6)
  };
  const setValue = (p: Perm, v: boolean | null) =>
    setEdits((e) => {
      const n = new Map(e);
      if (v === p.value) n.delete(p.id);
      else n.set(p.id, v);
      return n;
    });

  const rows = useMemo(() => {
    const out: { p: Perm; depth: number }[] = [];
    const f = filter.trim().toLowerCase();
    if (f) return perms.filter((p) => p.name.toLowerCase().includes(f) || p.key.toLowerCase().includes(f)).map((p) => ({ p, depth: 0 }));
    const roots = perms.filter((p) => p.parentId == null || !byId.has(p.parentId));
    const walk = (p: Perm, depth: number) => {
      out.push({ p, depth });
      if (!collapsed.has(p.id)) for (const k of kids.get(p.id) ?? []) walk(k, depth + 1);
    };
    for (const r of roots.sort((a, b) => a.groupOrder - b.groupOrder)) walk(r, 0);
    return out;
  }, [perms, byId, kids, collapsed, filter]);

  const save = async () => {
    try {
      await api.put(`/roles/${role.id}/permissions`, Object.fromEntries([...edits].map(([k, v]) => [String(k), v])));
      await invalidate('roles', 'session');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  if (q.isLoading) return <Empty><Spinner /></Empty>;
  if (q.error) return <Empty>{(q.error as Error).message}</Empty>;

  const opts: [boolean | null, string][] = [[null, 'Наследено'], [true, 'Разрешено'], [false, 'Забранено']];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-300 bg-slate-50 px-3 py-1.5">
        <span className="font-semibold whitespace-nowrap">Права на група „{role.name}“</span>
        <TextInput className="ml-3 w-56" placeholder="Търсене на право" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {!filter && (
          <>
            <Button variant="ghost" onClick={() => setCollapsed(new Set())}>Разгъни всички</Button>
            <Button variant="ghost" onClick={() => setCollapsed(new Set(perms.filter((p) => kids.has(p.id) && p.parentId != null && byId.has(p.parentId)).map((p) => p.id)))}>Свий всички</Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {readOnly ? (
            <span className="text-[12px] text-slate-500">Правата на администратора не могат да бъдат променяни.</span>
          ) : (
            <>
              {edits.size > 0 && <span className="text-[12px] text-amber-700">Променени: {edits.size}</span>}
              <Button disabled={!edits.size} onClick={() => setEdits(new Map())}>Отказ</Button>
              <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!edits.size} onClick={save}>
                Запис
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Право</th>
              <th className="w-px">Стойност</th>
              <th className="w-px">Ефективно</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, depth }) => {
              const v = valueOf(p);
              const eff = effective(p);
              const hasKids = kids.has(p.id);
              return (
                <tr key={p.id} className={cx(edits.has(p.id) && '!bg-amber-50')}>
                  <td style={{ paddingLeft: 8 + depth * 18 }} title={p.key}>
                    {hasKids && !filter ? (
                      <button className="mr-1 inline-flex align-middle text-slate-500" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}>
                        {collapsed.has(p.id) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                      </button>
                    ) : (
                      <span className="mr-1 inline-block w-3.5" />
                    )}
                    <span className={cx(hasKids && 'font-medium', !eff && 'text-slate-400')}>{p.name}</span>
                    <span className="ml-2 text-[11px] text-slate-400">{p.key}</span>
                  </td>
                  <td className="py-0.5">
                    <div className="inline-flex overflow-hidden rounded-sm border border-slate-300">
                      {opts.map(([ov, label]) => (
                        <button
                          key={label}
                          disabled={readOnly}
                          onClick={() => setValue(p, ov)}
                          className={cx(
                            'px-2 py-px text-[11.5px] disabled:cursor-not-allowed',
                            v === ov ? (ov === null ? 'bg-slate-200 font-medium text-slate-800' : ov ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white') : 'bg-white text-slate-600 hover:bg-slate-100',
                            readOnly && v !== ov && 'opacity-50',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="text-center">
                    {eff ? <Check className="inline size-4 text-emerald-600" aria-label="разрешено" /> : <X className="inline size-4 text-red-600" aria-label="забранено" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
