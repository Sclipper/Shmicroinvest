import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { api } from '../api.ts';
import { cx } from '../components/ui.tsx';
import { useCan, useSession } from '../session.tsx';
import { findMenuItemByScreen } from './menu.ts';
import { GENERAL_HELP, SCREEN_HELP } from './help.ts';
import { useQuickGroups } from './quickCommands.tsx';
import { useWorkspace, type ScreenDef } from './workspace.tsx';

/**
 * Left column of the main window (06 2.1 shellview.xaml): an expander with the
 * three panels "Бързи команди", "Помощен панел" and "Съобщения". The state of
 * the expander and of each panel persists per browser (ElementState.UId).
 */
export type PanelId = 'quick' | 'help' | 'messages';
export interface SidePanelState {
  open: boolean;
  quick: boolean;
  help: boolean;
  messages: boolean;
}

const KEY = 'shmi.sidePanels';
const DEFAULT: SidePanelState = { open: false, quick: true, help: true, messages: true };

function load(): SidePanelState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SidePanelState> | null;
    return { ...DEFAULT, ...(v && typeof v === 'object' ? v : {}) };
  } catch {
    return DEFAULT;
  }
}

/** Panel state with its persistence; `toggle(panel)` from the Прозорци menu shows the column and flips the panel. */
export function useSidePanelState() {
  const [state, setState] = useState<SidePanelState>(load);
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(state));
  }, [state]);
  return {
    state,
    setOpen: (open: boolean) => setState((s) => ({ ...s, open })),
    flip: (p: PanelId) => setState((s) => ({ ...s, [p]: !s[p] })),
    /** Menu toggle: a hidden column opens with the panel expanded; otherwise the panel flips. */
    toggle: (p: PanelId) => setState((s) => (!s.open ? { ...s, open: true, [p]: true } : { ...s, [p]: !s[p] })),
  };
}

export interface ShellNotice {
  key: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  screen?: string;
  screenLabel?: string;
}

export function useShellNotices() {
  const s = useSession();
  return useQuery({
    queryKey: ['session', 'messages', s.company.db, s.year.id, s.workingDate],
    queryFn: () => api.get<ShellNotice[]>('/session/messages'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const PANELS: { id: PanelId; title: string }[] = [
  { id: 'quick', title: 'Бързи команди' },
  { id: 'help', title: 'Помощен панел' },
  { id: 'messages', title: 'Съобщения' },
];

export function SidePanels({ screens, panels }: { screens: Record<string, ScreenDef>; panels: ReturnType<typeof useSidePanelState> }) {
  const notices = useShellNotices();
  const count = notices.data?.length ?? 0;
  const { state } = panels;
  if (!state.open) {
    return (
      <aside aria-label="Странични панели" className="flex w-6 shrink-0 flex-col items-center gap-1 border-r border-slate-300 bg-slate-100 py-1 print:hidden">
        <button type="button" title="Показване на панелите" aria-label="Показване на панелите" className="rounded-sm p-0.5 text-slate-600 hover:bg-brand-100" onClick={() => panels.setOpen(true)}>
          <ChevronRight className="size-3.5" />
        </button>
        {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="rounded-sm px-0.5 py-1.5 text-[11px] whitespace-nowrap text-slate-600 [writing-mode:vertical-rl] hover:bg-brand-100"
            onClick={() => panels.toggle(p.id)}
          >
            {p.title}
            {p.id === 'messages' && count > 0 && <span data-testid="messages-badge" className="mt-1 rounded-full bg-amber-500 px-1 text-[10px] text-white">{count}</span>}
          </button>
        ))}
      </aside>
    );
  }
  return (
    <aside aria-label="Странични панели" className="flex w-60 shrink-0 flex-col overflow-hidden border-r border-slate-300 bg-slate-50 text-[12px] print:hidden">
      <div className="flex items-center justify-end border-b border-slate-200 px-1 py-0.5">
        <button type="button" title="Скриване на панелите" aria-label="Скриване на панелите" className="rounded-sm p-0.5 text-slate-600 hover:bg-brand-100" onClick={() => panels.setOpen(false)}>
          <ChevronLeft className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Section id="quick" title="Бързи команди" open={state.quick} onFlip={() => panels.flip('quick')}>
          <QuickCommandsPanel screens={screens} />
        </Section>
        <Section id="help" title="Помощен панел" open={state.help} onFlip={() => panels.flip('help')}>
          <HelpPanel screens={screens} />
        </Section>
        <Section id="messages" title="Съобщения" badge={count} open={state.messages} onFlip={() => panels.flip('messages')}>
          <MessagesPanel notices={notices.data ?? []} loading={notices.isLoading} screens={screens} />
        </Section>
      </div>
    </aside>
  );
}

function Section({ id, title, badge, open, onFlip, children }: { id: PanelId; title: string; badge?: number; open: boolean; onFlip: () => void; children: ReactNode }) {
  return (
    <section data-testid={`panel-${id}`} className="border-b border-slate-300">
      <h2>
        <button type="button" aria-expanded={open} className="flex w-full items-center gap-1 bg-gradient-to-b from-slate-100 to-slate-200 px-2 py-1 text-left font-semibold text-slate-700 hover:from-brand-50" onClick={onFlip}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="flex-1">{title}</span>
          {!!badge && <span className="rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{badge}</span>}
        </button>
      </h2>
      {open && <div className="px-2 py-1.5">{children}</div>}
    </section>
  );
}

function LinkButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="block w-full truncate rounded-sm px-1 py-0.5 text-left text-brand-700 hover:bg-brand-100 disabled:text-slate-400 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

/** Starting points when no screen is open, or the screen publishes no commands. */
const DEFAULT_QUICK: [string, string][] = [['entry', 'Контиране'], ['journal', 'Редакция на контиране'], ['payments', 'Разплащания'], ['trialBalance', 'Оборотна ведомост'], ['partners', 'Партньори']];

function QuickCommandsPanel({ screens }: { screens: Record<string, ScreenDef> }) {
  const ws = useWorkspace();
  const can = useCan();
  const groups = useQuickGroups(ws.active);
  const open = (id: string) => ws.open(id);
  if (groups?.length) {
    return (
      <div className="flex flex-col gap-1.5">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="mb-0.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">{g.title}</div>
            {g.items.map((i) => (
              <LinkButton key={i.label} disabled={i.disabled} onClick={i.run}>
                {i.label}
                {i.gesture && <span className="ml-1 text-[10px] text-slate-500">{i.gesture}</span>}
              </LinkButton>
            ))}
          </div>
        ))}
      </div>
    );
  }
  const items = DEFAULT_QUICK.filter(([id]) => screens[id] && can(screens[id]!.permission));
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Често използвани</div>
      {items.map(([id, label]) => (
        <LinkButton key={id} onClick={() => open(id)}>{label}</LinkButton>
      ))}
    </div>
  );
}

