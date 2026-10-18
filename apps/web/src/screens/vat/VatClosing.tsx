import { useState } from 'react';
import { Calculator, Save, X } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, TextInput, cx } from '../../components/ui.tsx';
import { money } from '../../format.ts';
import { PeriodFields } from '../../reports/common.tsx';
import { useInvalidate, useSession } from '../../session.tsx';
import { useWorkspace, type ScreenProps } from '../../shell/workspace.tsx';
import { prevMonth } from './common.tsx';

/** Приключване на ДДС (Alt+F, UI_Operations_AutoOperations_VAT; spec 02b 9, 20). */

interface AccRef { role: string; id: number; number: string; label: string }
interface Calc {
  purchases: string;
  sales: string;
  refund: string;
  rows: { credit: AccRef; debit: AccRef; amount: string }[];
  messages: { key: string; text: string; severity: 'critical' | 'warning' }[];
  accounts: Record<string, AccRef>;
  balances: (AccRef & { openingDebit: string; openingCredit: string; debitTurnover: string; creditTurnover: string; closingDebit: string; closingCredit: string })[];
}

export function VatClosing({ tab }: ScreenProps) {
  const session = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const ws = useWorkspace();
  const [f, setF] = useState({ ...prevMonth(session.workingDate), byExportMonth: true, includeRefund: false, alternative: false });
  const [calc, setCalc] = useState<Calc | null>(null);
  const [rows, setRows] = useState<{ credit: AccRef; debit: AccRef; amount: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const calculate = async (o = f) => {
    setBusy(true);
    try {
      const r = await api.post<Calc>('/vat/closing/calculate', o);
      setCalc(r);
      setRows(r.rows.map((x) => ({ ...x, amount: x.amount.replace('.', ',') })));
    } catch (e) {
      await dialogs.error(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!rows.length) return;
    setBusy(true);
    try {
      const r = await api.post<{ created: { id: number; number: string }[] }>('/vat/closing', {
        to: f.to, rows: rows.map((x) => ({ creditAccountId: x.credit.id, debitAccountId: x.debit.id, amount: x.amount.replace(',', '.') || '0' })),
      });
      await invalidate('entries', 'reports', 'accounts');
      await dialogs.alert(`Създадени са ${r.created.length} контирания: ${r.created.map((c) => c.number).join(', ')}.`, 'Приключване на ДДС');
      ws.update(tab.key, { dirty: false });
      await calculate();
    } catch (e) {
      await dialogs.error(e, 'Операцията не може да бъде записана');
    } finally {
      setBusy(false);
    }
  };

  const set = (p: Partial<typeof f>) => {
    const n = { ...f, ...p };
    setF(n);
    if (calc && ('includeRefund' in p || 'alternative' in p)) void calculate(n);
  };
  const critical = calc?.messages.some((m) => m.severity === 'critical');

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Calculator className="size-3.5" />} onClick={() => calculate()} disabled={busy}>
          Изчисли
        </Button>
        <Button icon={<Save className="size-3.5" />} onClick={save} disabled={busy || !rows.length || critical}>
          Запис
        </Button>
        <Button icon={<X className="size-3.5" />} onClick={() => ws.close(tab.key)}>
          Отказ
        </Button>
      </CommandBar>
      <form className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2" onSubmit={(e) => { e.preventDefault(); void calculate(); }}>
        <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
        <Checkbox className="mb-1" label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />
        <button type="submit" hidden />
      </form>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
        {!calc ? (
          <Empty>Изберете период и натиснете „Изчисли“.</Empty>
        ) : (
          <div className="flex max-w-4xl flex-col gap-3">
            {calc.messages.map((m) => (
              <div key={m.key} className={cx('rounded-sm border px-3 py-1.5 text-[12px]', m.severity === 'critical' ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900')}>
                {m.text}
              </div>
            ))}
            {!critical && (
              <table className="grid-table bg-white">
                <thead>
                  <tr>
                    <th rowSpan={2}>Номер</th>
                    <th rowSpan={2}>Име</th>
                    <th colSpan={2} className="text-center">Начални салда</th>
                    <th colSpan={2} className="text-center">Обороти</th>
                    <th colSpan={2} className="text-center">Крайни салда</th>
                  </tr>
                  <tr>
                    {['od', 'oc', 'td', 'tc', 'cd', 'cc'].map((k, i) => (
                      <th key={k} className="text-right">{i % 2 ? 'Кредит' : 'Дебит'}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calc.balances.map((b) => (
                    <tr key={b.role}>
                      <td>{b.number}</td>
                      <td>{b.label}</td>
                      {(['openingDebit', 'openingCredit', 'debitTurnover', 'creditTurnover', 'closingDebit', 'closingCredit'] as const).map((k) => (
                        <td key={k} className="num w-28">{Number(b[k]) ? money(b[k]) : ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flex items-center gap-4">
              <h3 className="font-semibold">Генерирани контировки</h3>
              <Checkbox label="Алтернативно приключване" checked={f.alternative} onChange={(alternative) => set({ alternative })} />
              {!f.alternative && <Checkbox label="С приспадане на ДДС за възстановяване" checked={f.includeRefund} onChange={(includeRefund) => set({ includeRefund })} />}
            </div>
            <table className="grid-table bg-white" data-testid="vat-closing-rows">
              <thead>
                <tr>
                  <th>Дебит</th>
                  <th>Кредит</th>
                  <th>Описание</th>
                  <th className="w-36 text-right">Ст-ст</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap">{r.debit.number} {r.debit.label}</td>
                    <td className="nowrap">{r.credit.number} {r.credit.label}</td>
                    <td>Приключване на ДДС</td>
                    <td className="p-0.5">
                      <TextInput className="num" value={r.amount} aria-label={`Сума ${i + 1}`} onChange={(e) => { setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x))); ws.update(tab.key, { dirty: true }); }} />
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={4} className="text-center text-slate-500">Няма суми за приключване.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
