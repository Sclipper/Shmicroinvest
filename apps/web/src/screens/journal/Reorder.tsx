import { useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Field, Panel, Select } from '../../components/ui.tsx';
import { useInvalidate, useSession } from '../../session.tsx';

const TYPES = [
  { id: 'accounting', label: 'Контиране' },
  { id: 'pko', label: 'ПКО' },
  { id: 'rko', label: 'РКО' },
  { id: 'mo', label: 'Мемориален ордер' },
] as const;

/** Преподреждане на документи (Редакция > Администриране, spec 02a 3). */
export function Reorder() {
  const s = useSession();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const [type, setType] = useState<(typeof TYPES)[number]['id']>('accounting');
  const [by, setBy] = useState<'number' | 'date'>('number');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const label = TYPES.find((t) => t.id === type)!.label;
    if (!(await dialogs.confirm(`Ще бъдат преномерирани всички документи „${label}“ за ${s.year.year} г. ${by === 'number' ? 'по номер' : 'по дата'}. Желаете ли продължение?`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ count: number; message: string }>('/journal/reorder', { type, by });
      await invalidate('entries', 'reports');
      await dialogs.alert(r.message, 'Преподреждане на документи');
    } catch (e) {
      await dialogs.error(e, 'Преподреждане на документи');
    } finally {
      setBusy(false);
    }
  };

  const locked = s.year.isLocked || s.year.lockedMonths !== 0;
  return (
    <div className="h-full overflow-auto bg-slate-50 p-4">
      <Panel title="Преподреждане на документи" className="max-w-lg">
        <div className="flex flex-col gap-3 p-3">
          <Field label="Преподреждане на">
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Преподреждане на">
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="flex gap-4">
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="reorder-by" checked={by === 'number'} onChange={() => setBy('number')} /> По номер
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="reorder-by" checked={by === 'date'} onChange={() => setBy('date')} /> По дата
            </label>
          </fieldset>
          <p className="text-[12px] text-slate-600">
            Документите от активната година се номерират от 1 в избрания ред. Документи с еднакъв номер запазват общ номер. Номерацията продължава от последния нов номер.
          </p>
          {locked && <p className="text-[12px] text-red-700">Годината има заключени месеци — преподреждането не е възможно.</p>}
          <div>
            <Button variant="primary" icon={<ListOrdered className="size-3.5" />} onClick={run} disabled={busy}>
              Преподреди
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
