import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Coins, FileDown, FileUp, Package, Plus, Printer, Save, Scale, SplitSquareHorizontal, Trash2, Undo2, X } from 'lucide-react';
import { dec, ENTRY_FOLLOW_UP_MESSAGES as FM, fixedAssetOffer, formatMoney, isCompanyCategory, JOURNAL_EXTRA_MESSAGES as XM, linkedPostingWarning, parseAmount } from '@shmi/core';
import { ApiError, api, qs } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { DictionaryInput } from '../components/DictionaryInput.tsx';
import { AccountPicker, PartnerPicker } from '../components/pickers.tsx';
import { Button, Checkbox, CommandBar, Field, Select, Spinner, TextInput, cx } from '../components/ui.tsx';
import { useAccounts, useCan, useInvalidate, useLookups, useSession } from '../session.tsx';
import { useWorkspace, type ScreenProps } from '../shell/workspace.tsx';
import type { Account } from '../types.ts';
import { balanced, headerOf, toAmountInput, lineToApi, materialLinesOf, recalcLine, rescheduleFromEntry, rowFormats, templatePayload, toInput, withFixing, withMaterialLines } from './entry/commands.ts';
import { AttachmentsPanel, BalancePanel, ExpensesDialog, type ExpensesChoice } from './entry/EntryPanels.tsx';
import { memorizer } from './entry/memorizer.ts';
import { printEntryCards, type EntryCard } from './entry/print.ts';
import { confirmBeforeSave, confirmVoid, differentNumberMessage } from './entry/saveFlow.ts';
import { useShortcuts } from './entry/shortcuts.ts';
import { MaterialDetailsDialog, type MaterialLine } from './stock/MaterialDetailsDialog.tsx';
import { LoadTemplateDialog, SaveTemplateDialog } from './templates/TemplateDialogs.tsx';
import { useEntryVat } from './vat/EntryVat.tsx';
import { printProtocol, type PrintData } from './vat/ProtocolDialog.tsx';
import { EntryPaymentPanel, useEntryPayment } from '../payments/EntryPaymentPanel.tsx';

export interface Line {
  accountId: number | null;
  amount: string;
  companyId: number | null;
  companyName?: string | null;
  currencyAmount: string;
  exchangeRate: string;
  /** Фиксинг (02a 1.3). */
  fixedRate: string;
  quantity: string;
  price: string;
  description: string;
  vatTermId: number | null;
}

export interface Draft {
  id?: number;
  /** Row version from the server (optimistic concurrency, 01b 9). */
  version?: string;
  number: string;
  accountingDate: string;
  documentDate: string;
  documentTypeId: number | null;
  documentNumber: string;
  companyId: number | null;
  companyName?: string | null;
  term: string;
  reference: string;
  optionalReference: string;
  paragraph: string;
  transactionTypeId: number;
  viesId: number | null;
  viesMonth: string;
  dueDate: string;
  isInitialBalance: boolean;
  source?: string;
  debits: Line[];
  credits: Line[];
}

export const emptyLine = (): Line => ({ accountId: null, amount: '', companyId: null, currencyAmount: '', exchangeRate: '', fixedRate: '', quantity: '', price: '', description: '', vatTermId: null });

export function newDraft(date: string, isInitialBalance = false): Draft {
  return {
    number: '', accountingDate: date, documentDate: date, documentTypeId: isInitialBalance ? null : 1, documentNumber: '', companyId: null,
    term: '', reference: '', optionalReference: '', paragraph: '', transactionTypeId: 1, viesId: null, viesMonth: date.slice(0, 8) + '01',
    dueDate: '', isInitialBalance, debits: [emptyLine()], credits: [emptyLine()],
  };
}

type EditorMode = 'delivery' | 'sale';
type Dlg = null | 'saveTemplate' | 'loadTemplate' | 'expenses' | EditorMode;

/** Window commands handled by the editor (06 2.6 ids); keys come from the user's shortcut table. */
const EDITOR_COMMANDS = [
  'Save', 'Balancing', 'BalancingAndSave', 'BalancingSaveAndCopy', 'BalancingSaveAndPayment', 'SaveAndExpensesDistribution', 'Fixing', 'ExpensesDistribution', 'SaveTemplate', 'LoadTemplates',
  'CopyAccountingData', 'PasteAccountingData', 'CalculatePrice', 'DeliveryMaterialDetails', 'SaleMaterialDetails', 'PrevAccounting', 'NextAccounting',
  'CalculateVAT', 'AddVatPurchase', 'AddVatSale', 'ICAProtocol',
] as const;

/** A new entry for a delivery (Ctrl+Shift+D) or sale (Ctrl+Shift+S) of materials (03a 4.5). */
function modeDraft(date: string, mode: EditorMode | undefined): Draft {
  const d = newDraft(date);
  if (mode === 'delivery') return { ...d, transactionTypeId: 2, term: 'Доставка на стоки/материали' };
  if (mode === 'sale') return { ...d, transactionTypeId: 3, term: 'Продажба на стоки/материали' };
  return d;
}

