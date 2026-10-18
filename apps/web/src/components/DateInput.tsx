import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { CalendarDays } from 'lucide-react';
import { isoToBg, parseBgDate } from '@shmi/core';
import { cx } from './cx.ts';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value?: string | number | readonly string[];
  onChange?: (e: { target: { value: string } }) => void;
};

/** Date field in Bulgarian format (dd.mm.yyyy) with a picker; value and onChange use ISO yyyy-mm-dd. */
export const DateInput = forwardRef<HTMLInputElement, Props>(function DateInput({ value, onChange, className, disabled, readOnly, onBlur, onKeyDown, ...rest }, ref) {
  const iso = typeof value === 'string' ? value : '';
  const [text, setText] = useState(isoToBg(iso));
  const [focused, setFocused] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focused) setText(isoToBg(iso));
  }, [iso, focused]);
  const invalid = !!text.trim() && !parseBgDate(text);
  const commit = (t: string) => {
    const p = parseBgDate(t);
    if (p) {
      setText(isoToBg(p));
      if (p !== iso) onChange?.({ target: { value: p } });
    } else if (!t.trim() && iso) onChange?.({ target: { value: '' } });
  };
  return (
    <div className={cx('relative', className?.includes('w-') ? undefined : 'w-full')}>
      <input
        ref={ref}
        {...rest}
        type="text"
        inputMode="numeric"
        placeholder={rest.placeholder ?? 'дд.мм.гггг'}
        disabled={disabled}
        readOnly={readOnly}
        value={text}
        className={cx('field-input pr-7', invalid && 'border-red-400 bg-red-50', className)}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const p = parseBgDate(e.target.value);
          // Propagate complete dates while typing so dependent fields update.
          if (p && /^\d{1,2}[./]\d{1,2}[./]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(e.target.value.trim()) && p !== iso) onChange?.({ target: { value: p } });
        }}
        onBlur={(e) => {
          setFocused(false);
          commit(text);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(text);
          if (e.key === 'F4' || (e.altKey && e.key === 'ArrowDown')) {
            e.preventDefault();
            pickerRef.current?.showPicker?.();
          }
          onKeyDown?.(e);
        }}
      />
      <button type="button" tabIndex={-1} disabled={disabled || readOnly} aria-label="Календар" className="absolute top-1/2 right-1.5 -translate-y-1/2 text-slate-400 hover:text-brand-600 disabled:opacity-40" onClick={() => pickerRef.current?.showPicker?.()}>
        <CalendarDays className="size-3.5" />
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 h-0 w-0 opacity-0"
        value={iso}
        onChange={(e) => e.target.value && onChange?.({ target: { value: e.target.value } })}
      />
    </div>
  );
});
