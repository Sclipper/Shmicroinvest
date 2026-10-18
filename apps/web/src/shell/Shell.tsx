import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BookOpen, Building2, CalendarDays, ChevronRight, FilePlus2, FileText, ListTree, LogOut, Scale, Settings, Users, X, Library, ScrollText,
} from 'lucide-react';
import { api } from '../api.ts';
import { bgDate } from '../format.ts';
import { useCan, useSession } from '../session.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Dialog, Field, TextInput, cx } from '../components/ui.tsx';
import { MENU, UNBINDABLE, gestureOf, type MenuItem } from './menu.ts';
import { useWorkspace, type ScreenDef } from './workspace.tsx';

type Cmd = NonNullable<Extract<MenuItem, { label: string }>['command']>;

export function Shell({ screens, onCommand }: { screens: Record<string, ScreenDef>; onCommand: (c: Cmd) => void }) {
  const ws = useWorkspace();
  const can = useCan();
  const dialogs = useDialogs();

  const run = (item: Extract<MenuItem, { label: string }>) => {
    if (item.screen) ws.open(item.screen);
    else if (item.command === 'closeCurrent') ws.active && closeTab(ws.active);
    else if (item.command === 'closeAll') ws.closeAll();
    else if (item.command === 'closeAllButCurrent') ws.closeAll(ws.active ?? undefined);
    else if (item.command === 'about') void dialogs.alert('Шмикроинвест Делта — уеб счетоводна система, съвместима с Microinvest Делта Про 1.01.089.', 'За програмата');
    else if (item.command) onCommand(item.command);
  };

  const closeTab = async (key: string) => {
    const t = ws.tabs.find((x) => x.key === key);
    if (t?.dirty && !(await dialogs.confirm('Желаете ли изход без запис на данните?'))) return;
    ws.close(key);
  };

  // Global shortcuts from the menu definition.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const map = new Map<string, Extract<MenuItem, { label: string }>>();
    const walk = (items: MenuItem[]) => {
      for (const i of items) {
        if ('sep' in i) continue;
        if (i.gesture && (i.screen || i.command) && can(i.permission)) map.set(i.gesture.replace(/\s/g, ''), i);
        if (i.children) walk(i.children);
      }
    };
    for (const m of MENU) walk(m.items);
    const onKey = (e: KeyboardEvent) => {
      const g = gestureOf(e);
      const item = map.get(g);
      if (!item || UNBINDABLE.has(g)) return;
      e.preventDefault();
      runRef.current(item);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can]);

  return (
    <div className="flex h-full flex-col">
      <MenuBar run={run} screens={screens} />
      <Toolbar />
      <TabStrip onClose={closeTab} />
      <main className="relative min-h-0 flex-1">
        {ws.tabs.length === 0 && <StartPage />}
        {ws.tabs.map((t) => {
          const def = screens[t.screen];
          if (!def) return null;
          const C = def.component;
          return (
            <div key={t.key} className={cx('absolute inset-0 flex flex-col overflow-hidden bg-white', t.key !== ws.active && 'hidden')}>
              <C tab={t} />
            </div>
          );
        })}
      </main>
      <StatusBar />
    </div>
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
    <div ref={ref} className="flex items-center border-b border-slate-300 bg-white px-1 text-[13px] select-none">
      <div className="mr-2 flex items-center gap-1.5 px-2 font-semibold text-brand-700">
        <span className="grid size-5 place-items-center rounded-sm bg-brand-600 text-[11px] font-bold text-white">Δ</span>
        Делта
      </div>
      {MENU.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            className={cx('px-2.5 py-1 hover:bg-brand-50', open === i && 'bg-brand-100', !can(m.permission) && 'text-slate-400')}
            disabled={!can(m.permission)}
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
  return (
    <div className={cx('absolute z-40 min-w-64 border border-slate-300 bg-white py-1 shadow-lg', nested ? 'top-[-5px] left-full' : 'top-full left-0')}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="my-1 border-t border-slate-200" />;
        const implemented = !!it.children || !!it.command || (!!it.screen && !!screens[it.screen]);
        const enabled = can(it.permission) && implemented;
        return (
          <div key={i} className="relative" onMouseEnter={() => setSub(it.children ? i : null)}>
            <button
              disabled={!enabled}
              title={!implemented ? 'Предстои' : !can(it.permission) ? 'Нямате права' : undefined}
              onClick={() => !it.children && pick(it)}
              className={cx('flex w-full items-center gap-6 px-4 py-1 text-left', enabled ? 'hover:bg-brand-500 hover:text-white' : 'text-slate-400')}
            >
              <span className="flex-1">{it.label}</span>
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

const TOOLBAR = [
  { screen: 'entry', label: 'Контиране', icon: FilePlus2, permission: 'UI_Operations_Accounting' },
  { screen: 'journal', label: 'Операции', icon: ScrollText, permission: 'UI_Edit_Accountings' },
  { screen: 'partners', label: 'Партньори', icon: Users, permission: 'UI_Edit_Companies' },
  { screen: 'chart', label: 'Сметкоплан', icon: ListTree, permission: 'UI_Operations_ChartOfAccounts_IndividualChartOfAccounts' },
  { screen: 'trialBalance', label: 'Оборотна', icon: Scale, permission: 'UI_Reporting_TurnoverReport' },
  { screen: 'chronological', label: 'Хронологичен', icon: BookOpen, permission: 'UI_Reporting_ChronologicalReport' },
  { screen: 'analytical', label: 'Аналитичен', icon: FileText, permission: 'UI_Reporting_AnalyticalReport' },
  { screen: 'generalLedger', label: 'Главна книга', icon: Library, permission: 'UI_Reporting_GeneralLedger' },
  { screen: 'years', label: 'Година', icon: CalendarDays, permission: 'UI_Edit_ChangeActiveFinancialYear' },
  { screen: 'myCompany', label: 'Моята фирма', icon: Building2, permission: 'UI_Edit_Administration_MyCompany' },
  { screen: 'settings', label: 'Настройки', icon: Settings, permission: 'UI_Other_Settings' },
];

function Toolbar() {
  const ws = useWorkspace();
  const can = useCan();
  return (
    <div className="flex items-stretch gap-0.5 border-b border-slate-300 bg-gradient-to-b from-slate-50 to-slate-100 px-2 py-1">
      {TOOLBAR.filter((t) => can(t.permission)).map((t) => (
        <button key={t.screen} onClick={() => ws.open(t.screen)} className="flex w-[88px] flex-col items-center gap-0.5 rounded-sm px-1 py-1 text-[11px] text-slate-700 hover:bg-brand-100">
          <t.icon className="size-5 text-brand-600" strokeWidth={1.6} />
          <span className="truncate">{t.label}</span>
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
            {t.dirty && <span className="text-brand-600">● </span>}
            {t.title}
          </button>
          <button className="rounded p-0.5 opacity-50 hover:bg-slate-200 hover:opacity-100" onClick={() => onClose(t.key)} aria-label="Затвори">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function StatusBar() {
  const s = useSession();
  const ws = useWorkspace();
  const [editDate, setEditDate] = useState(false);
  return (
    <footer className="flex items-center gap-px border-t border-slate-300 bg-slate-200 text-[12px] text-slate-700">
      <Cell label="Година" onClick={() => ws.open('years')}>
        {s.year.year}
        {s.year.isLocked && ' 🔒'}
      </Cell>
      <Cell label="Фирма">{s.company.name}</Cell>
      <Cell label="Клон">{s.branch?.name ?? '-'}</Cell>
      <Cell label="Потребител">{s.user.name}</Cell>
      <Cell label="Валута">{s.baseCurrency === 'EUR' ? 'EUR (евро)' : 'BGN (лева)'}</Cell>
      <Cell label="Дата" onClick={() => setEditDate(true)}>
        {bgDate(s.workingDate)}
      </Cell>
      {editDate && <WorkingDateDialog onClose={() => setEditDate(false)} />}
    </footer>
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
          {TOOLBAR.filter((t) => can(t.permission)).map((t) => (
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