/** Контиране (F2) / Редакция на контиране: header + debit/credit grids (spec 02a section 4). */
export function EntryEditor({ tab, mode }: ScreenProps & { mode?: EditorMode }) {
  const session = useSession();
  const ws = useWorkspace();
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  const can = useCan();
  const lookups = useLookups();
  const accounts = useAccounts();
  const shortcuts = useShortcuts();
  const id = tab.params?.id as number | undefined;
  const fromDraft = tab.params?.draft as Draft | undefined;
  const loaded = useQuery({ queryKey: ['entry', id], queryFn: () => api.get<Record<string, unknown>>(`/entries/${id}`), enabled: !!id, staleTime: 0 });
  const nextNumber = useQuery({ queryKey: ['entries', 'next-number'], queryFn: () => api.get<{ number: string }>('/entries/next-number'), enabled: !id });
  const userSettings = useQuery({ queryKey: ['settings', 'user'], queryFn: () => api.get<Record<string, string>>('/settings/user'), staleTime: 60_000 });
  const [d, setD] = useState<Draft | null>(id ? null : (fromDraft ?? (tab.params?.initial ? newDraft(session.workingDate, true) : modeDraft(session.workingDate, mode))));
  const [saving, setSaving] = useState(false);
  const [dlg, setDlg] = useState<Dlg>(mode && !id && !fromDraft ? mode : null);
  const pay = useEntryPayment();

  // 03b 12.3: opening a posting generated by a depreciation plan or an asset write-off warns; No closes the editor.
  const warnedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded.data || d) return;
    const draft = fromServer(loaded.data);
    setD(draft);
    const w = linkedPostingWarning(draft.source);
    if (w && draft.id && warnedFor.current !== draft.id) {
      warnedFor.current = draft.id;
      void dialogs.confirm(w.text).then((ok) => !ok && ws.close(tab.key));
    }
  }, [loaded.data, d, dialogs, ws, tab.key]);

  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const formats = rowFormats(session.settings);
  const setDirty = (dirty: boolean) => tab.dirty !== dirty && ws.update(tab.key, { dirty });
  const patch = (p: Partial<Draft>) => {
    setD((x) => (x ? { ...x, ...p } : x));
    setDirty(true);
  };
  const vat = useEntryVat(d, patch, byId);

  if (!d || !lookups.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const totals = (lines: Line[]) => lines.reduce((acc, l) => acc.plus(parseAmount(l.amount) ?? 0), dec(0));
  const td = totals(d.debits);
  const tc = totals(d.credits);
  const diff = td.minus(tc);
  const docTypes = lookups.data.documentTypes.filter((t) => t.isVisible || t.id === d.documentTypeId);
  const readOnly = !!d.id && !can('UI_Edit_Accountings');
  const keepOpen = userSettings.data?.KeepAccountingOpen === 'True';
  const settingOn = (k: string, def = false) => (session.settings[k] === undefined ? def : session.settings[k] === 'True');

  const setLine = (side: 'debits' | 'credits', i: number, p: Partial<Line>) => {
    const lines = d[side].map((l, j) => (j === i ? recalcLine({ ...l, ...p }, p, byId.get((p.accountId ?? l.accountId) as number), formats) : l));
    patch({ [side]: lines } as Partial<Draft>);
    const acc = p.accountId ? byId.get(p.accountId) : undefined;
    if (acc?.isForeignCurrency && p.accountId !== d[side][i]?.accountId) void fillFixing(side, i, acc);
  };

  type FixingAnswer = { rates: { currencyId: number; rate: string | null }[]; message: string | null };
  const fetchFixing = (date: string, currencyIds: number[], download: boolean) =>
    api.get<FixingAnswer>(`/journal/fixing${qs({ date, currencyIds: [...new Set(currencyIds)].join(','), download: download ? 1 : 0 })}`);

  /**
   * A foreign-currency account picked on a line: its Фиксинг is the stored rate
   * of the accounting date; with AutomaticFillExchangeRate the rate is also
   * downloaded when missing and becomes the line's rate (03a 5.4).
   */
  const fillFixing = async (side: 'debits' | 'credits', i: number, acc: Account) => {
    const auto = settingOn('AutomaticFillExchangeRate');
    try {
      const r = await fetchFixing(d.accountingDate, [acc.currencyId], auto);
      const rate = r.rates[0]?.rate;
      if (!rate) {
        if (auto && r.message) await dialogs.alert(r.message);
        return;
      }
      setD((x) => x && ({ ...x, [side]: x[side].map((l, j) => (j === i && l.accountId === acc.id ? withFixing(l, rate, auto && !parseAmount(l.exchangeRate)) : l)) }));
    } catch {
      // The fixing is an assist; the save fills it when it stays empty.
    }
  };

  const foreignLines = (['debits', 'credits'] as const).flatMap((side) => d[side].filter((l) => l.accountId && byId.get(l.accountId)?.isForeignCurrency));
  /** Фиксинг (Ctrl+F12): recalculates the fixing and the rate of every currency line for the accounting date (02a 2). */
  const recalcFixings = async () => {
    if (!foreignLines.length || !(await dialogs.confirm(FM.strCalculateFixingExchangeConfirmationPrompt))) return;
    try {
      const r = await fetchFixing(d.accountingDate, foreignLines.map((l) => byId.get(l.accountId!)!.currencyId), true);
      const rates = new Map(r.rates.filter((x) => x.rate).map((x) => [x.currencyId, x.rate!]));
      const fix = (l: Line) => {
        const a = l.accountId ? byId.get(l.accountId) : undefined;
        const rate = a?.isForeignCurrency ? rates.get(a.currencyId) : undefined;
        return rate ? withFixing(l, rate, true) : l;
      };
      patch({ debits: d.debits.map(fix), credits: d.credits.map(fix) });
      if (r.message) await dialogs.alert(r.message);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const addLine = (side: 'debits' | 'credits') => patch({ [side]: [...d[side], emptyLine()] } as Partial<Draft>);
  const removeLine = (side: 'debits' | 'credits', i: number) => patch({ [side]: d[side].length > 1 ? d[side].filter((_, j) => j !== i) : [emptyLine()] } as Partial<Draft>);

  /** Изравняване (Ctrl+F9). */
  const balance = () => !diff.isZero() && patch(balanced(d));

  const payload = (x: Draft) => ({
    version: x.id ? (x.version ?? null) : null,
    number: x.number || null,
    accountingDate: x.accountingDate,
    documentDate: x.documentDate || null,
    documentTypeId: x.documentTypeId,
    documentNumber: x.documentNumber,
    companyId: x.companyId,
    term: x.term,
    reference: x.reference || null,
    optionalReference: x.optionalReference || null,
    paragraph: x.paragraph || null,
    transactionTypeId: x.transactionTypeId,
    viesId: x.viesId,
    viesMonth: x.viesMonth || null,
    dueDate: x.dueDate || null,
    isInitialBalance: x.isInitialBalance,
    source: x.source,
    debits: x.debits.filter((l) => l.accountId).map(lineToApi),
    credits: x.credits.filter((l) => l.accountId).map(lineToApi),
  });

  /** After save: different number, group-60 closing drafts (4.7); returns the saved id. */
  const afterSave = async (r: { id: number; number: string; warnings: { key: string; text: string; severity: 'warning' }[] }, wasNew: boolean, source: Draft) => {
    await invalidate('entries', 'reports', 'accounts', 'dictionary', 'partners');
    if (r.warnings?.length) await dialogs.messages(`Контиране ${r.number} е записано с предупреждения`, r.warnings);
    const msg = wasNew ? differentNumberMessage(d.number || nextNumber.data?.number, r.number, settingOn('DifferentAccountingNumberWarning')) : null;
    if (msg) await dialogs.alert(msg);
    if (wasNew && settingOn('IsAllowAccountingAutomaticEnd')) {
      const g = await api.get<{ drafts: Record<string, unknown>[] }>(`/journal/entries/${r.id}/group60-drafts`);
      for (const draft of g.drafts) ws.open('entry', { title: 'Приключване на група 60', params: { draft: fromServer(draft) } });
    }
    // strAddFixedAssetData (02a 4.4, 03b 14.1): a debit on a 2xx account offers a new asset prefilled from the posting.
    if (wasNew && !source.isInitialBalance && can('UI_Operations_Depreciations')) {
      const line = (l: Line) => ({ accountId: l.accountId!, accountNumber: byId.get(l.accountId!)?.number ?? '', amount: parseAmount(l.amount)?.toString() ?? '0', isCompany: isCompanyCategory(byId.get(l.accountId!)?.categoryId) });
      const offer = fixedAssetOffer(source.debits.filter((l) => l.accountId).map(line), source.credits.filter((l) => l.accountId).map(line));
      if (offer && (await dialogs.confirm(FM.strAddFixedAssetData))) ws.open('asset', { title: 'Дълготраен актив', params: { fromAccountingId: r.id } });
    }
    // strPrintVOPProtocolConfirmation (02a 4.4): an edited entry with a VAT protocol.
    if (!wasNew) {
      const p = await api.get<{ protocol: unknown }>(`/vat/protocols/${r.id}`).catch(() => null);
      if (p?.protocol && (await dialogs.confirm(FM.strPrintVOPProtocolConfirmation))) {
        try {
          printProtocol(await api.get<PrintData>(`/vat/protocols/${r.id}/print`));
        } catch (e) {
          await dialogs.error(e);
        }
      }
    }
  };

  type After = 'close' | 'new' | 'copy' | 'stay' | 'expenses' | 'payment';
  /** Save with the confirmation chain; `after` = what the window does next (4.2 step 6). */
  const save = async (after: After = 'close', source: Draft = d) => {
    if (saving) return null;
    setSaving(true);
    try {
      if (!(await confirmBeforeSave(dialogs, source))) return null;
      const body = payload(source);
      const extras = await pay.beforeSave(body);
      if (!extras) return null;
      type Saved = { id: number; number: string; version: string; warnings: { key: string; text: string; severity: 'warning' }[] };
      // VAT questions (02b 12) come back as a 409 confirm and are resent with `force`.
      const r = await vat.confirmSave((force) => source.id
        ? api.put<Saved>(`/entries/${source.id}`, { ...body, ...extras, force, confirmAccountLinks: true })
        : api.post<Saved>('/entries', { ...body, ...extras, force, confirmAccountLinks: true }));
      if (!r) return null;
      await pay.afterSave(extras);
      await afterSave(r, !source.id, source);
      setDirty(false);
      if (after === 'payment') {
        // Ctrl+F10 (02a 4.1): balanced, saved, then the payments of the entry's partner.
        const companyId = source.companyId ?? [...source.debits, ...source.credits].find((l) => l.companyId)?.companyId ?? null;
        ws.open('payments', companyId ? { params: { companyId } } : undefined);
      }
      const next = (after === 'close' || after === 'payment') && keepOpen ? 'new' : after === 'payment' ? 'close' : after;
      if (next === 'new') {
        setD(source.isInitialBalance ? newDraft(source.accountingDate, true) : modeDraft(source.accountingDate, mode));
        ws.update(tab.key, { title: source.isInitialBalance ? 'Начални салда' : 'Контиране', params: {} });
        void nextNumber.refetch();
      } else if (next === 'copy') {
        setD({ ...source, id: undefined, number: '' });
        ws.update(tab.key, { title: 'Контиране', params: {} });
        void nextNumber.refetch();
      } else if (next === 'stay' || next === 'expenses') {
        setD({ ...source, id: r.id, number: r.number, version: r.version });
        ws.update(tab.key, { title: `Контиране ${r.number}`, params: { id: r.id } });
        if (next === 'expenses') setDlg('expenses');
      } else {
        ws.close(tab.key);
      }
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict' && source.id) {
        // Changed by someone else since it was loaded: offer to reload it (the local edits are lost).
        if (await dialogs.confirm(`${e.message}\nЖелаете ли да заредите контирането отново?`, 'Контирането е променено')) await reload(source.id);
        return null;
      }
      await dialogs.error(e, 'Операцията не може да бъде записана');
      return null;
    } finally {
      setSaving(false);
    }
  };

  /** Loads the stored entry again, dropping the local edits. */
  const reload = async (entryId: number) => {
    try {
      const fresh = await api.get<Record<string, unknown>>(`/entries/${entryId}`);
      qc.setQueryData(['entry', entryId], fresh);
      setD(fromServer(fresh));
      setDirty(false);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const remove = async () => {
    if (!d.id) return;
    try {
      if (!(await confirmVoid(dialogs, [d.id]))) return;
      await api.post('/journal/void', { ids: [d.id] });
      await invalidate('entries', 'reports', 'accounts');
      setDirty(false);
      ws.close(tab.key);
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const reversal = async () => {
    if (!d.id) return;
    try {
      const draft = await api.get<Record<string, unknown>>(`/entries/${d.id}/reversal`);
      ws.open('entry', { title: 'Сторно', params: { draft: fromServer(draft) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  /** Ново контиране от избраното (5.3). */
  const copyEntry = async () => {
    if (!d.id) return;
    try {
      const draft = await api.get<Record<string, unknown>>(`/journal/entries/${d.id}/copy`);
      ws.open('entry', { title: XM.strNewAccountingFromSelected, params: { draft: fromServer(draft) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  /** << / >> (Alt+Left / Alt+Right): previous / next entry in list order (02a 7). */
  const navigate = async (dir: 'prev' | 'next') => {
    if (!d.id) return;
    if (tab.dirty && !(await dialogs.confirm(XM.strStateChangedWarning))) return;
    const r = await api.get<{ entry: { id: number; number: string } | null }>(`/journal/entries/${d.id}/neighbor?dir=${dir}`);
    if (!r.entry) return;
    setDirty(false);
    setD(null);
    ws.update(tab.key, { title: `Контиране ${r.entry.number}`, params: { id: r.entry.id } });
  };

  /** Разпределяне на допълнителни разходи (F11) over the saved entry's lines (4.7). */
  const distribute = async (c: ExpensesChoice, entryId: number) => {
    setDlg(null);
    try {
      const draft = await api.post<Record<string, unknown>>(`/journal/entries/${entryId}/expenses-draft`, c);
      ws.open('entry', { title: 'Разпределяне на разходи', params: { draft: fromServer(draft) } });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  /** Средно претеглени цени (Ctrl+F5) for every material line (03a 4.4). */
  const loadAveragePrices = async () => {
    const material = (['debits', 'credits'] as const).some((s) => d[s].some((l) => l.accountId && byId.get(l.accountId)?.isMaterial));
    if (!material || !(await dialogs.confirm(XM.strLoadPriceConfirmationPrompt))) return;
    const priced = async (lines: Line[]) => Promise.all(lines.map(async (l) => {
      const a = l.accountId ? byId.get(l.accountId) : undefined;
      if (!a?.isMaterial || !a.productId) return l;
      const r = await api.get<{ price: string }>(`/stock/average-price${qs({ productId: a.productId, date: d.accountingDate })}`);
      return recalcLine({ ...l, price: toInput(r.price) }, { price: r.price }, a, formats);
    }));
    try {
      patch({ debits: await priced(d.debits), credits: await priced(d.credits) });
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const applyMaterial = (m: EditorMode, lines: MaterialLine[]) => {
    setDlg(null);
    const side = m === 'delivery' ? 'debits' : 'credits';
    patch({ [side]: withMaterialLines(d[side], lines, byId, emptyLine) } as Partial<Draft>);
  };

  const pasteHeader = () => {
    const h = memorizer.paste();
    if (h) patch(h);
  };

  const run = async (cmd: (typeof EDITOR_COMMANDS)[number]) => {
    switch (cmd) {
      case 'Save': return void save();
      case 'Balancing': return balance();
      case 'BalancingAndSave': return void save('close', balanced(d));
      case 'BalancingSaveAndCopy': return void save('copy', balanced(d));
      case 'BalancingSaveAndPayment': return void save('payment', balanced(d));
      case 'Fixing': return void recalcFixings();
      case 'SaveAndExpensesDistribution': return void save('expenses', balanced(d));
      case 'ExpensesDistribution': return d.id ? setDlg('expenses') : void save('expenses');
      case 'SaveTemplate': return setDlg('saveTemplate');
      case 'LoadTemplates': return setDlg('loadTemplate');
      case 'CopyAccountingData': return memorizer.copy(headerOf(d));
      case 'PasteAccountingData': return pasteHeader();
      case 'CalculatePrice': return void loadAveragePrices();
      case 'DeliveryMaterialDetails': return setDlg('delivery');
      case 'SaleMaterialDetails': return setDlg('sale');
      case 'PrevAccounting': return void navigate('prev');
      case 'NextAccounting': return void navigate('next');
      case 'CalculateVAT': return void vat.calculateVat();
      case 'AddVatPurchase': return vat.addVat('purchase');
      case 'AddVatSale': return vat.addVat('sale');
      case 'ICAProtocol': return vat.openProtocol();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dlg) return;
    const cmd = shortcuts.match(e, EDITOR_COMMANDS);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    void run(cmd as (typeof EDITOR_COMMANDS)[number]);
  };
  const hint = (cmd: string) => shortcuts.gesture(cmd) || undefined;

  /** Печат: the entry card of the saved entry (05 7.11). */
  const printCard = async () => {
    if (!d.id) return;
    try {
      printEntryCards([await api.get<EntryCard>(`/journal/entries/${d.id}/print`)]);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const usedAccounts = [...d.debits, ...d.credits].map((l) => l.accountId).filter((x): x is number => !!x);

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <CommandBar
        right={
          <>
            {d.id && (
              <>
                <Button onClick={() => navigate('prev')} title={hint('PrevAccounting')} aria-label="Предишно контиране">
                  {'<<'}
                </Button>
                <Button onClick={() => navigate('next')} title={hint('NextAccounting')} aria-label="Следващо контиране">
                  {'>>'}
                </Button>
                <Button icon={<Printer className="size-3.5" />} onClick={printCard}>Печат</Button>
                <Button icon={<Copy className="size-3.5" />} onClick={copyEntry} disabled={!can('UI_Operations_Accounting')}>{XM.strNewAccountingFromSelected}</Button>
                <Button icon={<Undo2 className="size-3.5" />} onClick={reversal} disabled={!can('UI_Operations_Accounting')}>Сторно</Button>
                <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove} disabled={!can('UI_Edit_Accountings_DeleteAccounting')}>Изтриване</Button>
              </>
            )}
          </>
        }
      >
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={() => save()} disabled={saving || readOnly} title={hint('Save')}>
          Запис
        </Button>
        {!d.id && (
          <Button onClick={() => save('new')} disabled={saving}>
            Запис и ново
          </Button>
        )}
        <Button icon={<Scale className="size-3.5" />} onClick={balance} disabled={diff.isZero()} title={hint('Balancing')}>
          Изравняване
        </Button>
        {!d.isInitialBalance && (
          <>
            <Button icon={<FileDown className="size-3.5" />} onClick={() => setDlg('saveTemplate')} title={hint('SaveTemplate')}>Запис като шаблон</Button>
            <Button icon={<FileUp className="size-3.5" />} onClick={() => setDlg('loadTemplate')} title={hint('LoadTemplates')}>Шаблон</Button>
            <Button icon={<Package className="size-3.5" />} onClick={() => setDlg(mode === 'sale' ? 'sale' : 'delivery')} title={`${hint('DeliveryMaterialDetails')} / ${hint('SaleMaterialDetails')}`}>СМЗ</Button>
            <Button icon={<SplitSquareHorizontal className="size-3.5" />} onClick={() => ws.open('reschedules', { params: { fromEntry: rescheduleFromEntry(d) } })} disabled={!can('UI_Operations_AccountingReschedules') || td.isZero()}>
              Разсрочване на приход/разход
            </Button>
          </>
        )}
        {foreignLines.length > 0 && (
          <Button icon={<Coins className="size-3.5" />} onClick={recalcFixings} title={hint('Fixing')}>
            Фиксинг
          </Button>
        )}
        {vat.toolbar}
        <Button icon={<X className="size-3.5" />} onClick={async () => (!tab.dirty || (await dialogs.confirm(XM.strStateChangedWarning))) && ws.close(tab.key)}>
          Отказ
        </Button>
        <Checkbox
          className="ml-2 text-[12px]"
          label="Без затваряне след запис"
          checked={keepOpen}
          onChange={async (v) => {
            await api.put('/settings/user', { KeepAccountingOpen: v ? 'True' : 'False' });
            await qc.invalidateQueries({ queryKey: ['settings', 'user'] });
          }}
        />
        {d.isInitialBalance && <span className="ml-2 rounded-sm bg-amber-100 px-2 py-0.5 text-[12px] text-amber-900">Начално салдо</span>}
      </CommandBar>

      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
        <div className="grid grid-cols-12 gap-x-3 gap-y-2 rounded-sm border border-slate-300 bg-white p-3">
          <Field label="Номер" className="col-span-2">
            <TextInput value={d.id ? d.number : d.number || nextNumber.data?.number || ''} readOnly className="bg-slate-50 font-medium" />
          </Field>
          <Field label="Дата на контиране" className="col-span-2">
            <TextInput type="date" value={d.accountingDate} onChange={(e) => patch({ accountingDate: e.target.value, ...(d.documentDate === d.accountingDate ? { documentDate: e.target.value } : {}), viesMonth: e.target.value.slice(0, 8) + '01' })} />
          </Field>
          <Field label="Тип документ" className="col-span-3">
            <Select value={d.documentTypeId ?? ''} onChange={(e) => patch({ documentTypeId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>
              {docTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Документ №" className="col-span-2">
            <TextInput value={d.documentNumber} onChange={(e) => patch({ documentNumber: e.target.value })} />
          </Field>
          <Field label="Дата на документ" className="col-span-3">
            <TextInput type="date" value={d.documentDate} onChange={(e) => patch({ documentDate: e.target.value })} />
          </Field>

          <Field label="Партньор" className="col-span-5">
            <PartnerPicker value={d.companyId} valueName={d.companyName} onChange={(p) => patch({ companyId: p?.id ?? null, companyName: p?.name ?? null, ...(p?.dueDays && !d.dueDate ? { dueDate: addDays(d.documentDate || d.accountingDate, p.dueDays) } : {}) })} />
          </Field>
          <Field label="Основание" className="col-span-7">
            <DictionaryInput type="terms" value={d.term} onChange={(v) => patch({ term: v })} />
          </Field>
          <Field label="Забележка" className={session.settings.IsOptionalReferenceEnabled === 'True' ? 'col-span-4' : 'col-span-7'}>
            <DictionaryInput type="references" value={d.reference} onChange={(v) => patch({ reference: v })} />
          </Field>
          {session.settings.IsOptionalReferenceEnabled === 'True' && (
            <Field label="Втора забележка" className="col-span-3">
              <DictionaryInput type="references" value={d.optionalReference} onChange={(v) => patch({ optionalReference: v })} />
            </Field>
          )}
          <Field label="Тип на сделката" className="col-span-2">
            <Select value={d.transactionTypeId} onChange={(e) => patch({ transactionTypeId: Number(e.target.value) })}>
              {lookups.data.transactionTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Месец за експорт (ДДС)" className="col-span-2">
            <TextInput type="month" value={d.viesMonth.slice(0, 7)} onChange={(e) => patch({ viesMonth: e.target.value ? `${e.target.value}-01` : '' })} />
          </Field>
          <Field label="Падеж" className="col-span-1">
            <TextInput type="date" value={d.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} className="px-1" />
          </Field>
          {vat.header}
          <EntryPaymentPanel ctl={pay} payload={payload(d)} entryId={d.id} readOnly={readOnly} />
          {session.settings.IsParagraphEnabled === 'True' && (
            <Field label="Параграф" className="col-span-12">
              <DictionaryInput type="paragraphs" value={d.paragraph} onChange={(v) => patch({ paragraph: v })} />
            </Field>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          {(['debits', 'credits'] as const).map((side) => (
            <LinesGrid
              key={side}
              title={side === 'debits' ? 'Дебит' : 'Кредит'}
              lines={d[side]}
              byId={byId}
              headerCompanyId={d.companyId}
              vatTerms={lookups.data!.vatTerms}
              total={side === 'debits' ? td : tc}
              onChange={(i, p) => setLine(side, i, p)}
              onAdd={() => addLine(side)}
              onRemove={(i) => removeLine(side, i)}
            />
          ))}
        </div>
        <div className={cx('mt-2 flex justify-end gap-6 px-1 text-[13px]', diff.isZero() ? 'text-slate-600' : 'font-semibold text-red-700')}>
          <span>Общо дебит: {formatMoney(td)}</span>
          <span>Общо кредит: {formatMoney(tc)}</span>
          <span>Разлика: {formatMoney(diff)}</span>
        </div>
        {settingOn('IsAccountingBalanceEnabled', true) && !d.isInitialBalance && <BalancePanel accountIds={usedAccounts} date={d.accountingDate} excludeId={d.id} byId={byId} />}
        {d.id && settingOn('IsAllowAccountingAttachments') && <AttachmentsPanel entryId={d.id} readOnly={readOnly} />}
      </div>

      {(dlg === 'delivery' || dlg === 'sale') && (
        <MaterialDetailsDialog
          mode={dlg}
          date={d.accountingDate}
          initial={materialLinesOf(dlg === 'delivery' ? d.debits : d.credits, byId)}
          onOk={(lines) => applyMaterial(dlg, lines)}
          onClose={() => setDlg(null)}
        />
      )}
      {dlg === 'saveTemplate' && <SaveTemplateDialog payload={templatePayload(d)} onClose={() => setDlg(null)} onSaved={() => setDlg(null)} />}
      {dlg === 'loadTemplate' && (
        <LoadTemplateDialog
          date={d.accountingDate}
          onClose={() => setDlg(null)}
          onPick={(server) => {
            setDlg(null);
            const t = fromServer(server);
            patch({ ...t, id: d.id, version: d.version, number: d.number, accountingDate: d.accountingDate, isInitialBalance: d.isInitialBalance });
          }}
        />
      )}
      {dlg === 'expenses' && d.id && <ExpensesDialog onClose={() => setDlg(null)} onOk={(c) => distribute(c, d.id!)} />}
      {vat.dialog}
    </div>
  );
}

function LinesGrid({ title, lines, byId, headerCompanyId, vatTerms, total, onChange, onAdd, onRemove }: {
  title: string; lines: Line[]; byId: Map<number, Account>; headerCompanyId: number | null; vatTerms: { id: number; description: string; vatValue: string }[];
  total: ReturnType<typeof dec>; onChange: (i: number, p: Partial<Line>) => void; onAdd: () => void; onRemove: (i: number) => void;
}) {
  const accs = lines.map((l) => (l.accountId ? byId.get(l.accountId) : undefined));
  const showCurrency = accs.some((a) => a?.isForeignCurrency);
  const showMaterial = accs.some((a) => a?.isMaterial);
  const showPartner = accs.some((a) => isCompanyCategory(a?.categoryId));
  return (
    <div className="flex flex-col rounded-sm border border-slate-300 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-2 py-1">
        <span className="font-semibold text-slate-700">{title}</span>
        <Button variant="ghost" className="h-6 px-2" icon={<Plus className="size-3.5" />} onClick={onAdd}>
          Ред
        </Button>
      </div>
      <table className="grid-table">
        <thead>
          <tr>
            <th className="w-[40%]">Сметка</th>
            <th className="w-28 text-right">Сума</th>
            {showPartner && <th>Партньор</th>}
            {showCurrency && <th className="w-24 text-right">Вал. сума</th>}
            {showCurrency && <th className="w-20 text-right">Курс</th>}
            {showCurrency && <th className="w-20 text-right">Фиксинг</th>}
            {showMaterial && <th className="w-20 text-right">Кол.</th>}
            {showMaterial && <th className="w-20 text-right">Цена</th>}
            <th className="w-20">ДДС</th>
            <th className="w-7" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const a = accs[i];
            const amountBad = !!l.accountId && !parseAmount(l.amount);
            return (
              <tr key={i}>
                <td className="p-0.5">
                  <AccountPicker value={l.accountId} onChange={(acc) => onChange(i, { accountId: acc?.id ?? null })} />
                </td>
                <td className="p-0.5">
                  <TextInput className={cx('num', amountBad && 'border-amber-400')} value={l.amount} inputMode="decimal" onChange={(e) => onChange(i, { amount: e.target.value })} onBlur={() => l.amount && parseAmount(l.amount) && onChange(i, { amount: toAmountInput(parseAmount(l.amount)!.toFixed(2)) })} />
                </td>
                {showPartner && (
                  <td className="p-0.5">
                    {isCompanyCategory(a?.categoryId) ? (
                      <PartnerPicker value={l.companyId ?? headerCompanyId} valueName={l.companyName} onChange={(p) => onChange(i, { companyId: p?.id ?? null, companyName: p?.name ?? null })} />
                    ) : null}
                  </td>
                )}
                {showCurrency && (
                  <td className="p-0.5">{a?.isForeignCurrency && <TextInput className="num" value={l.currencyAmount} inputMode="decimal" onChange={(e) => onChange(i, { currencyAmount: e.target.value })} />}</td>
                )}
                {showCurrency && (
                  <td className="p-0.5">{a?.isForeignCurrency && <TextInput className="num" value={l.exchangeRate} inputMode="decimal" onChange={(e) => onChange(i, { exchangeRate: e.target.value })} />}</td>
                )}
                {showCurrency && (
                  <td className="p-0.5">{a?.isForeignCurrency && <TextInput className="num" value={l.fixedRate} inputMode="decimal" aria-label={`Фиксинг ${title} ${i + 1}`} onChange={(e) => onChange(i, { fixedRate: e.target.value })} />}</td>
                )}
                {showMaterial && <td className="p-0.5">{a?.isMaterial && <TextInput className="num" value={l.quantity} inputMode="decimal" onChange={(e) => onChange(i, { quantity: e.target.value })} />}</td>}
                {showMaterial && <td className="p-0.5">{a?.isMaterial && <TextInput className="num" value={l.price} inputMode="decimal" onChange={(e) => onChange(i, { price: e.target.value })} />}</td>}
                <td className="p-0.5">
                  <Select value={l.vatTermId ?? ''} onChange={(e) => onChange(i, { vatTermId: e.target.value ? Number(e.target.value) : null })} className="px-1">
                    <option value="" />
                    {vatTerms.map((v) => (
                      <option key={v.id} value={v.id} title={v.description}>
                        {v.description}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="p-0.5 text-center">
                  <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => onRemove(i)} aria-label="Изтрий ред" tabIndex={-1}>
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Общо</td>
            <td className="num">{formatMoney(total)}</td>
            <td colSpan={8} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function fromServer(e: Record<string, unknown>): Draft {
  const lines = (arr: unknown) =>
    ((arr as Record<string, string | number | null>[]) ?? []).map((l) => ({
      accountId: (l.accountId as number) ?? null,
      amount: toAmountInput(l.amount as string),
      companyId: (l.companyId as number) ?? null,
      companyName: (l.companyName as string) ?? null,
      currencyAmount: toInput(l.currencyAmount as string),
      exchangeRate: toInput(l.exchangeRate as string),
      fixedRate: toInput(l.fixedRate as string),
      quantity: toInput(l.quantity as string),
      price: toInput(l.price as string),
      description: (l.description as string) ?? '',
      vatTermId: (l.vatTermId as number) ?? null,
    }));
  const s = (k: string) => ((e[k] as string | null) ?? '');
  return {
    id: e.id as number | undefined,
    version: (e.version as string | undefined) ?? undefined,
    number: s('number'),
    accountingDate: s('accountingDate'),
    documentDate: s('documentDate'),
    documentTypeId: (e.documentTypeId as number) ?? null,
    documentNumber: s('documentNumber'),
    companyId: (e.companyId as number) ?? null,
    companyName: (e.companyName as string) ?? null,
    term: s('term'),
    reference: s('reference'),
    optionalReference: s('optionalReference'),
    paragraph: s('paragraph'),
    transactionTypeId: (e.transactionTypeId as number) ?? 1,
    viesId: (e.viesId as number) ?? null,
    viesMonth: s('viesMonth'),
    dueDate: s('dueDate'),
    isInitialBalance: !!e.isInitialBalance,
    source: (e.source as string) ?? undefined,
    debits: lines(e.debits).length ? lines(e.debits) : [emptyLine()],
    credits: lines(e.credits).length ? lines(e.credits) : [emptyLine()],
  };
}

function addDays(date: string, days: number) {
  const dt = new Date(date + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

