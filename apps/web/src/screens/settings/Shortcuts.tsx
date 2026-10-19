import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Printer, RotateCcw, Save } from 'lucide-react';
import { SHORTCUT_TYPE_LABELS, duplicateShortcutWarnings, isAllowedEditableGesture, shortcutsByType, JOURNAL_EXTRA_MESSAGES as XM } from '@shmi/core';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, CommandBar, Empty, Spinner, cx } from '../../components/ui.tsx';
import { MENU, gestureOf, type MenuItem } from '../../shell/menu.ts';
import { PrintPortal, usePrinting } from '../../reports/common.tsx';
import { useCan } from '../../session.tsx';
import { useShortcutRows, type ShortcutRow } from '../entry/shortcuts.ts';

const TYPE_LABEL: Record<string, string> = SHORTCUT_TYPE_LABELS;

/** MainMenu rows of the printout: the gestures of the menu items the user can reach (06 2.6). */
function useMenuShortcutRows() {
  const can = useCan();
  const out: { id: string; label: string; type: 'MainMenu'; gesture: string }[] = [];
  const walk = (items: MenuItem[], path: string) => {
    for (const i of items) {
      if ('sep' in i || !can(i.permission)) continue;
      if (i.gesture) out.push({ id: `menu:${path}${i.label}`, label: `${path}${i.label}`, type: 'MainMenu', gesture: i.gesture });
      if (i.children) walk(i.children, `${path}${i.label} › `);
    }
  };
  for (const m of MENU) if (can(m.permission)) walk(m.items, `${m.label} › `);
  return out;
}

/** Клавишни комбинации (Други, Ctrl+K; spec 06 2.6): per-user window shortcuts. */
export function Shortcuts() {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useShortcutRows();
  const menuRows = useMenuShortcutRows();
  const [printing, print] = usePrinting();
  const [rows, setRows] = useState<ShortcutRow[]>([]);
  const [capture, setCapture] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setRows(q.data.rows);
  }, [q.data]);
  if (!q.data) return <Empty><Spinner /></Empty>;

  const changed = rows.some((r, i) => r.gesture !== q.data!.rows[i]?.gesture);
  const warnings = duplicateShortcutWarnings(rows);
  const save = async () => {
    try {
      const overrides = Object.fromEntries(rows.filter((r) => r.gesture !== r.default).map((r) => [r.id, r.gesture]));
      await api.put('/settings/shortcuts', { overrides });
      await qc.invalidateQueries({ queryKey: ['shortcuts'] });
    } catch (e) {
      await dialogs.error(e, 'Клавишни комбинации');
    }
  };
  const restore = async () => {
    if (!(await dialogs.confirm(XM.strRestoreDefaultShortcutsQuestion))) return;
    await api.del('/settings/shortcuts');
    await qc.invalidateQueries({ queryKey: ['shortcuts'] });
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar right={warnings.length ? <span className="text-[12px] text-amber-700">{warnings.length} повторени комбинации</span> : undefined}>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!changed} onClick={save}>
          Запис
        </Button>
        <Button disabled={!changed} onClick={() => setRows(q.data!.rows)}>
          Отказ
        </Button>
        <Button icon={<RotateCcw className="size-3.5" />} onClick={restore}>
          По подразбиране
        </Button>
        <Button icon={<Printer className="size-3.5" />} onClick={print}>
          Печат
        </Button>
      </CommandBar>
      {printing && (
        <PrintPortal title="Клавишни комбинации" signatures={false}>
          {shortcutsByType([...rows.filter((r) => r.gesture), ...menuRows]).map((g) => (
            <section key={g.type} className="mb-3" data-testid="shortcuts-print-group">
              <h2 className="mb-1 text-[13px] font-bold">{g.label}</h2>
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Команда</th>
                    <th className="w-48">Клавиши</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.label}</td>
                      <td className="font-mono">{r.gesture}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </PrintPortal>
      )}
      {warnings.length > 0 && (
        <ul className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-[12px] text-amber-900">
          {warnings.map((w, i) => (
            <li key={i}>{w.text}</li>
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Команда</th>
              <th>Вид</th>
              <th className="w-48">Клавишна комбинация</th>
              <th className="w-40">По подразбиране</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td className="text-slate-600">{TYPE_LABEL[r.type] ?? r.type}</td>
                <td className="p-0.5">
                  <input
                    className={cx('field-input font-mono', capture === r.id && 'border-brand-500 bg-brand-50', r.gesture !== r.default && 'font-semibold')}
                    value={capture === r.id ? 'Натиснете клавиши…' : r.gesture}
                    readOnly
                    aria-label={`Клавиш за ${r.label}`}
                    onFocus={() => setCapture(r.id)}
                    onBlur={() => setCapture(null)}
                    onKeyDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (['Control', 'Alt', 'Shift', 'Meta', 'Tab'].includes(e.key)) return;
                      if (e.key === 'Escape') return (e.target as HTMLInputElement).blur();
                      const g = e.key === 'Backspace' || e.key === 'Delete' ? '' : gestureOf(e.nativeEvent);
                      if (g && r.type === 'WindowEditable' && !isAllowedEditableGesture(g)) return;
                      setRows(rows.map((x) => (x.id === r.id ? { ...x, gesture: g } : x)));
                      (e.target as HTMLInputElement).blur();
                    }}
                  />
                </td>
                <td className="font-mono text-slate-500">{r.default}</td>
                <td className="p-0.5">
                  {r.gesture !== r.default && (
                    <Button variant="ghost" className="h-6 px-2" onClick={() => setRows(rows.map((x) => (x.id === r.id ? { ...x, gesture: x.default } : x)))}>
                      Възстанови
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-3 py-2 text-[12px] text-slate-500">Щракнете в колоната и натиснете новата комбинация; Backspace премахва комбинацията. Комбинациите от главното меню са фиксирани.</p>
      </div>
    </div>
  );
}
