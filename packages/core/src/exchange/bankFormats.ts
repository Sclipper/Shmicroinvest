import { dec, round2 } from '../money.ts';
import { normalizeIban } from '../validators.ts';
import { child, children, descendants, parseXml, pathText, type XmlElement } from './xml.ts';
import { fromOADate, parseBgDate, parseDecimalText } from './messages.ts';

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
    id: 'Allianz', title: 'Алианц Банк', bankCodes: ['BGUSBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Дт/Кт', 'text', ['dtkt', 'дт/кт', 'вид']), P('Amount', 'Сума', 'amount', ['сума', 'amount']), P('More', 'Сметка', 'text', ['iban', 'сметка']), P('Beneficiary', 'Наредител/Получател', 'text', ['beneficiary', 'payer', 'наредител/получател']), P('PaymentDetails', 'Основание', 'text', ['основание', 'details of payment']), P('AdditionalExplanation', 'Допълнително пояснение', 'text', ['additional explanation', 'допълнително пояснение'])],
    map: (m) => ({ isInflow: (m.MovementType ?? '').trim().toUpperCase() !== 'D', amount: abs(m.Amount), partnerIban: pick(m.More), partnerName: pick(m.Beneficiary), reason: join(m.PaymentDetails, m.AdditionalExplanation), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'Asset', title: 'Интернешънъл Асет Банк', bankCodes: ['IORTBGSF'], dateProperty: 'Date',
    properties: [...COMMON, P('MovementType', 'Дт/Кт', 'text', ['дт/кт', 'вид']), P('Amount', 'Сума', 'amount', ['сума']), P('IBAN', 'IBAN', 'text', ['iban']), P('CompanyName', 'Контрагент', 'text', ['контрагент', 'име']), P('Term', 'Основание', 'text', ['основание'])],
    map: (m) => ({ isInflow: (m.MovementType ?? '').trim() === 'Кт', amount: abs(m.Amount), partnerIban: pick(m.IBAN), partnerName: pick(m.CompanyName), reason: pick(m.Term), reference: pick(m.DocRegNumber) }),
  },
  {
    id: 'BAKB', title: 'Българо-американска кредитна банка', bankCodes: ['NASBBGSF'], dateProperty: 'Date',
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
    id: 'Investbank', title: 'Инвестбанк', bankCodes: ['IABGBGSF'], dateProperty: 'Date',
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
  const iso = parseBgDate(t);
  if (iso) return iso;
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(t); // YYMMDD (MT940)
  if (m) return parseBgDate(`${m[3]}.${m[2]}.20${m[1]}`);
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
  for (let r = headerAt + 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (!cells.some((c) => c.trim())) continue;
    const m: Model = {};
    binding.forEach((name, i) => {
      if (name) m[name] = (cells[i] ?? '').trim();
    });
    const row = toRow(mapper, m, out.length);
    if (row) out.push(row);
  }
  return withPeriod({ format, model: mapper.id, rows: out });
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

/** Text decoding: UTF-8 (with or without BOM) when valid, else windows-1251 (Encoding.Default on a Bulgarian Windows). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/**
 * Reads any supported statement file (spreadsheets are passed as `table`).
 * Probes in order: XML (camt.053, DSK, BAKB), MT940, delimited text.
 */
export function parseBankStatement(input: { text?: string; table?: string[][] }, bankCode: string | null | undefined): ParsedStatement | null {
  if (input.table) {
    const s = parseStatementTable(input.table, bankCode, 'Excel');
    return s.rows.length ? s : null;
  }
  const text = input.text ?? '';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    let root: XmlElement | null = null;
    try {
      root = parseXml(text);
    } catch {
      root = null;
    }
    if (root?.local === 'Document') return parseCamt053(root, bankCode);
    if (root?.local === 'AccountMovementsResult' || /<AccountMovementsResult/.test(text)) return parseDskXml(text);
    if (root?.local === 'AccountsMovements') return parseBakbXml(text);
    return null;
  }
  const mt = parseMt940(text);
  if (mt) return mt;
  const mapper = mapperForBank(bankCode);
  const prepared = mapper.id === 'OBB' ? rejoinObbLines(text) : text;
  const s = parseStatementTable(splitDelimited(prepared), bankCode, 'CSV');
  return s.rows.length ? s : null;
}
