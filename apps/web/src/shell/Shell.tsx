import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote, BookOpen, Building2, CalendarDays, ChartColumn, ChevronRight, ClipboardList, FileCheck2, FilePlus2, FileText, HandCoins, LayoutTemplate, Library, ListTree,
  LogOut, Percent, RefreshCw, Scale, ScrollText, SearchCheck, Settings, Users, X, type LucideIcon,
} from 'lucide-react';
import { api } from '../api.ts';
import { bgDate } from '../format.ts';
import { useCan, useSession } from '../session.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Dialog, Field, TextInput, cx } from '../components/ui.tsx';
import { MENU, TOOLBAR, UNBINDABLE, findMenuItem, gestureOf, type MenuEntry, type MenuItem } from './menu.ts';
import { useWorkspace, type ScreenDef } from './workspace.tsx';
import { chooseActiveYear } from '../screens/admin/yearChoice.ts';

type Cmd = NonNullable<Extract<MenuItem, { label: string }>['command']>;

export function Shell({ screens, onCommand }: { screens: Record<string, ScreenDef>; onCommand: (c: Cmd) => void }) {
  const ws = useWorkspace();
  const can = useCan();
  const dialogs = useDialogs();
  const [changeUser, setChangeUser] = useState(false);

  /** Close several tabs; any unsaved page among them asks once (06 2.2). */
  const closeMany = async (exceptKey?: string) => {
    if (ws.tabs.some((t) => t.dirty && t.key !== exceptKey) && !(await dialogs.confirm(LOSE_CHANGES))) return false;
    ws.closeAll(exceptKey);
    return true;
  };

  const run = async (item: Extract<MenuItem, { label: string }>) => {
    if (item.screen) ws.open(item.screen);
    else if (item.command === 'closeCurrent') ws.active && closeTab(ws.active);
    else if (item.command === 'closeAll') void closeMany();
    else if (item.command === 'closeAllButCurrent') void closeMany(ws.active ?? undefined);
    else if ((item.command === 'logout' || item.command === 'chooseCompany') && !(await closeMany())) return;
    else if (item.command === 'about') void dialogs.alert('Шмикроинвест Шмелта Про — уеб счетоводна система, съвместима с Microinvest Делта Про 1.01.089.', 'За програмата');
    else if (item.command === 'changeUser') setChangeUser(true);
    else if (item.command === 'updateCheck') {
      const v = await api.get<{ version: string }>('/version');
      void dialogs.alert(`Използвате актуалната версия ${v.version}. Уеб приложението се обновява автоматично на сървъра.`, 'Нови версии');
    }
    else if (item.command) onCommand(item.command);
  };

  const closeTab = async (key: string) => {
    const t = ws.tabs.find((x) => x.key === key);
    if (t?.dirty && !(await dialogs.confirm('Желаете ли изход без запис на данните?'))) return;
    ws.close(key);
  };

  // Unsaved pages also guard closing the browser tab.
  const anyDirty = ws.tabs.some((t) => t.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [anyDirty]);

  // Hidden hotkey Ctrl+Shift+F8 (06 2.5): active database information.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && e.key === 'F8')) return;
      e.preventDefault();
      void api.get<{ server: string; engine: string; company: string; database: string; version: string }>('/session/database-info').then((i) =>
        dialogs.alert(`Сървър: ${i.server} (${i.engine})\nФирма: ${i.company}\nБаза данни: ${i.database}\nВерсия на базата: ${i.version}`, 'Активна база данни'),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogs]);

  // Global shortcuts from the menu definition.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const map = new Map<string, Extract<MenuItem, { label: string }>>();
    // A denied item makes its whole subtree inaccessible (06 1.2), shortcuts included.
    const walk = (items: MenuItem[]) => {
      for (const i of items) {
        if ('sep' in i || !can(i.permission)) continue;
        if (i.gesture && (i.screen || i.command)) map.set(i.gesture.replace(/\s/g, ''), i);
        if (i.children) walk(i.children);
      }
    };
    for (const m of MENU) if (can(m.permission)) walk(m.items);
    const onKey = (e: KeyboardEvent) => {
      // A screen's own bindings win (the editor's Shift+F2 adds the VAT line, not Шаблони).
      if (e.defaultPrevented) return;
      const g = gestureOf(e);
      const item = map.get(g);
      if (!item || UNBINDABLE.has(g)) return;
      e.preventDefault();
      void runRef.current(item);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can]);

  return (
    <div className="flex h-full flex-col">
      <MenuBar run={run} screens={screens} />
      <Toolbar screens={screens} run={(item) => void run(item)} />
      <TabStrip onClose={closeTab} />
      <main className="relative min-h-0 flex-1">
        {ws.tabs.length === 0 && <StartPage />}
        {ws.tabs.map((t) => {
          const def = screens[t.screen];
          if (!def) return null;
          const C = def.component;
          return (
            <div key={t.key} className={cx('absolute inset-0 flex flex-col overflow-hidden bg-white', t.key !== ws.active && 'hidden')}>
              <ScreenBoundary title={t.title}>
                <C tab={t} />
              </ScreenBoundary>
            </div>
          );
        })}
      </main>
      <StatusBar onCommand={(c) => (c === 'changeUser' ? setChangeUser(true) : void run({ label: '', command: c }))} />
      {changeUser && <ChangeUserDialog onClose={() => setChangeUser(false)} />}
    </div>
  );
}

