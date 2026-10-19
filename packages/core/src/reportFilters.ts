/**
 * Saved report filters (GetPropertyStateValue / SavePropertyState, spec 05 1.2):
 * every report remembers the user's last filter and restores it when opened.
 *
 * The saved object is laid over the report's defaults: only keys the report
 * still has, with a value of the same type (a null default takes any value,
 * a string default also takes null). Dates of another financial year are not
 * restored, and the period is restored only as a pair, so the period stays on
 * the active year.
 */
export function mergeSavedFilter<F extends object>(defaults: F, saved: Record<string, unknown> | null | undefined, activeYear: number): F {
  if (!saved || typeof saved !== 'object') return defaults;
  const def = defaults as Record<string, unknown>;
  const out: Record<string, unknown> = { ...def };
  for (const [k, d] of Object.entries(def)) {
    if (!(k in saved)) continue;
    const v = saved[k];
    if ((k === 'from' || k === 'to') && !(typeof v === 'string' && v.startsWith(String(activeYear)))) continue;
    const ok = d === null || v === null
      ? d === null || typeof d === 'string'
      : typeof v === typeof d && Array.isArray(v) === Array.isArray(d);
    if (ok) out[k] = v;
  }
  if ('from' in def && 'to' in def && (out.from === def.from) !== (out.to === def.to)) {
    out.from = def.from;
    out.to = def.to;
  }
  return out as F;
}
