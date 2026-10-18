import { useState, type ReactNode } from 'react';
import { Button, Dialog, Field, TextInput, cx } from '../../components/ui.tsx';

/** Tab strip in the style of the Partners edit pane. */
export function TabStrip<T extends string>({ tabs, value, onChange, className }: { tabs: [T, string, boolean?][]; value: T; onChange: (t: T) => void; className?: string }) {
  return (
    <div className={cx('flex gap-px border-b border-slate-300 bg-slate-200 px-2 pt-1 text-[12.5px]', className)}>
      {tabs.map(([id, label, disabled]) => (
        <button
          key={id}
          disabled={disabled}
          title={disabled ? 'Предстои' : undefined}
          onClick={() => onChange(id)}
          className={cx('rounded-t-sm px-2.5 py-1', value === id ? 'bg-slate-50 font-medium' : disabled ? 'cursor-not-allowed text-slate-400' : 'text-slate-600 hover:bg-slate-100')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Small modal with one text field (Delta's "Нова група" style prompts). */
export function PromptDialog({ title, label, initial = '', onOk, onClose, extra, okLabel = 'OK' }: { title: string; label: string; initial?: string; onOk: (v: string) => void | Promise<void>; onClose: () => void; extra?: ReactNode; okLabel?: string }) {
  const [v, setV] = useState(initial);
  const ok = () => v.trim() && void onOk(v.trim());
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button variant="primary" onClick={ok} disabled={!v.trim()}>
            {okLabel}
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Field label={label}>
          <TextInput value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} />
        </Field>
        {extra}
      </div>
    </Dialog>
  );
}

/** Read-only label/value row used on info screens. */
export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <tr>
      <td className="w-56 bg-slate-50 text-slate-600">{label}</td>
      <td className="whitespace-normal">{children || <span className="text-slate-400">—</span>}</td>
    </tr>
  );
}

/** Edit-pane form wrapper: header with title, scrollable body, footer with buttons. */
export function EditPane({ title, children, footer, width = 400 }: { title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <aside className="flex shrink-0 flex-col bg-slate-50" style={{ width }}>
      <div className="border-b border-slate-300 bg-slate-200 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-slate-600 uppercase">{title}</div>
      <div className="flex-1 overflow-auto p-3">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-slate-300 bg-slate-100 px-3 py-2">{footer}</div>}
    </aside>
  );
}

/** "1,5" -> "1.5" for decimal fields sent to the API. */
export const normDecimal = (s: string) => s.trim().replace(/\s/g, '').replace(',', '.');
export const isDecimal = (s: string) => /^\d+(\.\d+)?$/.test(normDecimal(s));
export const nn = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
