import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Euro, FilePlus2, FileText, FolderPlus, Pencil, RotateCcw, Scale, SquarePen, Trash2, Undo2, Users } from 'lucide-react';
import { api, qs } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { bgDate, money } from '../format.ts';
import { useInvalidate, useSession } from '../session.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import { categoryLabel, useAssetLookups, useLocations, type AssetRow, type Location } from './common.tsx';
import { CheckDialog, CommonDataDialog, IasDialog, LocationDialog, TerminateDialog } from './dialogs.tsx';

type Period = 'all' | 'active' | 'expiredSap' | 'expiredDap' | 'writtenOffSap';
const PERIODS: [Period, string][] = [
  ['all', 'Без филтър по дати'],
  ['active', 'Активни в периода'],
  ['expiredSap', 'Изхабени (САП) в периода'],
  ['expiredDap', 'Изхабени (ДАП) в периода'],
  ['writtenOffSap', 'Отписани (САП) в периода'],
];

type Dlg =
  | { kind: 'location'; location?: Location; parent?: Location }
  | { kind: 'terminate'; asset: AssetRow }
  | { kind: 'ias'; asset: AssetRow }
  | { kind: 'common'; assets: AssetRow[] }
  | { kind: 'check' }
  | null;

/** Дълготрайни активи (Ctrl+D): location tree, filters, register grid and the asset commands (spec 03b 1, 07 FixedAssetsListView). */
export function FixedAssets() {
  const session = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useAssetLookups();
  const locations = useLocations();
  const [locationId, setLocationId] = useState<number | null>(null);
  const [f, setF] = useState({ inventoryNumber: '', name: '', account: '', mol: '', note: '', categoryId: '', state: 'all', period: 'all' as Period, from: `${session.year.year}-01-01`, to: `${session.year.year}-12-31` });
  const [selId, setSelId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [dlg, setDlg] = useState<Dlg>(null);

  const query = qs({ locationId: locationId && locationId !== 1 ? locationId : null, inventoryNumber: f.inventoryNumber, name: f.name, account: f.account, mol: f.mol, note: f.note, categoryId: f.categoryId, state: f.state === 'all' ? null : f.state, period: f.period === 'all' ? null : f.period, from: f.period === 'all' ? null : f.from, to: f.period === 'all' ? null : f.to });
  const list = useQuery({ queryKey: ['assets', session.year.id, query], queryFn: () => api.get<AssetRow[]>(`/assets${query}`), placeholderData: keepPreviousData });
  const rows = list.data ?? [];
  const sel = rows.find((r) => r.id === selId) ?? null;
  const picked = useMemo(() => {
    const ids = checked.size ? rows.filter((r) => checked.has(r.id)) : sel ? [sel] : [];
    return ids;
  }, [checked, rows, sel]);
  const totals = useMemo(() => ({ cost: rows.reduce((a, r) => a + Number(r.cost), 0), accrued: rows.reduce((a, r) => a + Number(r.accrued), 0), book: rows.reduce((a, r) => a + Number(r.bookValue), 0) }), [rows]);
  const isEuroYear = session.year.year > 2025;
  const location = locations.data?.find((l) => l.id === locationId) ?? null;

  const refresh = () => invalidate('assets', 'asset', 'assetPreview', 'accountingRequests', 'reports');
  const openAsset = (id?: number, inv?: string) => ws.open('asset', id ? { key: `asset:${id}`, params: { id }, title: `ДА ${inv ?? ''}` } : { params: { locationId: locationId ?? undefined }, title: 'Нов ДА' });

  const remove = async () => {
    if (!sel || !(await dialogs.confirm(`Желаете ли да изтриете актив „${sel.name}“ (${sel.inventoryNumber})?`))) return;
    try {
      await api.del(`/assets/${sel.id}`);
      setSelId(null);
      await refresh();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const restore = async () => {
    if (!sel || !(await dialogs.confirm(`Желаете ли връщане на отписан актив „${sel.name}“? Контирането на отписването остава в счетоводството.`))) return;
    try {
      await api.post(`/assets/${sel.id}/restore`);
      await refresh();
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const removeLocation = async () => {
    if (!location || !(await dialogs.confirm(`Желаете ли да изтриете местоположение „${location.name}“?`))) return;
    try {
      await api.del(`/asset-locations/${location.id}`);
      setLocationId(null);
      await invalidate('assetLocations');
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const convert = async () => {
    if (!(await dialogs.confirm('Ще бъдат създадени копия в евро на всички дълготрайни активи от предходните години (курс 1,95583). Желаете ли да продължите?'))) return;
    try {
      const r = await api.post<{ created: unknown[] }>('/assets/euro-conversion');
      await refresh();
      await dialogs.alert(`Конвертирани активи: ${r.created.length}.`);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const protocol = (kind: 'protocol58' | 'scrapping') => {
    if (!picked.length) return;
    ws.open('assetProtocol', { key: `assetProtocol:${kind}`, params: { kind, ids: picked.map((r) => r.id) }, title: kind === 'protocol58' ? 'Протокол по чл. 58 от ЗКПО' : 'Протокол за бракуване на ДА' });
  };
  const toggle = (id: number) => {
    const n = new Set(checked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setChecked(n);
  };

  const active = sel && sel.terminationStatusId === 1;
  return (
    <div className="flex h-full flex-col">
      <CommandBar right={<span className="text-[12px] text-slate-500">{list.isFetching && <Spinner className="mr-2 inline-block size-3.5" />}{rows.length} актива{checked.size ? `, избрани ${checked.size}` : ''}</span>}>
        <Button variant="primary" icon={<FilePlus2 className="size-3.5" />} onClick={() => openAsset()}>Нов</Button>
        <Button icon={<Pencil className="size-3.5" />} onClick={() => sel && openAsset(sel.id, sel.inventoryNumber)} disabled={!sel}>Редакция</Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()} disabled={!sel}>Анулиране</Button>
        <Button icon={<Undo2 className="size-3.5" />} onClick={() => sel && setDlg({ kind: 'terminate', asset: sel })} disabled={!active}>Отписване на актив</Button>
        <Button icon={<RotateCcw className="size-3.5" />} onClick={() => void restore()} disabled={!sel || sel.terminationStatusId === 1}>Връщане на отписан актив</Button>
        <Button icon={<FileText className="size-3.5" />} onClick={() => protocol('protocol58')} disabled={!picked.length}>Протокол по чл. 58 от ЗКПО</Button>
        <Button icon={<FileText className="size-3.5" />} onClick={() => protocol('scrapping')} disabled={!picked.length}>Протокол за бракуване на ДА</Button>
        <Button icon={<Users className="size-3.5" />} onClick={() => setDlg({ kind: 'common', assets: picked })} disabled={!picked.length}>Промяна на общи данни на ДА</Button>
        <Button icon={<Scale className="size-3.5" />} onClick={() => sel && setDlg({ kind: 'ias', asset: sel })} disabled={!active}>Промяна на дълготраен актив по МСС</Button>
        <Button icon={<ClipboardCheck className="size-3.5" />} onClick={() => setDlg({ kind: 'check' })}>Проверка</Button>
        {isEuroYear && <Button icon={<Euro className="size-3.5" />} onClick={() => void convert()}>Конвертиране в EUR</Button>}
      </CommandBar>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-slate-300 bg-white">
          <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1">
            <span className="truncate text-[12px] font-semibold text-slate-600">Местоположение</span>
            <span className="ml-auto flex shrink-0">
              <Button variant="ghost" className="px-1" title="Нова група" aria-label="Нова група" onClick={() => setDlg({ kind: 'location', parent: location ?? locations.data?.[0] })}><FolderPlus className="size-3.5" /></Button>
              <Button variant="ghost" className="px-1" title="Редакция" aria-label="Редакция на група" disabled={!location} onClick={() => location && setDlg({ kind: 'location', location })}><SquarePen className="size-3.5" /></Button>
              <Button variant="ghost" className="px-1" title="Изтриване" aria-label="Изтриване на група" disabled={!location || location.id === 1} onClick={() => void removeLocation()}><Trash2 className="size-3.5" /></Button>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="Местоположения">
            {(locations.data ?? []).map((l) => (
              <div
                key={l.id}
                role="treeitem"
                aria-selected={l.id === (locationId ?? 1)}
                onClick={() => setLocationId(l.id === 1 ? null : l.id)}
                className={cx('cursor-default truncate py-[3px] pr-2', l.id === (locationId ?? 1) ? 'bg-brand-500 text-white' : 'hover:bg-brand-50')}
                style={{ paddingLeft: 8 + (l.level - 1) * 14 }}
                title={l.name}
              >
                {l.name}
              </div>
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <form className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-3 py-2" onSubmit={(e) => e.preventDefault()}>
            <Field label="Инв. №"><TextInput className="w-28" value={f.inventoryNumber} onChange={(e) => setF({ ...f, inventoryNumber: e.target.value })} /></Field>
            <Field label="Име"><TextInput className="w-44" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Сметка (актив / амортизация / разход)"><TextInput className="w-32" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} /></Field>
            <Field label="МОЛ"><TextInput className="w-32" value={f.mol} onChange={(e) => setF({ ...f, mol: e.target.value })} /></Field>
            <Field label="Категория по ЗКПО">
              <Select className="w-44" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
                <option value="">Всички</option>
                {lookups.data?.categories.map((c) => <option key={c.id} value={c.id}>{c.description}</option>)}
              </Select>
            </Field>
            <Field label="Забележка"><TextInput className="w-28" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
            <Field label="Състояние">
              <Select className="w-32" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
                <option value="all">Всички</option>
                <option value="active">Неотписани</option>
                <option value="terminated">Отписани</option>
              </Select>
            </Field>
            <Field label="Дати">
              <Select className="w-48" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as Period })}>
                {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            {f.period !== 'all' && (
              <>
                <Field label="От дата"><TextInput type="date" className="w-36" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
                <Field label="До дата"><TextInput type="date" className="w-36" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
              </>
            )}
          </form>
          <div className="min-h-0 flex-1 overflow-auto">
            {list.isLoading ? (
              <Empty><Spinner /></Empty>
            ) : rows.length === 0 ? (
              <Empty>Няма дълготрайни активи.</Empty>
            ) : (
              <table className="grid-table" aria-label="Дълготрайни активи">
                <thead>
                  <tr>
                    <th className="w-6">
                      <input type="checkbox" aria-label="Избор на всички" checked={checked.size > 0 && checked.size === rows.length} onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                    </th>
                    <th>Инв. №</th>
                    <th>Наименование</th>
                    <th>МОЛ</th>
                    <th>Местоположение</th>
                    <th>Категория</th>
                    <th>Сметка</th>
                    <th>Въведен в експл.</th>
                    <th>Изхабяване САП</th>
                    <th>Изхабяване ДАП</th>
                    <th>Отписан (САП)</th>
                    <th className="text-right">Ст-ст</th>
                    <th className="text-right">Начислени</th>
                    <th className="text-right">Балансова ст-ст</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} aria-selected={r.id === selId} onClick={() => setSelId(r.id)} onDoubleClick={() => openAsset(r.id, r.inventoryNumber)} className={cx('cursor-default', r.terminationStatusId !== 1 && 'text-slate-500')}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Избор на ${r.inventoryNumber}`} checked={checked.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                      <td>{r.inventoryNumber}</td>
                      <td className="max-w-72 truncate" title={r.name}>{r.name}</td>
                      <td>{r.personInCharge}</td>
                      <td className="max-w-48 truncate" title={r.location}>{r.location}</td>
                      <td className="max-w-32 truncate" title={categoryLabel(lookups.data, r.categoryId)}>{categoryLabel(lookups.data, r.categoryId)}</td>
                      <td>{r.inventoryAccount}</td>
                      <td>{bgDate(r.startDate)}</td>
                      <td>{bgDate(r.sapEndDate)}</td>
                      <td>{bgDate(r.dapEndDate)}</td>
                      <td>{r.sapFinalDate ? bgDate(r.sapFinalDate) : 'Неотписан'}</td>
                      <td className="num">{money(r.cost)}</td>
                      <td className="num">{money(r.accrued)}</td>
                      <td className="num">{money(r.bookValue)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={11}>Общо:</td>
                    <td className="num">{money(totals.cost)}</td>
                    <td className="num">{money(totals.accrued)}</td>
                    <td className="num">{money(totals.book)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-slate-300 bg-slate-50 px-3 py-1 text-[12px] text-slate-600">
            <Checkbox label="Избор с отметки (за протоколи и обща промяна)" checked={checked.size > 0} onChange={(v) => setChecked(v && sel ? new Set([sel.id]) : new Set())} />
            {sel && <span className="ml-auto">Избран: {sel.inventoryNumber} {sel.name}</span>}
          </div>
        </div>
      </div>

      {dlg?.kind === 'location' && <LocationDialog location={dlg.location} parent={dlg.parent} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); void invalidate('assetLocations', 'assets'); }} />}
      {dlg?.kind === 'terminate' && (
        <TerminateDialog asset={dlg.asset} onClose={() => setDlg(null)} onDone={async (r) => {
          setDlg(null);
          await refresh();
          await dialogs.alert(r.number ? `Активът е отписан с контиране № ${r.number}.` : 'Активът е отписан без операция.');
        }} />
      )}
      {dlg?.kind === 'ias' && <IasDialog asset={dlg.asset} onClose={() => setDlg(null)} onDone={async () => { setDlg(null); await refresh(); }} />}
      {dlg?.kind === 'common' && <CommonDataDialog assets={dlg.assets} onClose={() => setDlg(null)} onDone={() => void refresh()} />}
      {dlg?.kind === 'check' && <CheckDialog year={session.year.year} onClose={() => setDlg(null)} />}
    </div>
  );
}
