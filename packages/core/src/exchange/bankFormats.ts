import { dec, round2 } from '../money.ts';
import { normalizeIban } from '../validators.ts';
import { child, children, descendants, parseXml, pathText, type XmlElement } from './xml.ts';
import { fromOADate, parseImportDate, parseDecimalText } from './messages.ts';
import { hasClass, htmlChild, htmlDescendants, htmlTableRows, htmlText, parseHtml, type HtmlCell } from './html.ts';

/**
 * Bank statement files (spec 04b 1.3, 1.13). Every bank has a "model"
 * (the named properties of a statement row, which are also the properties
 * the posting-rule conditions refer to) and a mapper that derives the
 * direction, partner and reason from the model (the table in 1.3).
 *
 * Readers turn a file into model rows:
 *  - ISO 20022 camt.053 XML (Paysera and any bank exporting camt.053),
 *  - SWIFT MT940,
 *  - DSK "AccountMovementsResult" XML and BAKB "AccountsMovements" XML,
 *  - HTML exports of DSK, Allianz, Fibank, Municipal, OBB, Raiffeisen and Unicredit,
 *  - delimited text (CSV/TXT: `;`, `,`, tab or `|`; OBB's `'/` line joins),
 *  - spreadsheet tables (the server reads xlsx sheets into string grids).
 * Delimited files and sheets are read by their header row: a column is bound
 * to a model property by the property name or one of its captions.
 */

export interface BankModelProperty {
  name: string;
  caption: string;
  kind: 'text' | 'amount' | 'date';
  /** Header captions accepted for this property (case-insensitive). */
  aliases?: string[];
}

export interface BankStatementRow {
  index: number;
  /** yyyy-mm-dd (from the model's date property). */
  date: string;
  /** Inflow: money received, the bank account is debited (IsAccountInDebit). */
  isInflow: boolean;
  /** Amount in the account currency, positive. */
  amount: string;
  /** Amount in base currency when the file carries both (Fibank, Postbank). */
  baseAmount?: string;
  partnerIban: string;
  partnerName: string;
  reason: string;
  reference: string;
  /** Model properties for the condition language (DebitAmount, CreditAmount, Reason, ...). */
  props: Record<string, string>;
}

export interface ParsedStatement {
  format: string;
  model: string;
  iban?: string;
  currency?: string;
  from?: string;
  to?: string;
  openingBalance?: string;
  closingBalance?: string;
  rows: BankStatementRow[];
}

type Model = Record<string, string>;

interface BankMapperDef {
  /** Model id (Delta mapper name). */
  id: string;
  title: string;
  /** BIC codes served by this mapper (ImportBankStatementFactory). */
  bankCodes: string[];
  properties: BankModelProperty[];
  dateProperty: string;
  map: (m: Model) => { isInflow: boolean; amount: string; baseAmount?: string; partnerIban: string; partnerName: string; reason: string; reference: string };
}

