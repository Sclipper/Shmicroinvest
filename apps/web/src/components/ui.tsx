import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost';
export function Button({ variant = 'default', className, icon, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-sm border px-3 text-[13px] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'border-brand-600 bg-brand-500 text-white hover:bg-brand-600',
        variant === 'danger' && 'border-red-300 bg-white text-red-700 hover:bg-red-50',
        variant === 'default' && 'border-slate-300 bg-gradient-to-b from-white to-slate-100 text-slate-800 hover:border-brand-500 hover:from-brand-50',
        variant === 'ghost' && 'border-transparent bg-transparent text-slate-700 hover:bg-slate-200',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx('field-input', className)} />;
});

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cx('field-input pr-6', className)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled, className }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; className?: string }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-1.5 select-none', disabled && 'opacity-50', className)}>
      <input type="checkbox" className="size-3.5 accent-brand-500" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Field({ label, children, className, hint }: { label: ReactNode; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <label className={cx('flex flex-col gap-0.5', className)}>
      <span className="text-[12px] text-slate-600">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Panel({ title, children, className, actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-sm border border-slate-300 bg-white', className)}>
      {title && (
        <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5">
          <h3 className="text-[12px] font-semibold tracking-wide text-slate-600 uppercase">{title}</h3>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Screen-level command bar (the button row at the top of every Delta window). */
export function CommandBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-300 bg-slate-50 px-3 py-1.5">
      {children}
      {right && <div className="ml-auto flex items-center gap-1.5">{right}</div>}
    </div>
  );
}

export function Dialog({ title, children, footer, onClose, width = 480 }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button[data-autofocus]');
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        style={{ width }}
        className="max-w-[95vw] overflow-hidden rounded-sm border border-slate-400 bg-white shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between bg-gradient-to-b from-brand-600 to-brand-700 px-3 py-1.5 text-white">
          <span className="font-semibold">{title}</span>
          <button className="rounded px-1.5 hover:bg-white/20" onClick={onClose} aria-label="Затвори">
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={cx('size-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600', className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center text-slate-500">{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-red-800">{error instanceof Error ? error.message : String(error)}</div>;
}
