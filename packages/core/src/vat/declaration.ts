import { dec, round2, ZERO, type Dec, type DecInput } from '../money.ts';
import { VAT_DOC } from './constants.ts';
import { diaryTotals, purchaseDiary, saleDiary, type DiaryOptions } from './diaries.ts';
import { indexAccountings, type VatAccounting } from './model.ts';

/** Cells of the VAT return in form order (spVATDeclarationReport result columns). */
export const DECLARATION_CELLS = ['01', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '30', '31', '32', '33', '40', '41', '42', '43', '50', '60', '70', '71', '80', '81', '82'] as const;
export type DeclarationCell = (typeof DECLARATION_CELLS)[number];

export interface DeclarationParams {
  kl33?: DecInput;
  kl70?: DecInput;
  kl71?: DecInput;
  kl80?: DecInput;
  kl81?: DecInput;
  kl82?: DecInput;
  autoFillCell71?: boolean;
}

/**
 * Return cells from the diary column sums (spec 02b 6, 05 7.4).
 * S[c] / P[c] are indexed by diary column number. Cell 40 and the test of
 * cell 60 use the unrounded P13 x KL33; cells 50 and 71 round it.
 */
export function declarationFromSums(S: Record<number, Dec>, P: Record<number, Dec>, p: DeclarationParams = {}): Record<DeclarationCell, Dec> {
  const s = (c: number) => S[c] ?? ZERO;
  const q = (c: number) => P[c] ?? ZERO;
  const kl33 = dec(p.kl33 ?? 0);
  const kl70 = dec(p.kl70 ?? 0);
  const charged = s(12).plus(s(15)).plus(s(16)).plus(s(18));
  const credit = q(11).plus(q(13).times(kl33)).plus(q(14));
  const creditRounded = q(11).plus(round2(q(13).times(kl33))).plus(q(14));
  const cell50 = charged.greaterThanOrEqualTo(creditRounded) ? charged.minus(creditRounded) : ZERO;
  const cell60 = charged.lessThan(credit) ? credit.minus(charged) : ZERO;
  const auto71 = charged.minus(creditRounded).minus(kl70);
  return {
    '01': s(11).plus(s(13)).plus(s(14)).plus(s(17)).plus(s(19)).plus(s(20)).plus(s(21)),
    '11': s(11), '12': s(13).plus(s(14)), '13': s(17), '14': s(19), '15': s(20), '16': s(21), '17': s(22), '18': s(23).plus(s(25)), '19': s(24),
    '20': charged, '21': s(12), '22': s(15), '23': s(16), '24': s(18),
    '30': q(9).plus(q(15)), '31': q(10), '32': q(12), '33': kl33,
    '40': credit, '41': q(11), '42': q(13), '43': q(14),
    '50': cell50, '60': cell60,
    '70': kl70,
    '71': p.autoFillCell71 ? (auto71.greaterThan(0) ? auto71 : ZERO) : dec(p.kl71 ?? 0),
    '80': dec(p.kl80 ?? 0), '81': dec(p.kl81 ?? 0), '82': dec(p.kl82 ?? 0),
  };
}

/** spVATDeclarationReport: diaries with cash documents excluded; P9 without РСПЕС rows. */
export function vatDeclaration(list: VatAccounting[], o: Omit<DiaryOptions, 'addCashDocs'>, p: DeclarationParams = {}) {
  const ix = indexAccountings(list);
  const sales = saleDiary(list, { ...o, addCashDocs: false }, ix);
  const purchases = purchaseDiary(list, { ...o, addCashDocs: false }, ix);
  const st = diaryTotals(sales, 17);
  const pt = diaryTotals(purchases.filter((r) => r.documentTypeId !== VAT_DOC.CallOffReceiveRegister), 7);
  const pAll = diaryTotals(purchases, 7);
  const S: Record<number, Dec> = {};
  const P: Record<number, Dec> = {};
  st.forEach((v, i) => (S[9 + i] = v));
  pAll.forEach((v, i) => (P[9 + i] = v));
  P[9] = pt[0]!;
  return { cells: declarationFromSums(S, P, p), S, P };
}