const P = (name: string, caption: string, kind: BankModelProperty['kind'] = 'text', aliases: string[] = []): BankModelProperty => ({ name, caption, kind, aliases });
const amt = (v: string | undefined) => {
  const t = v ? parseDecimalText(v.replace(/'/g, '')) : null;
  return t === null ? null : dec(t);
};
const has = (v: string | undefined) => {
  const a = amt(v);
  return a !== null && !a.isZero();
};
const abs = (v: string | undefined) => (amt(v) ?? dec(0)).abs().toFixed(2);
const pick = (...vals: (string | undefined)[]) => vals.find((v) => v !== undefined && v.trim() !== '')?.trim() ?? '';
const join = (...vals: (string | undefined)[]) => vals.map((v) => v?.trim() ?? '').filter(Boolean).join(' ');

const COMMON = [P('Date', 'Дата', 'date', ['дата', 'дата на операцията', 'дата на движение', 'дата на плащане', 'booking date', 'trn. date', 'date']), P('ValueDate', 'Вальор', 'date', ['вальор', 'дата вальор', 'val. date', 'value date']), P('DocRegNumber', 'Номер', 'text', ['номер', 'референция', 'reference no', 'reference', 'документ'])];
const DR_CR = [P('DebitAmount', 'Дебит', 'amount', ['дебит', 'дт', 'debit', 'сума дебит', 'debit amount', 'изходящи', 'разход']), P('CreditAmount', 'Кредит', 'amount', ['кредит', 'кт', 'credit', 'сума кредит', 'credit amount', 'входящи', 'приход'])];
const OPPOSITE = [P('OppositeSideAccount', 'IBAN на контрагента', 'text', ['iban', 'сметка на контрагента', 'iban на контрагента', 'насрещна сметка']), P('OppositeSideName', 'Контрагент', 'text', ['контрагент', 'наредител/получател', 'наредител / получател', 'beneficiary', 'payer', 'партньор', 'име на контрагента'])];
const REASON = P('Reason', 'Основание', 'text', ['основание', 'основание за плащане', 'описание', 'details of payment', 'description', 'детайли']);

/** Direction of a DEBIT/CREDIT model (DSK, Raiffeisen, Investbank, Procredit): amount from whichever cell parses. */
function drCr(m: Model) {
  const debit = amt(m.DebitAmount);
  return { debit: debit !== null && !debit.isZero() };
}

export const BANK_MAPPERS: BankMapperDef[] = [
  {
    id: 'DSK', title: 'Банка ДСК', bankCodes: ['STSABGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Вид движение', 'text', ['вид', 'тип', 'дт/кт', 'debit/credit']), ...DR_CR, ...OPPOSITE, REASON],
    map: (m) => {
      const mt = (m.MovementType ?? '').trim().toUpperCase() || (drCr(m).debit ? 'DEBIT' : 'CREDIT');
      const inflow = mt !== 'DEBIT';
      return { isInflow: inflow, amount: inflow ? abs(m.CreditAmount || m.Amount) : abs(m.DebitAmount || m.Amount), partnerIban: pick(m.OppositeSideAccount), partnerName: pick(m.OppositeSideName), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Allianz', title: 'Алианц Банк', bankCodes: ['BUINBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Дт/Кт', 'text', ['dtkt', 'дт/кт', 'вид']), P('Amount', 'Сума', 'amount', ['сума', 'amount']), P('More', 'Сметка', 'text', ['iban', 'сметка']), P('Beneficiary', 'Наредител/Получател', 'text', ['beneficiary', 'payer', 'наредител/получател']), P('PaymentDetails', 'Основание', 'text', ['основание', 'details of payment']), P('AdditionalExplanation', 'Допълнително пояснение', 'text', ['additional explanation', 'допълнително пояснение'])],
    map: (m) => ({ isInflow: (m.MovementType ?? '').trim().toUpperCase() !== 'D', amount: abs(m.Amount), partnerIban: pick(m.More), partnerName: pick(m.Beneficiary), reason: join(m.PaymentDetails, m.AdditionalExplanation), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'Asset', title: 'Интернешънъл Асет Банк', bankCodes: ['IABGBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Дт/Кт', 'text', ['дт/кт', 'вид']), P('Amount', 'Сума', 'amount', ['сума']), P('IBAN', 'IBAN', 'text', ['iban']), P('CompanyName', 'Контрагент', 'text', ['контрагент', 'име']), P('Term', 'Основание', 'text', ['основание'])],
    map: (m) => ({ isInflow: (m.MovementType ?? '').trim() === 'Кт', amount: abs(m.Amount), partnerIban: pick(m.IBAN), partnerName: pick(m.CompanyName), reason: pick(m.Term), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'BAKB', title: 'Българо-американска кредитна банка', bankCodes: ['BGUSBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Type', 'Тип', 'text', ['тип', 'type']), P('Amount', 'Сума', 'amount', ['сума', 'amount']), ...DR_CR, P('BeneficiaryAccount', 'Сметка на контрагента', 'text', ['iban', 'beneficiary account']), P('BeneficiaryName', 'Контрагент', 'text', ['контрагент', 'beneficiary name']), REASON],
    map: (m) => {
      const type = (m.Type ?? '').trim();
      const inflow = type ? type.toUpperCase() === 'C' : !has(m.DebitAmount);
      return { isInflow: inflow, amount: inflow ? abs(pick(m.CreditAmount, m.Amount)) : abs(pick(m.DebitAmount, m.Amount)), partnerIban: pick(m.BeneficiaryAccount), partnerName: pick(m.BeneficiaryName), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'CKB', title: 'Централна кооперативна банка', bankCodes: ['CECBBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Income', 'Приход', 'amount', ['приход', 'кредит']), P('Expence', 'Разход', 'amount', ['разход', 'дебит']), P('RecipientIBAN', 'IBAN', 'text', ['iban', 'сметка']), P('Recipient', 'Контрагент', 'text', ['контрагент', 'получател', 'наредител']), REASON],
    map: (m) => {
      const inflow = !has(m.Expence);
      return { isInflow: inflow, amount: inflow ? abs(m.Income) : abs(m.Expence), partnerIban: pick(m.RecipientIBAN), partnerName: pick(m.Recipient), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'DBank', title: 'Търговска банка Д', bankCodes: ['DEMIBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Receipts', 'Постъпления', 'amount', ['постъпления', 'кредит']), P('Payments', 'Плащания', 'amount', ['плащания', 'дебит']), P('IBAN', 'IBAN', 'text', ['iban']), P('Partner', 'Контрагент', 'text', ['контрагент', 'партньор']), REASON],
    map: (m) => {
      const inflow = !has(m.Payments);
      return { isInflow: inflow, amount: inflow ? abs(m.Receipts) : abs(m.Payments), partnerIban: pick(m.IBAN), partnerName: pick(m.Partner), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Easypay', title: 'Изипей', bankCodes: ['ESPYBGS1'], dateProperty: 'Date',
    properties: [...COMMON, P('Income', 'Приход', 'amount', ['приход']), P('Outcome', 'Разход', 'amount', ['разход']), P('PartnerName', 'Контрагент', 'text', ['контрагент']), P('Description', 'Описание', 'text', ['описание', 'основание']), P('AdditionalDescription', 'Допълнително описание', 'text', ['допълнително описание'])],
    map: (m) => {
      const inflow = !has(m.Outcome);
      const extra = /([A-Z]{2}\d{2}[A-Z0-9]{10,30})/.exec(m.AdditionalDescription ?? '');
      return { isInflow: inflow, amount: inflow ? abs(m.Income) : abs(m.Outcome), partnerIban: extra?.[1] ?? '', partnerName: pick(m.PartnerName), reason: pick(m.Description), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Fibank', title: 'Първа инвестиционна банка', bankCodes: ['FINVBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('DebitTov', 'Дебит (лв.)', 'amount', ['дебит', 'debit']), P('CreditTov', 'Кредит (лв.)', 'amount', ['кредит', 'credit']), P('Amount', 'Сума във валута', 'amount', ['сума във валута', 'amount']), P('RecipientAccount', 'Сметка на контрагента', 'text', ['iban', 'сметка']), P('RecipientName', 'Контрагент', 'text', ['контрагент', 'получател', 'наредител']), P('Description', 'Описание', 'text', ['описание', 'основание'])],
    map: (m) => {
      const inflow = !has(m.DebitTov);
      const base = inflow ? abs(m.CreditTov) : abs(m.DebitTov);
      return { isInflow: inflow, amount: has(m.Amount) ? abs(m.Amount) : base, baseAmount: base, partnerIban: pick(m.RecipientAccount), partnerName: pick(m.RecipientName), reason: pick(m.Description), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Investbank', title: 'Инвестбанк', bankCodes: ['IORTBGSF'], dateProperty: 'Date',
    properties: [...COMMON, ...DR_CR, ...OPPOSITE, REASON],
    map: (m) => {
      const inflow = has(m.CreditAmount);
      return { isInflow: inflow, amount: inflow ? abs(m.CreditAmount) : abs(m.DebitAmount), partnerIban: pick(m.OppositeSideAccount), partnerName: pick(m.OppositeSideName), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Municipal', title: 'Общинска банка', bankCodes: ['SOMBBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('DtKt', 'DtKt', 'text', ['dtkt', 'дт/кт']), P('Amount', 'Сума', 'amount', ['сума', 'amount']), P('IBAN', 'IBAN', 'text', ['iban']), P('Beneficiary', 'Контрагент', 'text', ['beneficiary', 'контрагент']), P('Description', 'Описание', 'text', ['описание', 'основание', 'details of payment'])],
    map: (m) => ({ isInflow: (m.DtKt ?? '').trim().toUpperCase() === 'K', amount: abs(m.Amount), partnerIban: pick(m.IBAN), partnerName: pick(m.Beneficiary), reason: pick(m.Description), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'MyPOS', title: 'myPOS', bankCodes: ['INTFBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Amount', 'Сума', 'amount', ['сума', 'amount']), P('IBAN', 'IBAN', 'text', ['iban']), P('CompanyName', 'Контрагент', 'text', ['контрагент', 'company name', 'name']), P('Description', 'Описание', 'text', ['описание', 'description', 'основание'])],
    map: (m) => {
      const iban = /[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}/.exec((m.IBAN ?? '').toUpperCase().replace(/\s/g, ''));
      return { isInflow: (amt(m.Amount) ?? dec(0)).greaterThan(0), amount: abs(m.Amount), partnerIban: iban?.[0] ?? '', partnerName: pick(m.CompanyName), reason: pick(m.Description), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'OBB', title: 'Обединена българска банка', bankCodes: ['UBBSBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('DebitSum', 'Дебит', 'amount', ['дебит']), P('CreditSum', 'Кредит', 'amount', ['кредит']), P('OppositeSideIBAN', 'IBAN на контрагента', 'text', ['iban']), P('OppositeSideName', 'Контрагент', 'text', ['контрагент']), P('PaymentTerm', 'Основание', 'text', ['основание']), P('AddtionalInfo', 'Допълнителна информация', 'text', ['допълнителна информация', 'пояснение'])],
    map: (m) => {
      const inflow = (m.CreditSum ?? '').trim() !== '' && has(m.CreditSum);
      return { isInflow: inflow, amount: inflow ? abs(m.CreditSum) : abs(m.DebitSum), partnerIban: pick(m.OppositeSideIBAN), partnerName: pick(m.OppositeSideName), reason: join(m.PaymentTerm, m.AddtionalInfo), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Paysera', title: 'Paysera', bankCodes: ['EVIULT2V'], dateProperty: 'Date',
    properties: [...COMMON, P('CdtDbtInd', 'Д/К', 'text', ['cdtdbtind', 'д/к']), P('Amt', 'Сума', 'amount', ['amt', 'сума']), P('CounterpartyIBAN', 'IBAN на контрагента', 'text', ['iban']), P('CounterpartyName', 'Контрагент', 'text', ['контрагент', 'cdtr.nm', 'name']), P('Ustrd', 'Основание', 'text', ['ustrd', 'основание', 'rmtinf.ustrd'])],
    map: (m) => ({ isInflow: (m.CdtDbtInd ?? '').trim() !== 'Д', amount: abs(m.Amt), partnerIban: pick(m.CounterpartyIBAN), partnerName: pick(m.CounterpartyName), reason: pick(m.Ustrd), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'Postbank', title: 'Юробанк България (Пощенска банка)', bankCodes: ['BPBIBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Type', 'Тип', 'text', ['тип', 'вид']), P('Amount', 'Сума', 'amount', ['сума']), P('AmountInEUR', 'Сума в основна валута', 'amount', ['сума в основна валута', 'amount in eur']), P('IBAN', 'IBAN', 'text', ['iban']), P('Receiver', 'Контрагент', 'text', ['контрагент', 'получател', 'наредител']), P('Description', 'Основание', 'text', ['основание', 'описание'])],
    map: (m) => ({ isInflow: (m.Type ?? '').trim() === 'Приход', amount: abs(m.Amount), baseAmount: has(m.AmountInEUR) ? round2(abs(m.AmountInEUR)).toFixed(2) : undefined, partnerIban: pick(m.IBAN), partnerName: pick(m.Receiver), reason: pick(m.Description), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'Procredit', title: 'ПроКредит Банк', bankCodes: ['PRCBBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Дт/Кт', 'text', ['дт/кт', 'вид']), P('Amount', 'Сума', 'amount', ['сума']), P('ForeignAmount', 'Сума във валута', 'amount', ['сума във валута']), P('PartnerIBAN', 'IBAN', 'text', ['iban']), P('PartnerName', 'Контрагент', 'text', ['контрагент']), REASON],
    map: (m) => ({ isInflow: (m.MovementType ?? '').trim().toUpperCase() !== 'ДТ', amount: has(m.ForeignAmount) ? abs(m.ForeignAmount) : abs(m.Amount), baseAmount: has(m.ForeignAmount) ? abs(m.Amount) : undefined, partnerIban: pick(m.PartnerIBAN), partnerName: pick(m.PartnerName), reason: pick(m.Reason), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'Raiffeisen', title: 'Райфайзенбанк (KBC)', bankCodes: ['RZBBBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Вид движение', 'text', ['вид движение', 'вид']), P('Amount', 'Сума', 'amount', ['сума', 'amount']), ...OPPOSITE, P('Narrative', 'Основание', 'text', ['основание', 'narrative']), P('DescriptionAdditional', 'Допълнително описание', 'text', ['допълнително описание'])],
    map: (m) => {
      const a = amt(m.Amount) ?? dec(0);
      const mt = (m.MovementType ?? '').trim().toUpperCase() || (a.isNegative() ? 'DEBIT' : 'CREDIT');
      return { isInflow: mt !== 'DEBIT', amount: a.abs().toFixed(2), partnerIban: pick((m.OppositeSideAccount ?? '').split('-')[0]), partnerName: pick(m.OppositeSideName), reason: join(m.Narrative, m.DescriptionAdditional), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Teksim', title: 'Тексим Банк', bankCodes: ['TEXIBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Debit', 'Дебит', 'amount', ['дебит']), P('Credit', 'Кредит', 'amount', ['кредит']), P('IBAN', 'IBAN', 'text', ['iban']), P('Name', 'Контрагент', 'text', ['контрагент', 'име']), P('Description', 'Основание', 'text', ['основание', 'описание'])],
    map: (m) => {
      const inflow = !has(m.Debit);
      return { isInflow: inflow, amount: inflow ? abs(m.Credit) : abs(m.Debit), partnerIban: pick(m.IBAN), partnerName: pick(m.Name), reason: pick(m.Description), reference: pick(m.DocRegNumber) };
    },
  },
  {
    id: 'Unicredit', title: 'УниКредит Булбанк', bankCodes: ['UNCRBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Вид', 'text', ['вид', 'дт/кт', 'dr/cr']), P('AmountInMovementCCY', 'Сума', 'amount', ['сума', 'amount']), ...OPPOSITE, REASON, P('ReasonI02', 'Основание 2', 'text', ['основание 2', 'допълнително основание'])],
    map: (m) => ({ isInflow: !['ДТ', 'DR'].includes((m.MovementType ?? '').trim().toUpperCase()), amount: abs(m.AmountInMovementCCY), partnerIban: pick(m.OppositeSideAccount), partnerName: pick(m.OppositeSideName), reason: join(m.Reason, m.ReasonI02), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'Zirat', title: 'Т.Р. Зираат Банкасъ', bankCodes: ['TCZBBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('Debit', 'Дебит', 'amount', ['дебит']), P('Credit', 'Кредит', 'amount', ['кредит']), P('RecipientIBAN', 'IBAN', 'text', ['iban']), P('RecipientName', 'Контрагент', 'text', ['контрагент']), REASON],
    map: (m) => {
      const inflow = (m.Credit ?? '').trim() !== '' && has(m.Credit);
      return { isInflow: inflow, amount: inflow ? abs(m.Credit) : abs(m.Debit), partnerIban: pick(m.RecipientIBAN), partnerName: pick(m.RecipientName), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
  {
    // ISO 20022 camt.053 / SWIFT MT940 from any bank (counterparty by direction).
    id: 'Standard', title: 'camt.053 / MT940', bankCodes: [], dateProperty: 'Date',
    properties: [...COMMON, P('CdtDbtInd', 'CRDT/DBIT', 'text', ['cdtdbtind', 'mark']), P('Amount', 'Сума', 'amount', ['сума', 'amount']), ...DR_CR, ...OPPOSITE, REASON],
    map: (m) => {
      const ind = (m.CdtDbtInd ?? '').trim().toUpperCase();
      return { isInflow: ind === 'CRDT' || ind === 'C' || ind === 'RD', amount: abs(m.Amount), partnerIban: pick(m.OppositeSideAccount), partnerName: pick(m.OppositeSideName), reason: pick(m.Reason), reference: pick(m.DocRegNumber) };
    },
  },
];

const MAPPER_BY_ID = new Map(BANK_MAPPERS.map((m) => [m.id, m]));

/** Mapper of a bank (by BIC); unknown banks use the header-driven "Standard" model. */
export function mapperForBank(bankCode: string | null | undefined): BankMapperDef {
  const code = (bankCode ?? '').toUpperCase();
  // The first four BIC characters are the bank code (IBAN chars 5-8).
  return BANK_MAPPERS.find((m) => code.length >= 4 && m.bankCodes.some((c) => c.slice(0, 4) === code.slice(0, 4))) ?? MAPPER_BY_ID.get('Standard')!;
}

export function bankModelProperties(bankCode: string | null | undefined): BankModelProperty[] {
  return mapperForBank(bankCode).properties;
}

function toRow(mapper: BankMapperDef, m: Model, index: number): BankStatementRow | null {
  const dateRaw = m[mapper.dateProperty] ?? m.Date ?? '';
  const date = parseStatementDate(dateRaw);
  if (!date) return null;
  const r = mapper.map(m);
  if (dec(r.amount).isZero() && dec(r.baseAmount ?? '0').isZero()) return null;
  const props: Record<string, string> = { ...m };
  // Common properties every rule may use (03a 9.3).
  props.DebitAmount = m.DebitAmount ?? (r.isInflow ? '0' : r.amount);
  props.CreditAmount = m.CreditAmount ?? (r.isInflow ? r.amount : '0');
  props.Reason = m.Reason ?? r.reason;
  props.OppositeSideName = m.OppositeSideName ?? r.partnerName;
  props.OppositeSideAccount = m.OppositeSideAccount ?? r.partnerIban;
  props.TransactionType = m.TransactionType ?? (r.isInflow ? 'CREDIT' : 'DEBIT');
  return { index, date, isInflow: r.isInflow, amount: r.amount, baseAmount: r.baseAmount, partnerIban: r.partnerIban ? normalizeIban(r.partnerIban) : '', partnerName: r.partnerName, reason: r.reason, reference: r.reference, props };
}

export function parseStatementDate(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (/^\d{5}(\.\d+)?$/.test(t)) return fromOADate(Number(t));
  const iso = parseImportDate(t);
  if (iso) return iso;
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(t); // YYMMDD (MT940)
  if (m) return parseImportDate(`${m[3]}.${m[2]}.20${m[1]}`);
  return null;
}

// ---------------------------------------------------------------------------
// Readers

/** Header-driven table (CSV/TXT/sheet): first row whose cells bind to >= 3 properties is the header. */
export function parseStatementTable(rows: string[][], bankCode: string | null | undefined, format = 'table'): ParsedStatement {
  const mapper = mapperForBank(bankCode);
  const lookup = new Map<string, string>();
  for (const p of mapper.properties) {
    lookup.set(p.name.toLowerCase(), p.name);
    lookup.set(p.caption.toLowerCase(), p.name);
    for (const a of p.aliases ?? []) if (!lookup.has(a.toLowerCase())) lookup.set(a.toLowerCase(), p.name);
  }
  let headerAt = -1;
  let binding: (string | null)[] = [];
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const b = rows[r]!.map((c) => lookup.get(c.trim().toLowerCase().replace(/\s+/g, ' ')) ?? null);
    const used = new Set(b.filter(Boolean));
    if (used.size >= 3 && used.has(mapper.dateProperty)) {
      headerAt = r;
      binding = b.map((x, i) => (x && b.indexOf(x) === i ? x : null));
      break;
    }
  }
  const out: BankStatementRow[] = [];
  if (headerAt < 0) return { format, model: mapper.id, rows: out };
  const other: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    if (r <= headerAt) {
      if (r < headerAt) other.push(r);
      continue;
    }
    const cells = rows[r]!;
    if (!cells.some((c) => c.trim())) continue;
    const m: Model = {};
    binding.forEach((name, i) => {
      if (name) m[name] = (cells[i] ?? '').trim();
    });
    const row = toRow(mapper, m, out.length);
    if (row) out.push(row);
    else other.push(r);
  }
  return withPeriod({ format, model: mapper.id, ...readStatementHeader(rows, other, mapper.id), rows: out });
}

// ---------------------------------------------------------------------------
// Statement header data of Excel/CSV files (1.3 "Header metadata", 1.4)

export interface StatementHeader {
  iban?: string;
  currency?: string;
  from?: string;
  to?: string;
  openingBalance?: string;
  closingBalance?: string;
}

const ISO_CURRENCIES = new Set(['BGN', 'EUR', 'USD', 'GBP', 'CHF', 'RON', 'TRY', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RUB', 'CNY', 'RSD', 'MKD']);
const IBAN_TOKEN = /^[A-Z]{2}\d{2}[A-Z]{4}[A-Z0-9]{8,26}$/;
const DATE_TOKEN = /\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g;
const OPENING = /начално салдо|старо салдо|начален баланс|салдо в началото|opening balance|beginning balance/i;
const CLOSING = /крайно салдо|ново салдо|краен баланс|салдо в края|closing balance|ending balance/i;
const PERIOD = /период|period|от дата|from date|за периода/i;

/** Header rows (1-based) where a bank's Excel layout keeps period and currency (1.3); others: every row above the table. */
const HEADER_ROWS: Record<string, number[]> = {
  Allianz: [3, 4], Asset: [9], Investbank: [6, 10], Zirat: [5, 8], Procredit: [2, 3], Teksim: [2, 3],
};

const cellAt = (rows: string[][], row1: number, col: number) => (rows[row1 - 1]?.[col] ?? '').trim();
const tokens = (t: string) => t.toUpperCase().split(/[\s,;:()]+/).filter(Boolean);
const ibanIn = (t: string) => tokens(t).find((x) => IBAN_TOKEN.test(x));
const datesIn = (t: string) => [...t.matchAll(DATE_TOKEN)].map((m) => parseImportDate(m[0])).filter((d): d is string => !!d);
const amountText = (t: string) => {
  const v = parseDecimalText(t.replace(/[^\d,.\-+\s]/g, ''));
  return v === null ? undefined : dec(v).toFixed(2);
};

function currencyIn(t: string, afterIban?: string): string | undefined {
  const paren = /\(([A-Z]{3})\)/.exec(t.toUpperCase()); // Postbank "(EUR)"
  if (paren && ISO_CURRENCIES.has(paren[1]!)) return paren[1];
  const tok = tokens(t);
  if (afterIban) {
    const i = tok.indexOf(afterIban);
    if (i >= 0 && ISO_CURRENCIES.has(tok[i + 1] ?? '')) return tok[i + 1];
  }
  if (/валута|currency/i.test(t)) return tok.find((x) => ISO_CURRENCIES.has(x));
  return undefined;
}

/**
 * Reads the statement header block: IBAN, currency, period and balances.
 * DSK has fixed cells (col A rows 3-10: client block ending with the account
 * "IBAN CUR"; col B rows 12-17: start, end, BeginSum, TurnoverDR, TurnoverCR,
 * EndSum). Other layouts are scanned by content in the bank's header rows, or
 * in every row outside the movements table: an IBAN token, the currency by
 * caption, "(XXX)" or after the IBAN, the period (a "Период" cell or the last
 * two dates) and balances by caption ("Начално/Старо салдо", "Крайно/Ново салдо").
 */
export function readStatementHeader(rows: string[][], otherRows: number[], mapperId: string): StatementHeader {
  const h: StatementHeader = {};
  if (mapperId === 'DSK') {
    for (let r = 3; r <= 10; r++) {
      const t = cellAt(rows, r, 0);
      const iban = ibanIn(t);
      if (iban) {
        h.iban = iban;
        h.currency = currencyIn(t, iban);
      }
    }
    const d1 = parseImportDate(cellAt(rows, 12, 1)) ?? parseStatementDate(cellAt(rows, 12, 1));
    const d2 = parseImportDate(cellAt(rows, 13, 1)) ?? parseStatementDate(cellAt(rows, 13, 1));
    if (d1 && d2) {
      h.from = d1;
      h.to = d2;
      h.openingBalance = amountText(cellAt(rows, 14, 1));
      h.closingBalance = amountText(cellAt(rows, 17, 1));
      return h;
    }
  }
  const scan = HEADER_ROWS[mapperId]?.map((r) => r - 1) ?? otherRows;
  const scanSet = new Set([...scan, ...otherRows]);
  const dates: string[] = [];
  for (const r of [...scanSet].sort((a, b) => a - b)) {
    const cells = rows[r] ?? [];
    const inHeader = scan.includes(r);
    cells.forEach((raw, i) => {
      const t = raw.trim();
      if (!t) return;
      const iban = ibanIn(t);
      if (iban && !h.iban) h.iban = iban;
      if (!h.currency) h.currency = currencyIn(t, iban) ?? (/^(валута|currency)\s*:?$/i.test(t) ? tokens(cells[i + 1] ?? '').find((x) => ISO_CURRENCIES.has(x)) : undefined);
      const next = () => cells.slice(i + 1).map((c) => amountText(c)).find((v) => v !== undefined);
      if (OPENING.test(t) && !h.openingBalance) h.openingBalance = amountText(t.replace(OPENING, '')) ?? next();
      if (CLOSING.test(t) && !h.closingBalance) h.closingBalance = amountText(t.replace(CLOSING, '')) ?? next();
      if (!inHeader) return;
      const ds = datesIn(t);
      if (PERIOD.test(t) && ds.length >= 2 && !h.from) {
        h.from = ds[0];
        h.to = ds[1];
      }
      dates.push(...ds);
    });
  }
  if (!h.from && dates.length >= 2) {
    // Zirat and the like: the last two date tokens of the header block.
    const [a, b] = dates.slice(-2) as [string, string];
    h.from = a < b ? a : b;
    h.to = a < b ? b : a;
  }
  return h;
}

function withPeriod(s: ParsedStatement): ParsedStatement {
  if (s.rows.length && (!s.from || !s.to)) {
    const dates = s.rows.map((r) => r.date).sort();
    s.from ??= dates[0];
    s.to ??= dates[dates.length - 1];
  }
  return s;
}

/** Splits delimited text; the delimiter is the most frequent of ; , tab | in the first lines. Quotes are honoured. */
export function splitDelimited(text: string, delimiter?: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sample = lines.slice(0, 20).join('\n');
  const d = delimiter ?? [';', '\t', '|', ','].map((c) => [c, sample.split(c).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const out: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"' && cur.trim() === '') q = true;
      else if (c === d) {
        cells.push(cur);
        cur = '';
      } else cur += c;
    }
    cells.push(cur);
    out.push(cells.map((x) => x.trim()));
  }
  return out;
}

/** OBB TXT: '|' separated; a line ending with "'/" continues on the next line. */
export function rejoinObbLines(text: string): string {
  return text.replace(/'\/\r?\n/g, ' ');
}

/** camt.053 (Paysera XML and generic ISO 20022). `xmlns`/`xsi` attributes are irrelevant (local names are used). */
export function parseCamt053(root: XmlElement, bankCode: string | null | undefined): ParsedStatement | null {
  const stmt = descendants(root, 'Stmt')[0];
  if (!stmt || root.local !== 'Document') return null;
  const isPaysera = mapperForBank(bankCode).id === 'Paysera';
  const iban = pathText(stmt, 'Acct', 'Id', 'IBAN');
  const currency = pathText(stmt, 'Acct', 'Ccy') ?? child(child(stmt, 'Ntry'), 'Amt')?.attrs.Ccy;
  const bal = (code: string) => {
    const b = children(stmt, 'Bal').find((x) => pathText(x, 'Tp', 'CdOrPrtry', 'Cd') === code);
    if (!b) return undefined;
    const v = dec(pathText(b, 'Amt') ?? '0');
    return (pathText(b, 'CdtDbtInd') === 'DBIT' ? v.negated() : v).toFixed(2);
  };
  const mapper = isPaysera ? MAPPER_BY_ID.get('Paysera')! : MAPPER_BY_ID.get('Standard')!;
  const rows: BankStatementRow[] = [];
  for (const n of children(stmt, 'Ntry')) {
    const ind = pathText(n, 'CdtDbtInd') ?? '';
    const tx = descendants(n, 'TxDtls')[0];
    const rp = tx ? child(tx, 'RltdPties') : undefined;
    const inflow = ind !== 'DBIT';
    const party = inflow ? 'Dbtr' : 'Cdtr';
    const name = pathText(rp, party, 'Nm') ?? pathText(rp, party, 'Pty', 'Nm') ?? '';
    const piban = pathText(rp, `${party}Acct`, 'Id', 'IBAN') ?? '';
    const ustrd = (tx ? children(child(tx, 'RmtInf'), 'Ustrd').map((u) => u.text.trim()).join(' ') : '') || pathText(n, 'AddtlNtryInf') || '';
    const ref = pathText(tx, 'Refs', 'EndToEndId') ?? pathText(n, 'NtryRef') ?? pathText(n, 'AcctSvcrRef') ?? '';
    const date = pathText(n, 'BookgDt', 'Dt') ?? pathText(n, 'BookgDt', 'DtTm')?.slice(0, 10) ?? '';
    const m: Model = isPaysera
      ? { Date: date, ValueDate: pathText(n, 'ValDt', 'Dt') ?? '', CdtDbtInd: ind === 'DBIT' ? 'Д' : 'К', Amt: pathText(n, 'Amt') ?? '0', CounterpartyIBAN: piban, CounterpartyName: name, Ustrd: ustrd, DocRegNumber: ref === 'NOTPROVIDED' ? '' : ref }
      : { Date: date, ValueDate: pathText(n, 'ValDt', 'Dt') ?? '', CdtDbtInd: ind, Amount: pathText(n, 'Amt') ?? '0', OppositeSideAccount: piban, OppositeSideName: name, Reason: ustrd, DocRegNumber: ref === 'NOTPROVIDED' ? '' : ref };
    const row = toRow(mapper, m, rows.length);
    if (row) rows.push(row);
  }
  const fr = pathText(stmt, 'FrToDt', 'FrDtTm')?.slice(0, 10);
  const to = pathText(stmt, 'FrToDt', 'ToDtTm')?.slice(0, 10);
  return withPeriod({ format: 'camt.053', model: mapper.id, iban: iban ? normalizeIban(iban) : undefined, currency, from: fr, to, openingBalance: bal('OPBD') ?? bal('PRCD'), closingBalance: bal('CLBD'), rows });
}

/** SWIFT MT940 (tags :20: :25: :28C: :60F: :61: :86: :62F:). */
export function parseMt940(text: string): ParsedStatement | null {
  if (!/:20:/.test(text) || !/:61:/.test(text)) return null;
  const mapper = MAPPER_BY_ID.get('Standard')!;
  const fields: { tag: string; value: string }[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({ tag: m[1]!, value: m[2]! });
    else if (fields.length && !/^-\}?$/.test(line.trim()) && !line.startsWith('{')) fields[fields.length - 1]!.value += '\n' + line;
  }
  let iban: string | undefined;
  let currency: string | undefined;
  let opening: string | undefined;
  let closing: string | undefined;
  const rows: BankStatementRow[] = [];
  const balance = (v: string) => {
    const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v.trim());
    if (!m) return undefined;
    currency ??= m[3];
    const a = dec(m[4]!.replace(',', '.'));
    return (m[1] === 'D' ? a.negated() : a).toFixed(2);
  };
  for (let i = 0; i < fields.length; i++) {
    const { tag, value } = fields[i]!;
    if (tag === '25') iban = normalizeIban(value.split('/').pop() ?? value);
    else if (tag === '60F' || tag === '60M') opening ??= balance(value);
    else if (tag === '62F' || tag === '62M') closing = balance(value);
    else if (tag === '61') {
      const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,]+)([A-Z][A-Z0-9]{3})?([^/\n]*)(?:\/\/([^\n]*))?/.exec(value.trim());
      if (!m) continue;
      const info = fields[i + 1]?.tag === '86' ? fields[i + 1]!.value : '';
      const sub = (code: string) => [...info.replace(/\n/g, '').matchAll(new RegExp(`\\?${code}([^?]*)`, 'g'))].map((x) => x[1]!.trim()).join('');
      const structured = info.includes('?');
      const purpose = structured ? [20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map((c) => sub(String(c))).join(' ').trim() : info.replace(/\n/g, ' ').trim();
      const name = structured ? `${sub('32')}${sub('33')}`.trim() : '';
      const acc = structured ? sub('31') || sub('38') : (/[A-Z]{2}\d{2}[A-Z0-9]{10,30}/.exec(info.replace(/\s/g, ''))?.[0] ?? '');
      const yymmdd = m[1]!;
      const model: Model = {
        Date: yymmdd, ValueDate: yymmdd, CdtDbtInd: m[3]!, Amount: m[5]!.replace(',', '.'),
        DocRegNumber: (m[8] ?? m[7] ?? '').trim(), OppositeSideAccount: acc, OppositeSideName: name, Reason: purpose,
      };
      // Entry date MMDD belongs to the value-date year.
      if (m[2]) model.Date = `${yymmdd.slice(0, 2)}${m[2]}`;
      const row = toRow(mapper, model, rows.length);
      if (row) rows.push(row);
    }
  }
  return withPeriod({ format: 'MT940', model: mapper.id, iban, currency, openingBalance: opening, closingBalance: closing, rows });
}

/** DSK XML: root AccountMovementsResult > AccountMovementsFilter, Sums, AccountMovement*. `<br/>` in texts becomes '|'. */
export function parseDskXml(text: string): ParsedStatement | null {
  let root: XmlElement;
  try {
    root = parseXml(text.replace(/<br\s*\/?>/gi, '|'));
  } catch {
    return null;
  }
  if (root.local !== 'AccountMovementsResult' || root.children[0]?.local !== 'AccountMovementsFilter' || root.children[1]?.local !== 'Sums') return null;
  const mapper = MAPPER_BY_ID.get('DSK')!;
  const f = root.children[0]!;
  const sums = root.children[1]!;
  const rows: BankStatementRow[] = [];
  for (const mv of descendants(root, 'AccountMovement')) {
    const v = (n: string) => pathText(mv, n) ?? '';
    const type = v('MovementType');
    const model: Model = {
      Date: v('ValueDate') || v('Date'), ValueDate: v('ValueDate'), DocRegNumber: v('DocRegNumber'), MovementType: type.toUpperCase() === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      DebitAmount: type.toUpperCase() === 'DEBIT' ? v('Amount') : '', CreditAmount: type.toUpperCase() === 'DEBIT' ? '' : v('Amount'),
      OppositeSideAccount: v('OppositeSideAccount'), OppositeSideName: v('OppositeSideName'), Reason: v('Reason').replace(/\|/g, ' ').trim(),
    };
    const row = toRow(mapper, model, rows.length);
    if (row) rows.push(row);
  }
  const acc = pathText(f, 'AccountNumber') ?? '';
  return withPeriod({
    format: 'DSK XML', model: 'DSK', iban: acc ? normalizeIban(acc.split(' ')[0]!) : undefined, currency: pathText(f, 'Currency') ?? acc.split(' ')[1],
    from: parseStatementDate(pathText(f, 'StartDate') ?? '') ?? undefined, to: parseStatementDate(pathText(f, 'EndDate') ?? '') ?? undefined,
    openingBalance: pathText(sums, 'BeginSum'), closingBalance: pathText(sums, 'EndSum'), rows,
  });
}

/** BAKB XML: root AccountsMovements > Movement* with Type C/D. */
export function parseBakbXml(text: string): ParsedStatement | null {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    return null;
  }
  if (root.local !== 'AccountsMovements') return null;
  const mapper = MAPPER_BY_ID.get('BAKB')!;
  const rows: BankStatementRow[] = [];
  for (const mv of descendants(root, 'Movement')) {
    const v = (n: string) => pathText(mv, n) ?? mv.attrs[n] ?? '';
    const type = v('Type').toUpperCase();
    const model: Model = {
      Date: v('Date'), ValueDate: v('ValueDate'), DocRegNumber: v('Reference'), Type: type, Amount: v('Amount'),
      CreditAmount: type === 'C' ? v('Amount') : '', DebitAmount: type === 'C' ? '' : v('Amount'),
      BeneficiaryAccount: v('BeneficiaryAccount'), BeneficiaryName: v('BeneficiaryName'), Reason: v('Reason') || v('Description'),
    };
    const row = toRow(mapper, model, rows.length);
    if (row) rows.push(row);
  }
  return withPeriod({ format: 'BAKB XML', model: 'BAKB', iban: root.attrs.IBAN ? normalizeIban(root.attrs.IBAN) : undefined, currency: root.attrs.Currency, rows });
}

// ---------------------------------------------------------------------------
// Fibank, Raiffeisen and Unicredit XML (1.13)

const lc = (s: string) => s.toLowerCase();
/** Child elements by local name, case-insensitive. */
const kid = (el: XmlElement | undefined, ...names: string[]) => el?.children.find((c) => names.some((n) => lc(c.local) === lc(n)));
const kidText = (el: XmlElement | undefined, ...names: string[]) => kid(el, ...names)?.text.trim() ?? '';
const DATE_NAMES = ['Date', 'ValueDate', 'TrnDate', 'TransactionDate', 'OperationDate', 'DateOperation', 'ProcessingDate', 'ProcessDate', 'BookingDate', 'PostingDate', 'DateTime'];
const REF_NAMES = ['DocRegNumber', 'Reference', 'RefNo', 'TrnReference', 'TransactionReference', 'DocumentNumber', 'Number'];

/** Header values found anywhere outside the movement elements, by element name. */
function xmlHeader(root: XmlElement, skip: Set<XmlElement>): StatementHeader {
  const h: StatementHeader = {};
  const visit = (el: XmlElement) => {
    if (skip.has(el)) return;
    const n = lc(el.local);
    const t = el.text.trim();
    if (t) {
      if (!h.iban && /iban|accountnumber|^account$/.test(n) && IBAN_TOKEN.test(normalizeIban(t))) h.iban = normalizeIban(t);
      else if (!h.currency && /^(currency|ccy|currencycode|valuta)$/.test(n) && ISO_CURRENCIES.has(t.toUpperCase())) h.currency = t.toUpperCase();
      else if (!h.from && /^(fromdate|startdate|datefrom|periodfrom|begindate)$/.test(n)) h.from = parseStatementDate(t) ?? undefined;
      else if (!h.to && /^(todate|enddate|dateto|periodto)$/.test(n)) h.to = parseStatementDate(t) ?? undefined;
      else if (!h.openingBalance && /^(openingbalance|beginsum|beginbalance|oldbalance|startbalance|initialbalance)$/.test(n)) h.openingBalance = amountText(t);
      else if (!h.closingBalance && /^(closingbalance|endsum|endbalance|newbalance|finalbalance)$/.test(n)) h.closingBalance = amountText(t);
    }
    el.children.forEach(visit);
  };
  visit(root);
  return h;
}

/** Leaf texts of a movement element by local name; one nested level is flattened (OperationReason.Description, MovementDocument.DescriptionAdditional). */
function flatModel(el: XmlElement): Model {
  const m: Model = {};
  for (const c of el.children) {
    if (c.children.length) {
      for (const g of c.children) if (!g.children.length) m[g.local] ??= g.text.trim();
    } else m[c.local] = c.text.trim();
  }
  return m;
}

/** Model property by case-insensitive name. */
function prop(m: Model, ...names: string[]) {
  for (const n of names) {
    const k = Object.keys(m).find((x) => lc(x) === lc(n));
    if (k !== undefined && m[k]) return m[k]!;
  }
  return '';
}

/**
 * Fibank statement XML: the file is `<ROWSET><ROW><XML>` + the statement +
 * `</XML></ROW></ROWSET>`; the inner root `statement` has `system`, `header`
 * and the movements. The spec documents the Fibank model fields (DebitTov,
 * CreditTov, Amount, OperationReason.RecipientAccount / RecipientName /
 * Description, REMIII); movement elements are the ones carrying DebitTov or
 * CreditTov, and their date is the first child named like a date.
 */
export function parseFibankXml(text: string): ParsedStatement | null {
  const t = text.trim().replace(/^<\?xml[^>]*\?>\s*/, '');
  if (!/^<ROWSET>\s*<ROW>\s*<XML>/i.test(t) || !/<\/XML>\s*<\/ROW>\s*<\/ROWSET>$/i.test(t)) return null;
  let root: XmlElement;
  try {
    root = parseXml(t.replace(/^<ROWSET>\s*<ROW>\s*<XML>/i, '').replace(/<\/XML>\s*<\/ROW>\s*<\/ROWSET>$/i, ''));
  } catch {
    return null;
  }
  if (lc(root.local) !== 'statement') return null;
  const mapper = MAPPER_BY_ID.get('Fibank')!;
  const items: XmlElement[] = [];
  const find = (el: XmlElement) => {
    if (kid(el, 'DebitTov', 'CreditTov')) items.push(el);
    else el.children.forEach(find);
  };
  find(root);
  const rows: BankStatementRow[] = [];
  for (const el of items) {
    const f = flatModel(el);
    const model: Model = {
      Date: prop(f, ...DATE_NAMES), ValueDate: prop(f, 'ValueDate', 'DateValue'), DocRegNumber: prop(f, ...REF_NAMES),
      DebitTov: prop(f, 'DebitTov'), CreditTov: prop(f, 'CreditTov'), Amount: prop(f, 'Amount'),
      RecipientAccount: prop(f, 'RecipientAccount') || kidText(kid(el, 'OperationReason'), 'RecipientAccount'),
      RecipientName: prop(f, 'RecipientName') || kidText(kid(el, 'OperationReason'), 'RecipientName'),
      Description: prop(f, 'Description') || kidText(kid(el, 'OperationReason'), 'Description'),
      TRNAccount: prop(f, 'REMIII'),
    };
    const row = toRow(mapper, model, rows.length);
    if (row) rows.push(row);
  }
  const head = xmlHeader(kid(root, 'header') ?? root, new Set(items));
  return withPeriod({ format: 'Fibank XML', model: mapper.id, ...head, rows });
}

/**
 * Raiffeisen / Unicredit data-contract XML (`d3p1:`-prefixed elements named
 * after the model properties). Movement elements are found by their
 * properties: Unicredit's carry AmountInMovementCCY, Raiffeisen's Narrative or
 * OppositeSideAccount with an Amount.
 */
export function parseDataContractXml(root: XmlElement, bankCode: string | null | undefined): ParsedStatement | null {
  const isUni = (el: XmlElement) => !!kid(el, 'AmountInMovementCCY');
  const isRzb = (el: XmlElement) => !!kid(el, 'Amount') && !!kid(el, 'Narrative', 'OppositeSideAccount');
  const items: XmlElement[] = [];
  let kind: 'Unicredit' | 'Raiffeisen' | null = null;
  const find = (el: XmlElement) => {
    const k = isUni(el) ? 'Unicredit' : isRzb(el) ? 'Raiffeisen' : null;
    if (k && (!kind || kind === k)) {
      kind = k;
      items.push(el);
    } else el.children.forEach(find);
  };
  find(root);
  if (!kind || !items.length) return null;
  const preferred = mapperForBank(bankCode).id;
  const mapper = MAPPER_BY_ID.get(preferred === 'Unicredit' || preferred === 'Raiffeisen' ? (kind === preferred ? preferred : kind) : kind)!;
  const rows: BankStatementRow[] = [];
  for (const el of items) {
    const f = flatModel(el);
    const model: Model = mapper.id === 'Unicredit'
      ? {
          Date: prop(f, ...DATE_NAMES), ValueDate: prop(f, 'ValueDate'), DocRegNumber: prop(f, ...REF_NAMES), MovementType: prop(f, 'MovementType'),
          AmountInMovementCCY: prop(f, 'AmountInMovementCCY'), OppositeSideAccount: prop(f, 'OppositeSideAccount', 'BeneficiaryAccount', 'IBAN'),
          OppositeSideName: prop(f, 'OppositeSideName', 'BeneficiaryName', 'Beneficiary'), Reason: prop(f, 'Reason'), ReasonI02: prop(f, 'ReasonI02'),
        }
      : {
          Date: prop(f, ...DATE_NAMES), ValueDate: prop(f, 'ValueDate'), DocRegNumber: prop(f, ...REF_NAMES), MovementType: prop(f, 'MovementType'),
          Amount: prop(f, 'Amount'), OppositeSideAccount: prop(f, 'OppositeSideAccount'), OppositeSideName: prop(f, 'OppositeSideName'),
          Narrative: prop(f, 'Narrative'), DescriptionAdditional: prop(f, 'DescriptionAdditional'),
        };
    const row = toRow(mapper, model, rows.length);
    if (row) rows.push(row);
  }
  return withPeriod({ format: `${mapper.id} XML`, model: mapper.id, ...xmlHeader(root, new Set(items)), rows });
}

/**
 * Text decoding: UTF-8 (with or without BOM) when valid, else windows-1251
 * (Encoding.Default on a Bulgarian Windows). An HTML file's
 * `<meta charset>` / `<meta http-equiv="Content-Type" content="...; charset=...">`
 * wins when it names an encoding the platform knows.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const meta = /<html[\s>]|<!doctype\s+html/i.test(head) ? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) : null;
  if (meta) {
    try {
      return new TextDecoder(meta[1]!.toLowerCase(), { fatal: true }).decode(bytes);
    } catch {
      // Unknown label or bytes that do not match it: fall through to the sniffing below.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/**
 * Reads any supported statement file (spreadsheets are passed as `table`).
 * Probes in order: HTML (the seven bank HTML exports), XML (Fibank, camt.053,
 * DSK, BAKB, data-contract XML), MT940, delimited text.
 */
export function parseBankStatement(input: { text?: string; table?: string[][] }, bankCode: string | null | undefined): ParsedStatement | null {
  if (input.table) {
    const s = parseStatementTable(input.table, bankCode, 'Excel');
    return s.rows.length ? s : null;
  }
  const text = input.text ?? '';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    if (isHtmlText(trimmed)) return parseHtmlStatement(text, bankCode);
    if (/^(<\?xml[^>]*\?>\s*)?<ROWSET>/i.test(trimmed)) return parseFibankXml(text);
    let root: XmlElement | null = null;
    try {
      root = parseXml(text);
    } catch {
      root = null;
    }
    if (root?.local === 'Document') return parseCamt053(root, bankCode);
    if (root?.local === 'AccountMovementsResult' || /<AccountMovementsResult/.test(text)) return parseDskXml(text);
    if (root?.local === 'AccountsMovements') return parseBakbXml(text);
    // Fibank movements XML (SYTY_BAL_CUST_MAIN > ACC, ROWSET): the spec gives only the probe, not the fields.
    if (root?.local === 'SYTY_BAL_CUST_MAIN') return null;
    if (root) return parseDataContractXml(root, bankCode);
    return null;
  }
  const mt = parseMt940(text);
  if (mt) return mt;
  const mapper = mapperForBank(bankCode);
  const prepared = mapper.id === 'OBB' ? rejoinObbLines(text) : text;
  const s = parseStatementTable(splitDelimited(prepared), bankCode, 'CSV');
  return s.rows.length ? s : null;
}

// ---------------------------------------------------------------------------
// HTML statements (1.13): DSK, Allianz, Fibank, Municipal, OBB, Raiffeisen, Unicredit

/** Mappers with an HTML statement service. */
export const HTML_STATEMENT_MAPPERS = ['DSK', 'Allianz', 'Fibank', 'Municipal', 'OBB', 'Raiffeisen', 'Unicredit'];

/** An HTML document (optionally after an XML declaration or comments). */
export function isHtmlText(text: string): boolean {
  // Skipped by hand: a regex with a repeated lazy comment group backtracks exponentially.
  let s = text.replace(/^\uFEFF/, '').trimStart();
  if (s.startsWith('<?xml')) {
    const end = s.indexOf('?>');
    if (end < 0) return false;
    s = s.slice(end + 2).trimStart();
  }
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->', 4);
    if (end < 0) return false;
    s = s.slice(end + 3).trimStart();
  }
  return /^(<!doctype\s+html|<html[\s>])/i.test(s);
}

/**
 * A money cell of an HTML statement, in any of the forms Bulgarian bank
 * exports use: "1 234,56" (space or no-break space groups), "1.234,56",
 * "1,234.56", "-12,00", "12,00-", "(12,00)", "12,00 лв.", "EUR 12.00".
 * Blank (or a cell without a number) is null: an absent amount.
 */
export function parseHtmlAmount(raw: string | undefined): string | null {
  let t = (raw ?? '').replace(/\u00a0/g, ' ').trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/\p{L}+\.?/gu, '').replace(/[\s']/g, '');
  if (/^[-\u2212]/.test(t)) {
    neg = true;
    t = t.slice(1);
  } else if (t.startsWith('+')) t = t.slice(1);
  if (/[-\u2212]$/.test(t)) {
    neg = true;
    t = t.slice(0, -1);
  }
  const comma = t.lastIndexOf(',');
  const dot = t.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    t = t.split(decimal === ',' ? '.' : ',').join('').replace(decimal, '.');
  } else if (comma >= 0) t = t.split(',').length > 2 ? t.split(',').join('') : t.replace(',', '.');
  else if (t.split('.').length > 2) t = t.split('.').join('');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const v = dec(t);
  return (neg && !v.isZero() ? v.negated() : v).toString();
}

const capNorm = (t: string) => t.toLowerCase().replace(/\u00a0/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim();

type HtmlRole = 'date' | 'valueDate' | 'reference' | 'debit' | 'credit' | 'amount' | 'dtkt' | 'counterparty' | 'payer' | 'beneficiary' | 'iban' | 'details' | 'additional' | 'balance';

/** Column captions of the movements table (HtmlImportConsts and the captions of the Excel layouts). */
const HTML_ROLE_CAPTIONS: [HtmlRole, string[]][] = [
  ['date', ['дата', 'дата на операцията', 'дата на операция', 'дата операция', 'дата на движение', 'дата на плащане', 'дата на транзакция', 'дата на осчетоводяване', 'trn. date', 'trn.date', 'trn date', 'transaction date', 'booking date', 'operation date', 'date']],
  ['valueDate', ['вальор', 'дата вальор', 'дата на вальор', 'val. date', 'val.date', 'val date', 'value date']],
  ['reference', ['референция', 'reference no', 'reference no.', 'reference', 'ref. no', 'ref no', 'номер', 'номер на документ', 'номер на операция', 'документ', '№']],
  ['debit', ['дебит', 'дт', 'debit', 'сума дебит', 'дебит сума', 'debit amount', 'изходящи', 'разход', 'плащания']],
  ['credit', ['кредит', 'кт', 'credit', 'сума кредит', 'кредит сума', 'credit amount', 'входящи', 'приход', 'постъпления']],
  ['amount', ['сума', 'amount', 'сума във валутата на сметката', 'сума във валута']],
  ['dtkt', ['dtkt', 'dt/kt', 'дт/кт', 'д/к', 'd/c', 'dr/cr', 'debit/credit', 'дебит/кредит', 'вид', 'тип', 'вид движение', 'тип на движение', 'type']],
  ['counterparty', ['контрагент', 'наредител/получател', 'получател/наредител', 'beneficiary/payer', 'payer/beneficiary', 'партньор', 'име на контрагента', 'насрещна страна']],
  ['payer', ['наредител', 'payer', 'ordering party']],
  ['beneficiary', ['получател', 'beneficiary']],
  ['iban', ['iban', 'сметка', 'сметка на контрагента', 'iban на контрагента', 'насрещна сметка', 'account', 'сметка/iban']],
  ['details', ['описание', 'основание', 'основание за плащане', 'основание на плащането', 'details of payment', 'description', 'детайли', 'narrative', 'информация']],
  ['additional', ['допълнително пояснение', 'допълнителна информация', 'допълнително описание', 'допълнително основание', 'additional explanation', 'additional information', 'additional info', 'основание 2', 'пояснение']],
  ['balance', ['салдо', 'balance', 'текущо салдо']],
];
const HTML_ROLE = new Map(HTML_ROLE_CAPTIONS.flatMap(([role, caps]) => caps.map((c) => [c, role] as const)));

type HtmlHeaderField = 'iban' | 'period' | 'from' | 'to' | 'currency' | 'opening' | 'closing' | 'turnover';
/** Header block captions (HtmlImportConsts), longest first so "оборот за периода" is not read as "период". */
const HTML_HEADER_CAPTIONS: [HtmlHeaderField, string][] = ([
  ['iban', ['отчет по сметка', 'account history', 'номер на сметка', 'iban на сметката', 'сметка', 'iban', 'номер', 'account number', 'account']],
  ['period', ['за периода', 'период', 'period']],
  ['from', ['от дата', 'from date', 'начална дата']],
  ['to', ['до дата', 'to date', 'крайна дата']],
  ['currency', ['валута', 'currency']],
  ['opening', ['старо салдо', 'начално салдо', 'opening balance']],
  ['closing', ['ново салдо', 'крайно салдо', 'closing balance']],
  ['turnover', ['оборот за периода', 'total debits', 'total credits', 'оборот', 'общо', 'total']],
] as [HtmlHeaderField, string[]][]).flatMap(([f, caps]) => caps.map((c) => [f, c] as [HtmlHeaderField, string])).sort((a, b) => b[1].length - a[1].length);

function headerCaption(text: string): { field: HtmlHeaderField; rest: string } | null {
  const n = capNorm(text);
  for (const [field, cap] of HTML_HEADER_CAPTIONS) {
    if (n === cap) return { field, rest: '' };
    if (n.startsWith(cap) && /^[\s:\u2013-]/.test(n.slice(cap.length))) return { field, rest: n.slice(cap.length).replace(/^[\s:\u2013-]+/, '').trim() };
  }
  return null;
}

/** A summary row of the movements table ("Старо салдо", "Ново салдо", "Оборот за периода", "Total debits", ...). */
const isSummaryRow = (cells: HtmlCell[]) => {
  const first = cells.find((c) => c.text.trim());
  const hit = first ? headerCaption(first.text) : null;
  return !!hit && ['opening', 'closing', 'turnover', 'period', 'from', 'to'].includes(hit.field);
};

/** Header block (1.13): caption cells; the value is the rest of the cell or the next cells (amount cells `td.amt` first). */
function readHtmlHeader(rows: HtmlCell[][]): StatementHeader {
  const h: StatementHeader = {};
  for (const cells of rows) {
    cells.forEach((cell, i) => {
      const hit = headerCaption(cell.text);
      if (!hit) return;
      const after = cells.slice(i + 1).filter((c) => c.text.trim());
      const value = hit.rest || after.map((c) => c.text).join(' ');
      const amount = () => {
        const cands = hit.rest ? [hit.rest] : [...after.filter((c) => c.classes.includes('amt')), ...after].map((c) => c.text);
        for (const c of cands) {
          const v = parseHtmlAmount(c);
          if (v !== null) return dec(v).toFixed(2);
        }
        return undefined;
      };
      switch (hit.field) {
        case 'iban': {
          const iban = ibanIn(value.replace(/\n/g, ' '));
          if (iban && !h.iban) {
            h.iban = iban;
            h.currency ??= currencyIn(value, iban);
          }
          break;
        }
        case 'period': {
          const ds = datesIn(value);
          if (ds.length >= 2 && !h.from) [h.from, h.to] = ds as [string, string];
          break;
        }
        case 'from':
          h.from ??= datesIn(value)[0];
          break;
        case 'to':
          h.to ??= datesIn(value)[0];
          break;
        case 'currency':
          h.currency ??= tokens(value).find((x) => ISO_CURRENCIES.has(x));
          break;
        case 'opening':
          h.openingBalance ??= amount();
          break;
        case 'closing':
          h.closingBalance ??= amount();
          break;
        default:
      }
    });
  }
  return h;
}

/** Movement direction from a Дт/Кт cell ("D", "Дт", "DR", "DEBIT", "K", "Кт", "CR", "CREDIT"); null when unknown. */
function dtktIsDebit(v: string): boolean | null {
  const t = v.trim().toUpperCase().replace(/\./g, '');
  if (['D', 'DT', 'DR', 'DB', 'DEBIT', 'Д', 'ДТ', 'ДЕБИТ', '-'].includes(t)) return true;
  if (['C', 'K', 'CT', 'KT', 'CR', 'CREDIT', 'К', 'КТ', 'КРЕДИТ', '+'].includes(t)) return false;
  return null;
}

/** "Name\nBG.. IBAN" cells: the IBAN token and the remaining text. */
function splitNameIban(text: string): { iban: string; rest: string } {
  const iban = ibanIn(text.replace(/\n/g, ' ')) ?? '';
  const rest = text.split('\n').map((l) => (iban ? l.split(/\s+/).filter((w) => w.toUpperCase().replace(/[,;:()]/g, '') !== iban).join(' ') : l).trim()).filter(Boolean).join(' ');
  return { iban, rest };
}

interface HtmlMovement {
  date: string;
  valueDate: string;
  reference: string;
  isDebit: boolean;
  amount: string;
  iban: string;
  name: string;
  details: string;
  additional: string;
  /** Columns captioned with the bank's own model property names. */
  props?: Model;
}

/** The bank's model (1.3 property names, so the posting-rule conditions apply unchanged) from an HTML movement. */
const HTML_MODELS: Record<string, (x: HtmlMovement) => Model> = {
  DSK: (x) => ({ MovementType: x.isDebit ? 'DEBIT' : 'CREDIT', DebitAmount: x.isDebit ? x.amount : '', CreditAmount: x.isDebit ? '' : x.amount, OppositeSideAccount: x.iban, OppositeSideName: x.name, Reason: join(x.details, x.additional) }),
  Allianz: (x) => ({ MovementType: x.isDebit ? 'D' : 'C', Amount: x.amount, More: x.iban, Beneficiary: x.name, PaymentDetails: x.details, AdditionalExplanation: x.additional }),
  Fibank: (x) => ({ DebitTov: x.isDebit ? x.amount : '', CreditTov: x.isDebit ? '' : x.amount, RecipientAccount: x.iban, RecipientName: x.name, Description: join(x.details, x.additional) }),
  Municipal: (x) => ({ DtKt: x.isDebit ? 'D' : 'K', Amount: x.amount, IBAN: x.iban, Beneficiary: x.name, Description: join(x.details, x.additional) }),
  OBB: (x) => ({ DebitSum: x.isDebit ? x.amount : '', CreditSum: x.isDebit ? '' : x.amount, OppositeSideIBAN: x.iban, OppositeSideName: x.name, PaymentTerm: x.details, AddtionalInfo: x.additional }),
  Raiffeisen: (x) => ({ MovementType: x.isDebit ? 'DEBIT' : 'CREDIT', Amount: x.amount, OppositeSideAccount: x.iban, OppositeSideName: x.name, Narrative: x.details, DescriptionAdditional: x.additional }),
  Unicredit: (x) => ({ MovementType: x.isDebit ? 'ДТ' : 'КТ', AmountInMovementCCY: x.amount, OppositeSideAccount: x.iban, OppositeSideName: x.name, Reason: x.details, ReasonI02: x.additional }),
};

const nonZero = (v: string | null) => (v !== null && !dec(v).isZero() ? v : null);
const oneLine = (t: string | undefined) => (t ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ');

/** Fibank data rows: 0 operation date, 1 reference/details block, 2 value date, 3 debit, 4 credit, 5 balance. */
function fibankHtmlMovements(rows: HtmlCell[][]): HtmlMovement[] {
  const out: HtmlMovement[] = [];
  for (const cells of rows) {
    if (cells.length <= 1 || isSummaryRow(cells)) continue;
    if (!parseStatementDate(cells[0]!.text)) continue;
    // The block: the reference, then parts separated by blank lines; the part with an IBAN is the counterparty.
    let parts = (cells[1]?.text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      const ls = parts[0]!.split('\n');
      parts = [ls[0]!, ls.slice(1).join('\n')].filter(Boolean);
    }
    const rest = parts.slice(1);
    const party = rest.find((p) => ibanIn(p.replace(/\n/g, ' ')));
    const np = party ? splitNameIban(party) : { iban: '', rest: '' };
    const debit = nonZero(parseHtmlAmount(cells[3]?.text));
    const credit = nonZero(parseHtmlAmount(cells[4]?.text));
    const value = debit ?? credit;
    if (value === null) continue;
    out.push({
      date: cells[0]!.text, valueDate: cells[2]?.text ?? '', reference: oneLine(parts[0]), isDebit: debit !== null, amount: dec(value).abs().toString(),
      iban: np.iban, name: np.rest, details: rest.filter((p) => p !== party).map(oneLine).join(' '), additional: '',
    });
  }
  return out;
}

/** Header-driven movements (the other six banks): the first row whose captions bind a date and an amount is the header. */
function tableHtmlMovements(rows: HtmlCell[][], mapper: BankMapperDef): { movements: HtmlMovement[]; headerAt: number } {
  const propLookup = new Map<string, string>();
  for (const p of mapper.properties) for (const c of [p.name, p.caption, ...(p.aliases ?? [])]) if (!propLookup.has(capNorm(c))) propLookup.set(capNorm(c), p.name);
  let headerAt = -1;
  let binding: (string | null)[] = [];
  for (let r = 0; r < Math.min(rows.length, 60); r++) {
    const cells = rows[r]!;
    if (cells.length <= 1) continue;
    const b = cells.map((c) => {
      const n = capNorm(c.text);
      const role = HTML_ROLE.get(n);
      if (role) return role;
      const p = propLookup.get(n);
      return p ? `prop:${p}` : null;
    });
    const used = new Set(b.filter(Boolean));
    // DSK's amount cells are td.amt: its header row needs no amount caption.
    if (used.size >= 3 && used.has('date') && (used.has('debit') || used.has('credit') || used.has('amount') || mapper.id === 'DSK')) {
      headerAt = r;
      binding = b.map((x, i) => (x && b.indexOf(x) === i ? x : null));
      break;
    }
  }
  const movements: HtmlMovement[] = [];
  if (headerAt < 0) return { movements, headerAt };
  const both = binding.includes('payer') && binding.includes('beneficiary');
  for (const cells of rows.slice(headerAt + 1)) {
    if (cells.length <= 1 || isSummaryRow(cells)) continue;
    const rec: Partial<Record<HtmlRole, string>> = {};
    const props: Model = {};
    binding.forEach((b, i) => {
      if (!b) return;
      const t = cells[i]?.text.trim() ?? '';
      if (b.startsWith('prop:')) props[b.slice(5)] = oneLine(t);
      else rec[b as HtmlRole] = t;
    });
    let debit = parseHtmlAmount(rec.debit);
    let credit = parseHtmlAmount(rec.credit);
    let amount = parseHtmlAmount(rec.amount);
    // DSK keeps its amounts in td.amt cells: they are used when no amount column is captioned.
    const amt = cells.filter((c) => c.classes.includes('amt')).map((c) => c.text);
    if (mapper.id === 'DSK' && debit === null && credit === null && amount === null && amt.length) {
      if (amt.length >= 2) {
        debit = parseHtmlAmount(amt[0]);
        credit = parseHtmlAmount(amt[1]);
      } else amount = parseHtmlAmount(amt[0]);
    }
    let isDebit = rec.dtkt ? dtktIsDebit(rec.dtkt) : null;
    if (isDebit === null && (nonZero(debit) || nonZero(credit))) isDebit = nonZero(debit) !== null;
    if (isDebit === null && amount !== null) isDebit = dec(amount).isNegative();
    if (isDebit === null) continue;
    const value = isDebit ? nonZero(debit) ?? amount : nonZero(credit) ?? amount;
    if (value === null) continue;
    const nameCell = rec.counterparty ?? (both ? (isDebit ? rec.beneficiary : rec.payer) : (rec.beneficiary ?? rec.payer)) ?? '';
    const fromName = splitNameIban(nameCell);
    const ibanCell = splitNameIban(rec.iban ?? '');
    movements.push({
      date: rec.date ?? '', valueDate: rec.valueDate ?? '', reference: oneLine(rec.reference), isDebit, amount: dec(value).abs().toString(),
      iban: ibanCell.iban || fromName.iban || ibanCell.rest, name: fromName.rest, details: oneLine(rec.details), additional: oneLine(rec.additional), props,
    });
  }
  return { movements, headerAt };
}

/**
 * HTML statement (1.13). The probe follows Delta's services: the document
 * must have `html/head` and `html/body` (Fibank: and no parse errors; DSK: at
 * least one `td.amt` amount cell); movements come from the first `table`,
 * rows after the header row with more than one cell, summary rows recognised
 * by their caption. Fibank's columns are fixed; the other banks' columns are
 * bound by their captions (HtmlImportConsts, Bulgarian and English) or by the
 * bank's model property names. The header block (IBAN, currency, period,
 * balances) is read by caption from every table and the text around them.
 */
export function parseHtmlStatement(text: string, bankCode: string | null | undefined): ParsedStatement | null {
  const mapper = mapperForBank(bankCode);
  if (!HTML_STATEMENT_MAPPERS.includes(mapper.id)) return null;
  const doc = parseHtml(text);
  const html = htmlChild(doc.root, 'html');
  const body = htmlChild(html, 'body');
  if (!html || !htmlChild(html, 'head') || !body) return null;
  if (mapper.id === 'Fibank' && doc.errors.length) return null;
  if (mapper.id === 'DSK' && !htmlDescendants(body, 'td').some((td) => hasClass(td, 'amt'))) return null;
  const tables = htmlDescendants(body, 'table');
  const first = tables[0];
  if (!first) return null;
  const rows = htmlTableRows(first);
  let movements: HtmlMovement[];
  let before: HtmlCell[][] = [];
  if (mapper.id === 'Fibank') movements = fibankHtmlMovements(rows);
  else {
    const t = tableHtmlMovements(rows, mapper);
    movements = t.movements;
    before = rows.slice(0, Math.max(t.headerAt, 0));
  }
  // Header block: the text lines outside the tables, the other tables and, of the
  // movements table, the rows above its header row and the rows that start with a
  // header caption ("Старо салдо", "Период", ...). Movement rows are left out, so a
  // description such as "Период 01.12 - 31.12 наем" cannot set the period.
  const textLines = htmlText(body, { skipTables: true }).split('\n').filter(Boolean).map((l): HtmlCell[] => [{ text: l, classes: [] }]);
  const captionRow = (r: HtmlCell[]) => {
    const firstCell = r.find((c) => c.text.trim());
    return Boolean(firstCell && headerCaption(firstCell.text));
  };
  const firstTableHead = [...before, ...rows.slice(before.length).filter(captionRow)];
  const head = readHtmlHeader([...textLines, ...firstTableHead, ...tables.slice(1).flatMap((t) => htmlTableRows(t))]);
  head.iban ??= [...textLines, ...before].flatMap((r) => r.map((c) => ibanIn(c.text.replace(/\n/g, ' ')))).find(Boolean);
  const build = HTML_MODELS[mapper.id]!;
  const out: BankStatementRow[] = [];
  for (const mv of movements) {
    const model: Model = { Date: mv.date, ValueDate: mv.valueDate, DocRegNumber: mv.reference, ...build(mv) };
    for (const [k, v] of Object.entries(mv.props ?? {})) if (v && !model[k]) model[k] = v;
    const row = toRow(mapper, model, out.length);
    if (row) out.push(row);
  }
  return withPeriod({ format: `${mapper.id} HTML`, model: mapper.id, ...head, rows: out });
}
