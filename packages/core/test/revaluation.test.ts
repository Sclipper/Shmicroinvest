import { describe, expect, it } from 'vitest';
import { canSaveRevaluation, isListedRevaluation, partnerRevaluationCheck, rateFromEcb, revaluationLegs, revalue, roundRate } from '../src/index.ts';

describe('FX revaluation (02c 2.3)', () => {
  it('worked example 2.5: rate 0.9250 -> Positive 10.00, rate 0.9100 -> Negative 8.00', () => {
    const up = revalue('1100.00', '1200.00', '0.9250');
    expect(up.newAmount.toFixed(2)).toBe('1110.00');
    expect(up.direction).toBe('positive');
    expect(up.sum.toFixed(2)).toBe('10.00');
    expect(revaluationLegs(up)).toMatchObject({ debit: 'account', credit: 'income' });
    const down = revalue('1100.00', '1200.00', '0.9100');
    expect(down.newAmount.toFixed(2)).toBe('1092.00');
    expect(down.direction).toBe('negative');
    expect(down.sum.toFixed(2)).toBe('8.00');
    expect(revaluationLegs(down)).toMatchObject({ debit: 'expense', credit: 'account' });
  });

  it('liability with a credit balance: -333.33 * 1.09375 -> -364.58, Negative 4.58', () => {
    const r = revalue('-360.00', '-333.33', '1.09375');
    expect(r.newAmount.toFixed(2)).toBe('-364.58');
    expect(r.direction).toBe('negative');
    expect(r.sum.toFixed(2)).toBe('4.58');
  });

  // The spec's own half-cent example (0.50 * 1.001 = 0.5005 -> 0.51) is an arithmetic slip:
  // 0.5005 is below the half cent. 0.50 * 1.01 = 0.505 exercises the intended rule.
  it('half cent rounds away from zero: 0.50 * 1.01 = 0.505 -> 0.51, Positive 0.01 (banker would give 0.50)', () => {
    const r = revalue('0.50', '0.50', '1.01');
    expect(r.newAmount.toFixed(2)).toBe('0.51');
    expect(r.direction).toBe('positive');
    expect(r.sum.toFixed(2)).toBe('0.01');
    expect(revalue('-0.50', '-0.50', '1.01').newAmount.toFixed(2)).toBe('-0.51');
    expect(revalue('0.50', '0.50', '1.001').newAmount.toFixed(2)).toBe('0.50');
  });

  it('acceptance 1: USD 1,000 booked 1,500.00 at 1.4999 -> 1,499.90, Negative 0.10', () => {
    const r = revalue('1500', '1000', '1.4999');
    expect(r.newAmount.toFixed(2)).toBe('1499.90');
    expect(r.direction).toBe('negative');
    expect(r.sum.toFixed(2)).toBe('0.10');
  });

  it('acceptance 4 and thresholds: 0.004 is not listed; 0.01 is listed but cannot enable save', () => {
    expect(isListedRevaluation('0.004')).toBe(false);
    expect(isListedRevaluation('0.01')).toBe(true);
    expect(canSaveRevaluation(['0.01'])).toBe(false);
    expect(canSaveRevaluation(['0.01', '0.02'])).toBe(true);
  });

  it('acceptance 6: a rate 1.234565 becomes 1.23457', () => {
    expect(roundRate('1.234565').toString()).toBe('1.23457');
    expect(roundRate('1.2345678').toString()).toBe('1.23457');
    expect(revalue('100', '100', '1.234565').rate.toString()).toBe('1.23457');
  });

  it('neutral row and average rate', () => {
    const r = revalue('120', '100', '1.2');
    expect(r.direction).toBe('neutral');
    expect(revaluationLegs(r)).toBeNull();
    expect(r.averageRate.toString()).toBe('1.2');
    expect(revalue('5', '0', '1').averageRate.toString()).toBe('5');
  });

  it('partner tab sign checks (2.4)', () => {
    expect(partnerRevaluationCheck(true, '-1')).toBe('strActiveAccountReevaluationError');
    expect(partnerRevaluationCheck(false, '1')).toBe('strPassiveAccountReevaluationError');
    expect(partnerRevaluationCheck(null, '-1')).toBeNull();
    expect(partnerRevaluationCheck(true, '10')).toBeNull();
  });

  it('central rate from an ECB reference rate', () => {
    // 1 EUR = 1.0810 USD -> 0.92507 EUR per USD; BGN base: 1.95583 / 1.0810 = 1.80928
    expect(rateFromEcb('1.0810', 'EUR', 'USD').toString()).toBe('0.92507');
    expect(rateFromEcb('1.0810', 'BGN', 'USD').toString()).toBe('1.80928');
    expect(rateFromEcb('0', 'BGN', 'EUR').toString()).toBe('1.95583');
  });
});