/** A screen that fails to render shows the error in its own tab; the menu and other tabs keep working. */
class ScreenBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="m-6 rounded-sm border border-red-300 bg-red-50 px-4 py-3 text-red-900">
        <div className="font-medium">Възникна неочаквана грешка в „{this.props.title}“.</div>
        <div className="mt-1 text-[12px] opacity-80">{this.state.error.message}</div>
        <div className="mt-2 text-[12px]">Затворете прозореца и го отворете отново. Останалите прозорци не са засегнати.</div>
      </div>
    );
  }
}

/** Смяна на активния потребител (Ctrl+0, 01b 4): all windows close after the switch. */
function ChangeUserDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  // Always re-read: users may have been added since the list was cached (e.g. on the login screen).
  const users = useQuery({ queryKey: ['companyUsers', s.company.db], queryFn: () => api.get<{ id: number; name: string }[]>(`/companies/${s.company.db}/users`), refetchOnMount: 'always' });
  const others = (users.data ?? []).filter((u) => u.id !== s.user.id);
  const [userId, setUserId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (users.isFetching) return;
    if (users.data && !others.length) {
      void dialogs.alert('В системата няма дефинирани други потребители!').then(onClose);
    } else if (others.length && userId === null) setUserId(others[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users.data, users.isFetching]);
  if (users.isFetching || !others.length) return null;
  const submit = async () => {
    if (!(await dialogs.confirm('Всички прозорци ще бъдат затворени! Желаете ли да продължите?'))) return;
    try {
      await api.post('/login', { companyDb: s.company.db, userId, password });
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e);
      setPassword('');
    }
  };
  return (
    <Dialog title="Смяна на активния потребител" onClose={onClose} width={360} footer={<><Button variant="primary" onClick={submit}>OK</Button><Button onClick={onClose}>Отказ</Button></>}>
      <div className="flex flex-col gap-2">
        <Field label="Потребител">
          <select className="field-input" value={userId ?? ''} onChange={(e) => setUserId(Number(e.target.value))}>
            {others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Парола">
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        {!!error && <div className="text-red-700">{error instanceof Error ? error.message : String(error)}</div>}
      </div>
    </Dialog>
  );
}

function BranchDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<{ id: number; code: string; name: string }[]>('/branches') });
  const [id, setId] = useState(s.branch?.id ?? 1);
  const save = async () => {
    try {
      await api.put('/session/branch', { branchId: id });
      await qc.invalidateQueries({ queryKey: ['session'] });
      onClose();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <Dialog title="Активен клон" onClose={onClose} width={340} footer={<><Button variant="primary" onClick={save}>OK</Button><Button onClick={onClose}>Отказ</Button></>}>
      <Field label="Клон">
        <select className="field-input" value={id} onChange={(e) => setId(Number(e.target.value))}>
          {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.code} – {b.name}</option>)}
        </select>
      </Field>
    </Dialog>
  );
}

