import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../api.ts';
import { Button, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../../components/ui.tsx';

type Status = 'verified' | 'warning' | 'error';
interface GdprResult { overall: Status; rules: { group: string; rule: string; status: Status; details?: string }[] }

const STATUS: Record<Status, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  verified: { label: 'Проверено', icon: CheckCircle2, cls: 'text-emerald-600' },
  warning: { label: 'Предупреждение', icon: AlertTriangle, cls: 'text-amber-600' },
  error: { label: 'Грешка', icon: XCircle, cls: 'text-red-600' },
};
const OVERALL: Record<Status, string> = {
  verified: 'Всички проверки за съответствие с GDPR са успешни.',
  warning: 'Проверката завърши с предупреждения. Прегледайте отбелязаните правила.',
  error: 'Има несъответствия с изискванията на GDPR. Коригирайте отбелязаните правила.',
};

/** GDPR проверка (Други; 06 9, 07 4 GDPRValidatorView): runs the checks on Проверка. */
export function GdprValidator() {
  const q = useQuery({ queryKey: ['gdpr'], queryFn: () => api.get<GdprResult>('/gdpr/validate'), enabled: false });
  const groups = useMemo(() => {
    const m = new Map<string, GdprResult['rules']>();
    for (const r of q.data?.rules ?? []) m.set(r.group, [...(m.get(r.group) ?? []), r]);
    return [...m];
  }, [q.data]);
  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<ShieldCheck className="size-3.5" />} onClick={() => q.refetch()} disabled={q.isFetching}>
          Проверка
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {q.isFetching ? (
          <Empty><Spinner /></Empty>
        ) : q.error ? (
          <Empty>{(q.error as Error).message}</Empty>
        ) : !q.data ? (
          <Empty>Натиснете „Проверка“, за да проверите потребителите, паролите и защитата на сървъра.</Empty>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div data-testid="gdpr-overall" className={cx('rounded-sm border px-4 py-3 font-medium', q.data.overall === 'verified' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : q.data.overall === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-300 bg-red-50 text-red-900')}>
              {OVERALL[q.data.overall]}
            </div>
            {groups.map(([group, rules]) => (
              <section key={group} className="rounded-sm border border-slate-200 bg-white">
                <h3 className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 font-semibold text-slate-700">{group}</h3>
                <ul>
                  {rules.map((r) => {
                    const st = STATUS[r.status];
                    return (
                      <li key={r.rule} className="flex items-start gap-3 border-b border-slate-100 px-3 py-2 last:border-0">
                        <st.icon className={cx('mt-0.5 size-4 shrink-0', st.cls)} aria-label={st.label} />
                        <div className="flex-1">
                          <div>{r.rule}</div>
                          {r.details && <div className="text-[12px] text-slate-500">{r.details}</div>}
                        </div>
                        <span className={cx('text-[12px] font-medium', st.cls)}>{st.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface LogEntry { dateTime: string; level: 'info' | 'warning' | 'error'; message: string; details?: string; company?: string | null; user?: string | null }
const LEVEL: Record<LogEntry['level'], string> = { info: 'Информация', warning: 'Предупреждение', error: 'Грешка' };
const p2 = (n: number) => String(n).padStart(2, '0');
const ts = (iso: string) => {
  const d = new Date(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/** Дневник на приложението (Помощ; 06 7.2 ErrorLog viewer). */
export function ApplicationLog() {
  const list = useQuery({ queryKey: ['appLog'], queryFn: () => api.get<LogEntry[]>('/app-log?limit=2000') });
  const [level, setLevel] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(() => {
    const f = text.trim().toLowerCase();
    return (list.data ?? []).filter((r) => (!level || r.level === level) && (!f || `${r.message} ${r.user ?? ''} ${r.company ?? ''}`.toLowerCase().includes(f)));
  }, [list.data, level, text]);
  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{rows.length} записа</span>}>
        <Field label="Вид" className="w-40">
          <Select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Всички</option>
            {Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Търсене" className="w-64">
          <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder="Съобщение, потребител, фирма" />
        </Field>
        <Button className="self-end" icon={<RefreshCw className="size-3.5" />} onClick={() => list.refetch()}>
          Обнови
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {list.isLoading ? (
          <Empty><Spinner /></Empty>
        ) : !rows.length ? (
          <Empty>Дневникът е празен.</Empty>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Дата и час</th>
                <th>Вид</th>
                <th>Потребител</th>
                <th>Фирма</th>
                <th>Съобщение</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} onClick={() => setOpen(open === i ? null : i)} className={r.details ? 'cursor-pointer' : undefined}>
                  <td className="w-40">{ts(r.dateTime)}</td>
                  <td className={cx('w-32', r.level === 'error' ? 'text-red-700' : r.level === 'warning' ? 'text-amber-700' : '')}>{LEVEL[r.level]}</td>
                  <td>{r.user ?? ''}</td>
                  <td>{r.company ?? ''}</td>
                  <td className="w-full">
                    {r.message}
                    {open === i && r.details && <pre className="mt-1 text-[11px] whitespace-pre-wrap text-slate-500">{r.details}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
