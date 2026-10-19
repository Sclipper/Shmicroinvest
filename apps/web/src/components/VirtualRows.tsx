import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Set by the print portals: inside them every row is rendered (the printout
 * and window.print need the whole table, not the visible window).
 */
export const AllRowsContext = createContext(false);

/** Renders its children with every VirtualRows / IncrementalList inside them fully expanded. */
export function AllRows({ children }: { children: ReactNode }) {
  return <AllRowsContext.Provider value>{children}</AllRowsContext.Provider>;
}

/** Below this many rows a table is rendered as is. */
export const VIRTUAL_MIN_ROWS = 300;
const OVERSCAN = 30;
const INITIAL = 80;
const ESTIMATE = 24;

/** Closest scrolling ancestor (overflow auto / scroll), or null for the window. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

const spacerCell = { padding: 0, border: 0 } as const;

/**
 * Windowed rows of a big grid table (thousands of <tr>): put it inside a
 * <tbody>; `row(i)` returns the <tr> of item i. Only the rows in the scroll
 * container's view (plus an overscan) are in the DOM, with spacer rows above
 * and below of the measured row height, so the scrollbar, the sticky header
 * and footer and the zebra striping (the window always starts at an even
 * index after two leading rows) behave as with the full table. Small tables
 * (< VIRTUAL_MIN_ROWS) and printouts (AllRows) render every row.
 * The rows must be single-line (the grid cells are nowrap / truncate).
 */
export function VirtualRows({ count, row, colSpan = 1 }: { count: number; row: (i: number) => ReactNode; colSpan?: number }) {
  const all = useContext(AllRowsContext);
  const virtual = !all && count >= VIRTUAL_MIN_ROWS;
  const topRef = useRef<HTMLTableRowElement>(null);
  const bottomRef = useRef<HTMLTableRowElement>(null);
  const [h, setH] = useState(ESTIMATE);
  const [range, setRange] = useState<[number, number]>([0, INITIAL]);
  const start = Math.min(range[0], Math.max(0, count - 1)) & ~1;
  const end = Math.min(count, Math.max(range[1], start + 1));

  // Follow the scroll container: the visible slice from its scroll offset and height.
  useLayoutEffect(() => {
    if (!virtual) return;
    const top = topRef.current;
    if (!top) return;
    const scroller = scrollParent(top);
    let frame = 0;
    const update = () => {
      frame = 0;
      const view = scroller ? scroller.clientHeight : window.innerHeight;
      const scrollTop = scroller ? scroller.scrollTop : window.scrollY;
      const offset = top.getBoundingClientRect().top - (scroller ? scroller.getBoundingClientRect().top : 0) + scrollTop;
      const first = Math.max(0, Math.floor((scrollTop - offset) / h) - OVERSCAN) & ~1;
      const last = Math.min(count, Math.ceil((scrollTop + view - offset) / h) + OVERSCAN);
      const next: [number, number] = [first, Math.max(last, Math.min(count, first + 1))];
      setRange((r) => (r[0] === next[0] && r[1] === next[1] ? r : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    if (scroller) ro.observe(scroller);
    return () => {
      target.removeEventListener('scroll', schedule);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtual, count, h]);

  // Row height: measured once per result from the rendered rows (a hidden tab measures 0 and
  // tries again on the next render; once only, so rows of slightly different heights cannot
  // make the window and the height chase each other).
  const measured = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!virtual || measured.current === count) return;
    const first = topRef.current?.nextElementSibling?.nextElementSibling;
    const bottom = bottomRef.current;
    if (!first || !bottom || end <= start) return;
    const avg = (bottom.getBoundingClientRect().top - first.getBoundingClientRect().top) / (end - start);
    if (avg <= 4) return;
    measured.current = count;
    if (Math.abs(avg - h) > 0.5) setH(avg);
  });

  if (!virtual) {
    const out: ReactNode[] = [];
    for (let i = 0; i < count; i++) out.push(<Fragment key={i}>{row(i)}</Fragment>);
    return <>{out}</>;
  }
  const out: ReactNode[] = [];
  for (let i = start; i < end; i++) out.push(<Fragment key={i}>{row(i)}</Fragment>);
  return (
    <>
      <tr ref={topRef} aria-hidden data-virtual-spacer="top" style={{ height: start * h, background: 'transparent' }}>
        <td colSpan={colSpan} style={spacerCell} />
      </tr>
      {/* Keeps the zebra striping (nth-child) of the rows as in the full table. */}
      <tr hidden aria-hidden />
      {out}
      <tr ref={bottomRef} aria-hidden data-virtual-spacer="bottom" style={{ height: (count - end) * h, background: 'transparent' }}>
        <td colSpan={colSpan} style={spacerCell} />
      </tr>
    </>
  );
}

/**
 * Progressive list of tall, variable-height blocks (letters, cards): the
 * first `step` items, and the next ones as the end of the list scrolls into
 * view. AllRows (print) renders every item.
 */
export function IncrementalList<T>({ items, render, step = 40 }: { items: T[]; render: (item: T, i: number) => ReactNode; step?: number }) {
  const all = useContext(AllRowsContext);
  const [shown, setShown] = useState(step);
  const sentinel = useRef<HTMLDivElement>(null);
  const n = all ? items.length : Math.min(items.length, shown);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || n >= items.length) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setShown((s) => s + step), { root: scrollParent(el), rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [n, items.length, step]);
  return (
    <>
      {items.slice(0, n).map((it, i) => render(it, i))}
      {n < items.length && (
        <div ref={sentinel} className="px-3 py-2 text-center text-[12px] text-slate-500">
          Показани {n} от {items.length}…
        </div>
      )}
    </>
  );
}