function MenuBar({ run, screens }: { run: (i: Extract<MenuItem, { label: string }>) => void; screens: Record<string, ScreenDef> }) {
  const can = useCan();
  const s = useSession();
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  const pick = (i: Extract<MenuItem, { label: string }>) => {
    setOpen(null);
    run(i);
  };
  return (
    <div ref={ref} data-testid="menu-bar" className="flex items-center border-b border-slate-300 bg-white px-1 text-[13px] select-none">
      <div className="mr-2 flex items-center gap-1.5 px-2 font-semibold text-brand-700">
        <span className="grid size-5 place-items-center rounded-sm bg-brand-600 text-[11px] font-bold text-white">Ш</span>
        Шмелта Про
      </div>
      {MENU.map((m, i) => can(m.permission) && (
        <div key={m.label} className="relative">
          <button
            className={cx('px-2.5 py-1 hover:bg-brand-50', open === i && 'bg-brand-100')}
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen(open === i ? null : i);
            }}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && <MenuList items={m.items} pick={pick} screens={screens} />}
        </div>
      ))}
      <div className="ml-auto truncate px-3 text-[12px] text-slate-500">
        {s.company.name} · {s.user.name}
      </div>
    </div>
  );
}

function MenuList({ items, pick, screens, nested }: { items: MenuItem[]; pick: (i: Extract<MenuItem, { label: string }>) => void; screens: Record<string, ScreenDef>; nested?: boolean }) {
  const can = useCan();
  const [sub, setSub] = useState<number | null>(null);
  // 06 1.2: Visible = IsActivated and IsAccessible; a denied item (and so its children) is hidden,
  // and separators left at either end or next to each other are dropped.
  const rows = items.map((it, i) => ({ it, i })).filter(({ it }) => 'sep' in it || can(it.permission));
  const cleaned: typeof rows = [];
  for (const r of rows) if (!('sep' in r.it) || (cleaned.length && !('sep' in cleaned[cleaned.length - 1]!.it))) cleaned.push(r);
  if (cleaned.length && 'sep' in cleaned[cleaned.length - 1]!.it) cleaned.pop();
  return (
    <div data-testid="menu-list" className={cx('absolute z-40 min-w-64 border border-slate-300 bg-white py-1 shadow-lg', nested ? 'top-[-5px] left-full' : 'top-full left-0')}>
      {cleaned.map(({ it, i }) => {
        if ('sep' in it) return <div key={i} className="my-1 border-t border-slate-200" />;
        const implemented = !!it.children || !!it.command || (!!it.screen && !!screens[it.screen]);
        const enabled = implemented;
        return (
          <div key={i} className="relative" onMouseEnter={() => setSub(it.children ? i : null)}>
            <button
              disabled={!enabled}
              title={!implemented ? 'Предстои' : undefined}
              onClick={() => !it.children && pick(it)}
              className={cx('flex w-full items-center gap-6 px-4 py-1 text-left', enabled ? 'hover:bg-brand-500 hover:text-white' : 'text-slate-400')}
            >
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.gesture && <span className="text-[11px] opacity-70">{it.gesture}</span>}
              {it.children && <ChevronRight className="size-3.5" />}
            </button>
            {it.children && sub === i && enabled && <MenuList items={it.children} pick={pick} screens={screens} nested />}
          </div>
        );
      })}
    </div>
  );
}

/** Start page shortcuts. */
const HOME_TILES = [
  { screen: 'entry', label: 'Контиране', icon: FilePlus2, permission: 'UI_Operations_Accounting' },
  { screen: 'journal', label: 'Журнал', icon: ScrollText, permission: 'UI_Edit_Accountings' },
  { screen: 'partners', label: 'Партньори', icon: Users, permission: 'UI_Edit_Companies' },
  { screen: 'chart', label: 'Сметкоплан', icon: ListTree, permission: 'UI_Operations_ChartOfAccounts_IndividualChartOfAccounts' },
  { screen: 'trialBalance', label: 'Оборотна ведомост', icon: Scale, permission: 'UI_Reporting_TurnoverReport' },
  { screen: 'financialStatements', label: 'Отчети и баланс', icon: ChartColumn, permission: 'UI_Reporting_FinancialReports' },
  { screen: 'years', label: 'Счетоводна година', icon: CalendarDays, permission: 'UI_Edit_ChangeActiveFinancialYear' },
  { screen: 'myCompany', label: 'Моята фирма', icon: Building2, permission: 'UI_Edit_Administration_MyCompany' },
];

const TOOLBAR_ICONS: Record<(typeof TOOLBAR)[number]['id'], LucideIcon> = {
  tlbExit: LogOut, tlbAccounting: FilePlus2, tlbTemplates: LayoutTemplate, tlbPayments: HandCoins, tlbAccountingRequests: ClipboardList,
  tlbChartOfAccounts: ListTree, tlbEditAccountings: ScrollText, tlbTurnoverReport: Scale, tlbGeneralLedgerReport: Library,
  tlbChronologicalReport: BookOpen, tlbAnalyticalReport: FileText, tlbPartnersReport: Users, tlbVATDiary: Percent,
  tlbAccountingsValidation: SearchCheck, tlbAccountingsNAPValidation: FileCheck2, tlbFinancialReports: ChartColumn,
  tlbBankStatementsImport: Banknote, tlbSettings: Settings, tlbUpdate: RefreshCw,
};

