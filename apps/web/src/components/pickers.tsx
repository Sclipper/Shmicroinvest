import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api.ts';
import { useAccounts } from '../session.tsx';
import type { Account, PartnerRow } from '../types.ts';
import { cx } from './ui.tsx';

interface ComboProps<T> {
  value: T | null;
  items: T[];
  display: (v: T) => string;
  render: (v: T) => React.ReactNode;
  filter: (v: T, q: string) => boolean;
  isSelectable?: (v: T) => boolean;
  onChange: (v: T | null) => void;
  onQuery?: (q: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  listWidth?: number;
  ariaLabel?: string;
}

/** Type-ahead combo with F4 / Alt+Down to open the list (Delta pickers are F4). */
export function Combo<T>({ value, items, display, render, filter, isSelectable = () => true, onChange, onQuery, placeholder, className, disabled, autoFocus, invalid, listWidth, ariaLabel }: ComboProps<T>) {
  const [text, setText] = useState(value ? display(value) : '');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) setText(value ? display(value) : '');
  }, [value, open, display]);
  const matches = useMemo(() => (open ? items.filter((i) => filter(i, text.trim())).slice(0, 200) : []), [items, text, open, filter]);
  useEffect(() => {
    const first = matches.findIndex(isSelectable);
    setHi(first < 0 ? 0 : first);
  }, [matches, isSelectable]);
  useEffect(() => {
    listRef.current?.querySelector('[data-hi="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);
  const choose = (i: T | undefined) => {
    if (i && !isSelectable(i)) return;
    onChange(i ?? null);
    setOpen(false);
    setText(i ? display(i) : '');
  };
  const move = (d: number) => {
    let n = hi;
    for (let k = 0; k < matches.length; k++) {
      n = (n + d + matches.length) % matches.length;
      if (isSelectable(matches[n]!)) break;
    }
    setHi(n);
  };
  return (
    <div className={cx('relative', className)}>
      <input
        ref={inputRef}
        className={cx('field-input', invalid && 'border-red-400 bg-red-50')}
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          onQuery?.(e.target.value);
          if (!e.target.value) onChange(null);
        }}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          setTimeout(() => {
            if (!open) return;
            // Leaving with typed text: accept an exact match, else revert.
            const exact = items.find((i) => display(i).toLowerCase() === text.trim().toLowerCase() || display(i).split(' ')[0] === text.trim());
            if (exact && isSelectable(exact)) choose(exact);
            else {
              setOpen(false);
              setText(value ? display(value) : '');
            }
          }, 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'F4' || (e.altKey && e.key === 'ArrowDown')) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(!open);
          } else if (open && e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          } else if (open && e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          } else if (open && e.key === 'Enter') {
            e.preventDefault();
            choose(matches[hi]);
          } else if (open && e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
            setText(value ? display(value) : '');
          }
        }}
      />
      {open && (
        <div ref={listRef} style={{ width: listWidth }} className="absolute top-full left-0 z-50 mt-0.5 max-h-72 min-w-full overflow-auto border border-slate-300 bg-white shadow-lg">
          {matches.length === 0 && <div className="px-2 py-1.5 text-slate-500">Няма съвпадения</div>}
          {matches.map((m, i) => (
            <div
              key={i}
              data-hi={i === hi}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m);
              }}
              onMouseEnter={() => isSelectable(m) && setHi(i)}
              className={cx('cursor-default px-2 py-[3px] whitespace-nowrap', !isSelectable(m) && 'text-slate-400', i === hi && isSelectable(m) && 'bg-brand-500 text-white')}
            >
              {render(m)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const accDisplay = (a: Account) => `${a.number} ${a.description}`;
const accFilter = (a: Account, q: string) => !q || a.number.startsWith(q) || a.description.toLowerCase().includes(q.toLowerCase()) || `${a.number} ${a.description}`.toLowerCase().startsWith(q.toLowerCase());

/** Account picker; by default only leaf (postable) accounts can be chosen. */
export function AccountPicker({ value, onChange, leafOnly = true, autoFocus, invalid, className, filter, disabled, ariaLabel }: { value: number | null; onChange: (a: Account | null) => void; leafOnly?: boolean; autoFocus?: boolean; invalid?: boolean; className?: string; filter?: (a: Account) => boolean; disabled?: boolean; ariaLabel?: string }) {
  const { data = [] } = useAccounts();
  const items = useMemo(() => data.filter((a) => a.number !== '0' && !a.isHidden && (!filter || filter(a))), [data, filter]);
  const selected = data.find((a) => a.id === value) ?? null;
  const selectable = useMemo(() => (leafOnly ? (a: Account) => a.isLeaf : () => true), [leafOnly]);
  return (
    <Combo
      value={selected}
      items={items}
      display={accDisplay}
      filter={accFilter}
      isSelectable={selectable}
      onChange={onChange}
      autoFocus={autoFocus}
      invalid={invalid}
      className={className}
      disabled={disabled}
      ariaLabel={ariaLabel}
      listWidth={420}
      placeholder="Сметка (F4)"
      render={(a) => (
        <span style={{ paddingLeft: Math.max(0, a.level - 2) * 12 }}>
          <span className="inline-block min-w-16 font-medium">{a.number}</span> {a.description}
          {a.isForeignCurrency && <span className="ml-1 text-[11px] opacity-70">[вал.]</span>}
          {a.isMaterial && <span className="ml-1 text-[11px] opacity-70">[мат.]</span>}
        </span>
      )}
    />
  );
}

/** Partner picker (search by name, EIK, VAT number). Optional accountId narrows to partners linked to that account. */
export function PartnerPicker({ value, valueName, onChange, autoFocus, invalid, className }: { value: number | null; valueName?: string | null; onChange: (p: PartnerRow | null) => void; autoFocus?: boolean; invalid?: boolean; className?: string }) {
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({ queryKey: ['partners', 'picker', q], queryFn: () => api.get<PartnerRow[]>(`/partners${qs({ q, limit: 100 })}`), staleTime: 30_000 });
  const selected = useMemo<PartnerRow | null>(() => data.find((p) => p.id === value) ?? (value ? ({ id: value, name: valueName ?? `#${value}` } as PartnerRow) : null), [data, value, valueName]);
  return (
    <Combo
      value={selected}
      items={data}
      display={(p) => p.name}
      filter={() => true}
      onChange={onChange}
      onQuery={setQ}
      autoFocus={autoFocus}
      invalid={invalid}
      className={className}
      listWidth={420}
      placeholder="Партньор (F4)"
      render={(p) => (
        <span>
          {p.name} {p.bulstat && <span className="text-[11px] opacity-70">ЕИК {p.bulstat}</span>}
        </span>
      )}
    />
  );
}

export interface PickedPartner {
  id: number;
  name: string;
}

/** Several partners (the reports' "Партньор" multi-select, CompanyIDs as a comma list): picked names as removable chips. */
export function PartnerMultiPicker({ value, onChange, className }: { value: PickedPartner[]; onChange: (v: PickedPartner[]) => void; className?: string }) {
  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-1', className)} data-testid="partner-multi">
      {value.map((p) => (
        <span key={p.id} className="inline-flex h-6 items-center gap-1 rounded-sm border border-slate-300 bg-slate-100 px-1.5 text-[12px]">
          <span className="max-w-40 truncate" title={p.name}>{p.name}</span>
          <button type="button" className="text-slate-500 hover:text-red-700" aria-label={`Премахване на ${p.name}`} onClick={() => onChange(value.filter((x) => x.id !== p.id))}>
            ✕
          </button>
        </span>
      ))}
      <PartnerPicker value={null} onChange={(p) => p && !value.some((x) => x.id === p.id) && onChange([...value, { id: p.id, name: p.name }])} className="w-48" />
    </div>
  );
}
