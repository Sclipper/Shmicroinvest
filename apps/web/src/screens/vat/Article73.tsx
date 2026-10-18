import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calculator, Save, Send } from 'lucide-react';
import { api, qs } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, CommandBar, Field, Panel, Select, Spinner, TextInput } from '../../components/ui.tsx';
import { money } from '../../format.ts';
import { useInvalidate, useLookups } from '../../session.tsx';

/**
 * Коефициент по чл. 73 от ЗДДС (UI_Operations_AutoOperations_VATOperations_VATRatio,
 * spec 02b 8, 21) and the annual adjustment under art. 73(8).
 */

interface Stored { ratio: string | null; from: string; to: string; numeratorDeviation: string; denominatorDeviation: string }
interface Calc { numerator: string; denominator: string; exact: string; ratio: string; plain: string }
interface Adjustment { from: string; to: string; oldRatio: string; newRatio: string; base: string; amount: string; accountingDate: string; term: string }

const n = (v: string) => v.replace(',', '.').trim() || '0';

export function Article73() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const stored = useQuery({ queryKey: ['vat', 'article73'], queryFn: () => api.get<Stored>('/vat/article73'), staleTime: 0 });
  const [f, setF] = useState<{ from: string; to: string; numeratorDeviation: string; denominatorDeviation: string; ratio: string } | null>(null);
  const [calc, setCalc] = useState<Calc | null>(null);
  const [adj, setAdj] = useState<Adjustment | null>(null);
  const [doc, setDoc] = useState({ documentTypeId: 5 as number | null, documentNumber: '', accountingDate: '' });

  useEffect(() => {
    if (stored.data && !f) setF({ from: stored.data.from, to: stored.data.to, numeratorDeviation: stored.data.numeratorDeviation, denominatorDeviation: stored.data.denominatorDeviation, ratio: stored.data.ratio ?? '0.00' });
  }, [stored.data, f]);

  if (!f) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const body = { from: f.from, to: f.to, numeratorDeviation: n(f.numeratorDeviation), denominatorDeviation: n(f.denominatorDeviation) };

  const calculate = async () => {
    try {
      const r = await api.post<Calc>('/vat/article73/calculate', body);
      setCalc(r);
      setF({ ...f, ratio: r.ratio });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const save = async () => {
    try {
      const v = await api.post<{ messages: { key: string; text: string; severity: 'warning' }[] }>('/vat/article73/validate', { ...body, ratio: n(f.ratio) });
      if (v.messages.length && !(await dialogs.messages('Коефициент по чл. 73', v.messages, true))) return;
      await api.put('/vat/article73', { ...body, ratio: n(f.ratio) });
      await invalidate('vat');
      await dialogs.alert(`Коефициентът ${n(f.ratio)} е записан за периода.`, 'Коефициент по чл. 73');
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const loadAdjustment = async (newRatio?: string) => {
    try {
      const r = await api.get<Adjustment>(`/vat/article73/adjustment${qs({ newRatio: newRatio ? n(newRatio) : undefined })}`);
      setAdj(r);
      setDoc((d) => ({ ...d, accountingDate: d.accountingDate || r.accountingDate }));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const post = async () => {
    if (!adj) return;
    try {
      const r = await api.post<{ number: string }>('/vat/article73/adjustment', { amount: n(adj.amount), accountingDate: doc.accountingDate, documentTypeId: doc.documentTypeId, documentNumber: doc.documentNumber });
      await invalidate('entries', 'reports', 'accounts');
      await dialogs.alert(`Създадено е контиране ${r.number}.`, 'Годишна корекция');
    } catch (e) {
      await dialogs.error(e, 'Операцията не може да бъде записана');
    }
  };

  const docTypes = (lookups.data?.documentTypes ?? []).filter((t) => t.isVisible);

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Calculator className="size-3.5" />} onClick={calculate}>Изчисли</Button>
        <Button icon={<Save className="size-3.5" />} onClick={save}>Запис</Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
        <div className="grid max-w-5xl grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel title="Коефициент по чл. 73, ал. 5 от ЗДДС">
            <div className="grid grid-cols-2 gap-2 p-3">
              <Field label="От дата"><TextInput type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
              <Field label="До дата"><TextInput type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
              <Field label="Числител (облагаеми доставки)"><TextInput readOnly className="num bg-slate-50" value={calc ? money(calc.numerator) : ''} /></Field>
              <Field label="Отклонение в числителя"><TextInput className="num" value={f.numeratorDeviation} onChange={(e) => setF({ ...f, numeratorDeviation: e.target.value })} /></Field>
              <Field label="Знаменател (всички доставки)"><TextInput readOnly className="num bg-slate-50" value={calc ? money(calc.denominator) : ''} /></Field>
              <Field label="Отклонение в знаменателя"><TextInput className="num" value={f.denominatorDeviation} onChange={(e) => setF({ ...f, denominatorDeviation: e.target.value })} /></Field>
              <Field label="Коефициент" hint={calc ? `Точно: ${calc.exact}` : stored.data?.ratio ? 'Записан коефициент' : undefined}>
                <TextInput className="num font-semibold" value={f.ratio} onChange={(e) => setF({ ...f, ratio: e.target.value })} aria-label="Коефициент" />
              </Field>
            </div>
            <p className="px-3 pb-3 text-[12px] text-slate-500">Коефициентът не се прехвърля автоматично в клетка 33 на декларацията; въведете го в „ДДС дневници, декларация и VIES“.</p>
          </Panel>
          <Panel title="Годишна корекция по чл. 73, ал. 8 от ЗДДС">
            <div className="grid grid-cols-2 gap-2 p-3">
              <div className="col-span-2 flex gap-2">
                <Button onClick={() => loadAdjustment()}>Изчисли корекцията</Button>
              </div>
              {adj && (
                <>
                  <Field label="Период на новия коефициент"><TextInput readOnly className="bg-slate-50" value={`${adj.from} – ${adj.to}`} /></Field>
                  <Field label="Данъчен кредит при ЧДК (основа)"><TextInput readOnly className="num bg-slate-50" value={money(adj.base)} /></Field>
                  <Field label="Стар коефициент"><TextInput readOnly className="num bg-slate-50" value={adj.oldRatio} /></Field>
                  <Field label="Нов коефициент">
                    <TextInput className="num" value={adj.newRatio} onChange={(e) => setAdj({ ...adj, newRatio: e.target.value })} onBlur={() => void loadAdjustment(adj.newRatio)} />
                  </Field>
                  <Field label="Сума на корекцията"><TextInput className="num font-semibold" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></Field>
                  <Field label="Дата на контиране"><TextInput type="date" value={doc.accountingDate} onChange={(e) => setDoc({ ...doc, accountingDate: e.target.value })} /></Field>
                  <Field label="Тип документ">
                    <Select value={doc.documentTypeId ?? ''} onChange={(e) => setDoc({ ...doc, documentTypeId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">—</option>
                      {docTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Документ №"><TextInput value={doc.documentNumber} onChange={(e) => setDoc({ ...doc, documentNumber: e.target.value })} /></Field>
                  <div className="col-span-2 text-[12px] text-slate-500">Дт ДДС покупки / Кт 709, ДДС режим 5 „{adj.term}“.</div>
                  <div className="col-span-2"><Button variant="primary" icon={<Send className="size-3.5" />} onClick={post}>Контиране</Button></div>
                </>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