/** Toolbar (06 1.5): visible when the menu item's module exists and its menu path is permitted. */
function Toolbar({ screens, run }: { screens: Record<string, ScreenDef>; run: (item: MenuEntry) => void }) {
  const can = useCan();
  const buttons = TOOLBAR.flatMap((t) => {
    const found = findMenuItem(t.menu);
    if (!found) return [];
    const available = !!found.item.command || (!!found.item.screen && !!screens[found.item.screen]);
    return available && found.permissions.every((p) => can(p)) ? [{ ...t, item: found.item, Icon: TOOLBAR_ICONS[t.id] }] : [];
  });
  return (
    <div role="toolbar" aria-label="Лента с инструменти" className="flex h-[51px] shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-slate-300 bg-gradient-to-b from-slate-50 to-slate-100 px-2 py-1">
      {buttons.map((b) => (
        <button key={b.id} title={b.tooltip} aria-label={b.tooltip} onClick={() => run(b.item)}
          className="flex min-w-[52px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-sm px-1.5 text-[10.5px] whitespace-nowrap text-slate-700 hover:bg-brand-100">
          <b.Icon className="size-5 text-brand-600" strokeWidth={1.6} />
          <span>{b.caption}</span>
        </button>
      ))}
    </div>
  );
}

function TabStrip({ onClose }: { onClose: (key: string) => void }) {
  const ws = useWorkspace();
  if (!ws.tabs.length) return null;
  return (
    <div className="flex items-end gap-px overflow-x-auto border-b border-slate-300 bg-slate-200 px-1 pt-1">
      {ws.tabs.map((t) => (
        <div
          key={t.key}
          onMouseDown={(e) => e.button === 1 && onClose(t.key)}
          className={cx(
            'group flex max-w-56 shrink-0 items-center gap-1 rounded-t-sm border border-b-0 px-2.5 py-1 text-[12.5px]',
            t.key === ws.active ? 'border-slate-300 bg-white font-medium text-slate-900' : 'border-transparent bg-slate-300/60 text-slate-600 hover:bg-slate-100',
          )}
        >
          <button className="truncate" onClick={() => ws.activate(t.key)}>
            {t.title}
            {t.dirty && <span className="text-brand-600"> *</span>}
          </button>
          <button className="rounded p-0.5 opacity-50 hover:bg-slate-200 hover:opacity-100" onClick={() => onClose(t.key)} aria-label="Затвори">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

const LOSE_CHANGES = 'Има незаписани промени, които ще бъдат загубени! Желаете ли да продължите?';

/** Status bar (06 2.3): every cell is clickable; the clock ticks each second. */
function StatusBar({ onCommand }: { onCommand: (c: Cmd) => void }) {
  const s = useSession();
  const can = useCan();
  const [editDate, setEditDate] = useState(false);
  const [editBranch, setEditBranch] = useState(false);
  const [editYear, setEditYear] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/Sofia' });
  return (
    <footer className="flex items-center gap-px border-t border-slate-300 bg-slate-200 text-[12px] text-slate-700">
      <Cell label="Потребител" onClick={can('UI_Edit_Administration_ChangeActiveUser') ? () => onCommand('changeUser') : undefined}>{s.user.name}</Cell>
      <Cell label="Фирма" onClick={can('UI_File_ChooseCompany') ? () => onCommand('chooseCompany') : undefined}>{s.company.name}</Cell>
      <Cell label="Година" onClick={can('UI_Edit_ChangeActiveFinancialYear') ? () => setEditYear(true) : undefined}>
        {s.year.year}
        {s.year.isLocked && ' 🔒'}
      </Cell>
      <Cell label="Клон" onClick={() => setEditBranch(true)}>{s.branch?.name ?? '-'}</Cell>
      <Cell label="Валута">{s.baseCurrency === 'EUR' ? 'EUR (евро)' : 'BGN (лева)'}</Cell>
      <Cell label="Дата" onClick={() => setEditDate(true)}>
        {bgDate(s.workingDate)} <span className="font-normal text-slate-500" data-testid="clock">{time}</span>
      </Cell>
      {editDate && <WorkingDateDialog onClose={() => setEditDate(false)} />}
      {editBranch && <BranchDialog onClose={() => setEditBranch(false)} />}
      {editYear && <YearDialog onClose={() => setEditYear(false)} />}
    </footer>
  );
}

/** Year chooser from the status bar (01b 6.3): locked years cannot be chosen. */
function YearDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const years = useQuery({ queryKey: ['years'], queryFn: () => api.get<{ id: number; year: number; isLocked: boolean }[]>('/years') });
  const [year, setYear] = useState(s.year.year);
  const save = async () => {
    if (years.data?.find((y) => y.year === year)?.isLocked) {
      await dialogs.alert('Избраната счетоводна година е заключена и не може да бъде избрана!');
      return;
    }
    try {
      const r = await chooseActiveYear(dialogs, s.workingDate, year);
      if (r === 'cancel') return;
      if (r === 'conclude') ws.open('years', { params: { concludeYear: year - 1 } });
      else await qc.invalidateQueries();
      onClose();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <Dialog title="Счетоводна година" onClose={onClose} width={300} footer={<><Button variant="primary" onClick={save}>OK</Button><Button onClick={onClose}>Отказ</Button></>}>
      <Field label="Активна година">
        <select className="field-input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.data?.map((y) => <option key={y.id} value={y.year}>{y.year}{y.isLocked ? ' (заключена)' : ''}</option>)}
        </select>
      </Field>
    </Dialog>
  );
}

function Cell({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  const C = onClick ? 'button' : 'div';
  return (
    <C onClick={onClick} className={cx('flex items-center gap-1.5 bg-slate-100 px-3 py-1 first:pl-3 last:flex-1 last:justify-end', onClick && 'hover:bg-brand-50')}>
      <span className="text-slate-500">{label}:</span>
      <span className="font-medium">{children}</span>
    </C>
  );
}

function WorkingDateDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const [date, setDate] = useState(s.workingDate);
  const save = async () => {
    // 06 2.4: a date in an earlier year moves the active year back to it.
    if (Number(date.slice(0, 4)) < s.year.year && !(await dialogs.confirm('Текущата дата на приложението не може да е в по-ранна година от избраната счетоводна година! За счетоводна година ще бъде избрана текущата година на приложението. Желаете ли да продължите?'))) return;
    try {
      await api.put('/session/working-date', { date });
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  return (
    <Dialog title="Работна дата" onClose={onClose} width={340} footer={<><Button variant="primary" onClick={save}>OK</Button><Button onClick={onClose}>Отказ</Button></>}>
      <Field label="Дата на приложението" hint="Датата по подразбиране за нови контировки. Смяна на годината сменя активната счетоводна година.">
        <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </Field>
    </Dialog>
  );
}

function StartPage() {
  const ws = useWorkspace();
  const s = useSession();
  const can = useCan();
  return (
    <div className="h-full overflow-auto bg-gradient-to-br from-slate-100 to-brand-50 p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-light text-slate-800">{s.company.name}</h1>
        <p className="mt-1 text-slate-500">
          Счетоводна година {s.year.year} · основна валута {s.baseCurrency} · работна дата {bgDate(s.workingDate)}
        </p>
        {s.chartIsEmpty && (
          <div className="mt-4 rounded-sm border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
            Сметкопланът за {s.year.year} е празен.{' '}
            <button className="font-medium underline" onClick={() => ws.open('chartSelection')}>
              Изберете сметкоплан
            </button>
          </div>
        )}
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
          {HOME_TILES.filter((t) => can(t.permission)).map((t) => (
            <button key={t.screen} onClick={() => ws.open(t.screen)} className="flex items-center gap-3 rounded-sm border border-slate-200 bg-white px-4 py-3 text-left shadow-sm hover:border-brand-500 hover:shadow">
              <t.icon className="size-6 text-brand-600" strokeWidth={1.5} />
              <span className="font-medium text-slate-700">{t.label}</span>
            </button>
          ))}
          <button onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => location.reload())} className="flex items-center gap-3 rounded-sm border border-slate-200 bg-white px-4 py-3 text-left shadow-sm hover:border-red-400">
            <LogOut className="size-6 text-slate-500" strokeWidth={1.5} />
            <span className="font-medium text-slate-700">Изход</span>
          </button>
        </div>
      </div>
    </div>
  );
}