function HelpPanel({ screens }: { screens: Record<string, ScreenDef> }) {
  const ws = useWorkspace();
  const can = useCan();
  const tab = ws.tabs.find((t) => t.key === ws.active);
  const help = (tab && SCREEN_HELP[tab.screen]) || GENERAL_HELP;
  const entry = tab ? findMenuItemByScreen(tab.screen) : null;
  const links = (help.links ?? []).filter(([id]) => id !== tab?.screen && screens[id] && can(screens[id]!.permission));
  return (
    <div data-testid="help-panel" className="flex flex-col gap-1">
      {tab && <div className="font-semibold text-slate-700">{tab.title}</div>}
      {entry && (
        <div className="text-[11px] text-slate-500">
          {entry.path.join(' › ')}
          {entry.item.gesture && ` (${entry.item.gesture})`}
        </div>
      )}
      <p className="leading-snug text-slate-700">{help.text}</p>
      {links.length > 0 && (
        <div>
          <div className="mt-0.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Вижте също</div>
          {links.map(([id, label]) => (
            <LinkButton key={id} onClick={() => ws.open(id)}>{label}</LinkButton>
          ))}
        </div>
      )}
    </div>
  );
}

const LEVEL_ICON = {
  error: <CircleAlert className="mt-px size-3.5 shrink-0 text-red-600" />,
  warning: <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600" />,
  info: <Info className="mt-px size-3.5 shrink-0 text-brand-600" />,
};

function MessagesPanel({ notices, loading, screens }: { notices: ShellNotice[]; loading: boolean; screens: Record<string, ScreenDef> }) {
  const ws = useWorkspace();
  const can = useCan();
  if (loading) return <div className="text-slate-500">Зареждане…</div>;
  if (!notices.length) return <div className="text-slate-500">Няма съобщения.</div>;
  return (
    <ul data-testid="messages-list" className="flex flex-col gap-1.5">
      {notices.map((n) => (
        <li key={n.key} data-key={n.key} className={cx('flex gap-1.5 rounded-sm border px-1.5 py-1', n.level === 'error' ? 'border-red-200 bg-red-50' : n.level === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white')}>
          {LEVEL_ICON[n.level]}
          <div className="min-w-0 flex-1">
            <div className="leading-snug">{n.text}</div>
            {n.screen && screens[n.screen] && can(screens[n.screen]!.permission) && (
              <button type="button" className="mt-0.5 text-[11px] text-brand-700 underline hover:text-brand-900" onClick={() => ws.open(n.screen!)}>
                {n.screenLabel ?? screens[n.screen]!.title}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
