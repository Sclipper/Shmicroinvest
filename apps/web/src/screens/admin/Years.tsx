import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarPlus, Lock, LockOpen, Save, Trash2 } from 'lucide-react';
import { isMonthLocked } from '@shmi/core';
import { api } from '../../api.ts';
import { bgDate } from '../../format.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, Empty, Field, Panel, Select, Spinner, cx } from '../../components/ui.tsx';
import { useCan, useInvalidate, useSession } from '../../session.tsx';
import { TabStrip } from './common.tsx';

interface FinancialYear { id: number; year: number; startDate: string; isConcluded: boolean; isLocked: boolean; lockedMonths: number }
/** A row of the "Избор" list: an existing year or a virtual (not yet created) one before/after. */
interface YearRow { year: number; fy: FinancialYear | null }

const MONTHS = ['Ян', 'Фев', 'Мар', 'Апр', 'Май', 'Юни', 'Юли', 'Авг', 'Сеп', 'Окт', 'Ное', 'Дек'];
const displayYear = (r: YearRow) => `${r.year}${!r.fy ? ' *' : r.fy.isLocked ? ' **' : ''}`;

type TabId = 'select' | 'conclude' | 'lock' | 'delete';

/** Счетоводна година (Ctrl+Y; spec 01b 6.3). */
export function Years() {
  const s = useSession();
  const can = useCan();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const editable = can('UI_Edit_ChangeActiveFinancialYear');
  const [tab, setTab] = useState<TabId>('select');
  const years = useQuery({ queryKey: ['years'], queryFn: () => api.get<FinancialYear[]>('/years') });
  const list = years.data ?? [];

  const rows = useMemo<YearRow[]>(() => {
    if (!list.length) return [];
    const first = list[0]!.year;
    const last = list[list.length - 1]!.year;
    return [{ year: first - 1, fy: null }, ...list.map((fy) => ({ year: fy.year, fy })), { year: last + 1, fy: null }];
  }, [list]);

  const [selYear, setSelYear] = useState<number>(s.year.year);
  const sel = rows.find((r) => r.year === selYear) ?? null;

  // ---- Избор ----
  const activate = async (r: YearRow) => {
    try {
      if (!r.fy) {
        const isPrev = r.year < list[0]!.year;
        const text = isPrev
          ? `Ще бъде създадена предходна счетоводна година ${r.year}.\nНачалните салда на следващата година трябва да се начисляват към 01.01. Желаете ли да продължите?`
          : `Ще бъде създадена следващата счетоводна година ${r.year}.${!list[list.length - 1]!.isConcluded ? `\nСчетоводна година ${r.year - 1} не е приключена – крайните ѝ салда няма да бъдат прехвърлени като начални.` : ''}\nЖелаете ли да продължите?`;
        if (!(await dialogs.confirm(text, 'Създаване на счетоводна година'))) return;
        await api.post('/years', { year: r.year });
      } else if (r.fy.isLocked) {
        await dialogs.alert('Избраната счетоводна година е заключена и не може да бъде избрана!\nЗа да бъде избрана счетоводната година е необходимо да бъде отключена за редакция.');
        return;
      }
      await api.put('/years/active', { year: r.year });
      await qc.invalidateQueries();
    } catch (e) {
      await dialogs.error(e);
      await invalidate('years');
    }
  };

  // ---- Заключване ----
  const [lockId, setLockId] = useState<number | null>(null);
  const lockFy = list.find((y) => y.id === lockId) ?? list.find((y) => y.id === s.year.id) ?? list[0] ?? null;
  const [months, setMonths] = useState<number>(0);
  useEffect(() => setMonths(lockFy?.lockedMonths ?? 0), [lockFy?.id, lockFy?.lockedMonths]);
  const monthsDirty = !!lockFy && months !== lockFy.lockedMonths;

  const saveMonths = async () => {
    if (!lockFy) return;
    try {
      await api.put(`/years/${lockFy.id}/locks`, { months: MONTHS.map((_, i) => i + 1).filter((m) => isMonthLocked(months, m)) });
      await invalidate('years', 'session');
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const toggleYearLock = async () => {
    if (!lockFy) return;
    const lock = !lockFy.isLocked;
    if (lock && lockFy.id === s.year.id) {
      if (!(await dialogs.confirm(`Счетоводна година ${lockFy.year} е активната година. След заключването ѝ няма да могат да се въвеждат и редактират операции в нея. Желаете ли да продължите?`))) return;
    } else if (!(await dialogs.confirm(`Желаете ли да ${lock ? 'заключите' : 'отключите'} за редакция '${lockFy.year}' счетоводна година?`))) return;
    try {
      await api.put(`/years/${lockFy.id}/locks`, { lockYear: lock });
      await invalidate('years', 'session');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  // ---- Изтриване ----
  const [delId, setDelId] = useState<number | null>(null);
  const delFy = list.find((y) => y.id === delId) ?? list[0] ?? null;
  const delBlock = !delFy
    ? null
    : delFy.isLocked
      ? 'Счетоводната година не може да бъде изтрита, защото е заключена за редакция.'
      : delFy.id === s.year.id
        ? 'Текущата счетоводна година не може да бъде изтрита.'
        : list[0]!.id !== delFy.id
          ? 'Счетоводната година не може да бъде изтрита, защото има активни години преди нея.'
          : null;
  const remove = async () => {
    if (!delFy) return;
    if (!(await dialogs.confirm(`Внимание! Желателно е да направите архив преди изтриване на счетоводна година ${delFy.year}.\nЩе бъдат изтрити всички осчетоводени в нея операции, без възможност за промяна! Желаете ли продължение?`, 'Изтриване на счетоводна година'))) return;
    try {
      const r = await api.del<{ message: string }>(`/years/${delFy.id}`);
      setDelId(null);
      await invalidate('years', 'session');
      await dialogs.alert(r.message);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  if (years.isLoading) return <Empty><Spinner /></Empty>;

  const status = (fy: FinancialYear | null) =>
    !fy ? <span className="text-slate-500">Нова (не е създадена)</span> : (
      <span className="flex gap-2">
        {fy.id === s.year.id && <span className="font-semibold text-brand-600">Активна</span>}
        {fy.isLocked ? <span className="text-red-700">Заключена</span> : fy.lockedMonths ? <span className="text-amber-700">Заключени месеци: {MONTHS.filter((_, i) => isMonthLocked(fy.lockedMonths, i + 1)).join(', ')}</span> : null}
        {fy.isConcluded && <span className="text-slate-600">Приключена</span>}
      </span>
    );

  return (
    <div className="flex h-full flex-col">
      <TabStrip<TabId> tabs={[['select', 'Избор'], ['conclude', 'Приключване', true], ['lock', 'Заключване'], ['delete', 'Изтриване']]} value={tab} onChange={setTab} />
      <div className="flex min-h-0 flex-1 gap-3 overflow-auto p-3">
        {tab === 'select' && (
          <>
            <Panel title="Счетоводни години" className="w-[560px] self-start">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Година</th>
                    <th>Начална дата</th>
                    <th>Състояние</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.year} aria-selected={r.year === selYear} onClick={() => setSelYear(r.year)} onDoubleClick={() => editable && activate(r)} className={cx('cursor-default', !r.fy && 'text-slate-500 italic')}>
                      <td className={cx(r.fy?.id === s.year.id && 'font-semibold')}>{displayYear(r)}</td>
                      <td>{r.fy ? bgDate(r.fy.startDate) : `01.01.${r.year}`}</td>
                      <td>{status(r.fy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-slate-200 px-3 py-1.5 text-[11.5px] text-slate-500">* нова година, която ще бъде създадена при избор · ** заключена година</div>
            </Panel>
            <Panel title="Избор на година" className="w-80 self-start">
              <div className="flex flex-col gap-3 p-3">
                <div>
                  Активна година: <span className="font-semibold">{s.year.year}</span>
                </div>
                {sel && (
                  <>
                    <div>
                      Избрана: <span className="font-semibold">{displayYear(sel)}</span>
                    </div>
                    {sel.fy?.isLocked && <div className="text-[12px] text-amber-700">За да бъде избрана счетоводната година е необходимо да бъде отключена за редакция.</div>}
                    <Button
                      variant="primary"
                      icon={sel.fy ? <CalendarCheck className="size-3.5" /> : <CalendarPlus className="size-3.5" />}
                      disabled={!editable || sel.fy?.id === s.year.id || !!sel.fy?.isLocked}
                      onClick={() => activate(sel)}
                    >
                      {sel.fy ? `Избор на ${sel.year} г.` : `Създаване на ${sel.year} г.`}
                    </Button>
                  </>
                )}
              </div>
            </Panel>
          </>
        )}

        {tab === 'lock' && lockFy && (
          <Panel title="Заключване за редакция" className="w-[560px] self-start">
            <div className="flex flex-col gap-3 p-3">
              <div className="flex items-end gap-2">
                <Field label="Счетоводна година" className="w-48">
                  <Select value={lockFy.id} onChange={(e) => setLockId(Number(e.target.value))}>
                    {list.map((y) => (
                      <option key={y.id} value={y.id}>
                        {displayYear({ year: y.year, fy: y })}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button icon={lockFy.isLocked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />} disabled={!editable || monthsDirty} onClick={toggleYearLock}>
                  {lockFy.isLocked ? 'Отключване на годината' : 'Заключване на годината'}
                </Button>
              </div>
              <div>
                <div className="mb-1 text-[12px] text-slate-600">Заключени месеци</div>
                <div className="grid grid-cols-6 gap-x-3 gap-y-2 rounded-sm border border-slate-300 bg-slate-50 p-3">
                  {MONTHS.map((label, i) => {
                    const m = i + 1;
                    return (
                      <Checkbox
                        key={m}
                        label={label}
                        checked={lockFy.isLocked || isMonthLocked(months, m)}
                        disabled={!editable || lockFy.isLocked}
                        onChange={(v) => setMonths((x) => (v ? x | (1 << m) : x & ~(1 << m)))}
                      />
                    );
                  })}
                </div>
                <div className="mt-1 text-[11.5px] text-slate-500">В заключен месец не могат да се въвеждат, редактират и изтриват операции.</div>
              </div>
              <div className="flex justify-end gap-2">
                <Button disabled={!monthsDirty} onClick={() => setMonths(lockFy.lockedMonths)}>
                  Отказ
                </Button>
                <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!editable || !monthsDirty} onClick={saveMonths}>
                  Запис
                </Button>
              </div>
            </div>
          </Panel>
        )}

        {tab === 'delete' && delFy && (
          <Panel title="Изтриване на счетоводна година" className="w-[560px] self-start">
            <div className="flex flex-col gap-3 p-3">
              <Field label="Счетоводна година" className="w-48">
                <Select value={delFy.id} onChange={(e) => setDelId(Number(e.target.value))}>
                  {list.map((y) => (
                    <option key={y.id} value={y.id}>
                      {displayYear({ year: y.year, fy: y })}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
                При изтриване на счетоводна година се изтриват всички осчетоводени в нея операции и начални салда. Може да се изтрие само най-ранната година, която не е активна и не е заключена.
              </div>
              {delBlock && <div className="text-[12.5px] text-red-700">{delBlock}</div>}
              <div className="flex justify-end">
                <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!editable || !!delBlock} onClick={remove}>
                  Изтриване на {delFy.year} г.
                </Button>
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
