import { describe, expect, it } from 'vitest';
import {
  DICTIONARY_MESSAGES, depreciationMonthTooltip, dictionaryAddQuestions, dictionaryCancelText, dictionaryKey, formatMessage, isZip,
  strCreatingDepreciationSchedule, unzipStore, USER_SCREEN_MESSAGES, userPasswordChecks, YEAR_MESSAGES, ZipPasswordError, zipStore,
} from '../src/index.ts';

describe('users screen password checks (01b 3.4)', () => {
  it('warns on no password and asks on a weak one; six characters pass', () => {
    expect(userPasswordChecks('')).toEqual([{ key: 'strUserPasswordMissing', text: 'Потребителят няма въведена парола.', severity: 'warning' }]);
    expect(userPasswordChecks('12345').map((m) => m.key)).toEqual(['strPasswordNotSecure']);
    expect(userPasswordChecks('12345')[0]!.text).toBe('Въведената парола не отговаря на изискванията за "силна" парола. Желаете ли продължение?');
    expect(userPasswordChecks('123456')).toEqual([]);
  });
  it('carries the spec texts', () => {
    expect(USER_SCREEN_MESSAGES.strSelectBaseUserRoleToAddUserOrRole).toBe('Не може да създавате подгрупи в тази група');
    expect(USER_SCREEN_MESSAGES.strUserCountValidation).toBe('Въведен е само един потребител...');
  });
});

describe('status-bar year (01b 5)', () => {
  it('strCurrentFinancialYearInfo', () => {
    expect(formatMessage(YEAR_MESSAGES.strCurrentFinancialYearInfo, 2026)).toBe('Текущата счетоводна година е 2026!');
  });
});

describe('add-to-list prompts of the posting screens (03a 8.1)', () => {
  it('asks one question per new text, the optional reference with the reference text', () => {
    const q = dictionaryAddQuestions(['term', 'optionalReference', 'paragraph']);
    expect(q.map((m) => [m.key, m.field])).toEqual([
      ['strAddTermConfirmation', 'term'], ['strAddReferenceConfirmation', 'optionalReference'], ['strAddParagraphConfirmation', 'paragraph'],
    ]);
    expect(q[0]!.text).toBe('Прибавяне на основанието към списъка с основания към контирания?');
    expect(q.every((m) => m.severity === 'warning')).toBe(true);
  });
  it('has a cancel prompt per kind and compares lower-cased trimmed text', () => {
    expect(dictionaryCancelText('term')).toBe(DICTIONARY_MESSAGES.strCancelAddTermConfirmation);
    expect(dictionaryCancelText('reference')).toBe(DICTIONARY_MESSAGES.strCancelAddReferenceConfirmation);
    expect(dictionaryCancelText('optionalReference')).toBe(DICTIONARY_MESSAGES.strCancelAddReferenceConfirmation);
    expect(dictionaryKey('  Наем ОФИС ')).toBe('наем офис');
  });
});

describe('depreciation month cells (03b 6.1)', () => {
  it('gives the five states their texts', () => {
    expect(depreciationMonthTooltip({ status: 'normal' })).toBe('Нормално');
    expect(depreciationMonthTooltip({ status: 'posted', accountingNumber: '0000000012', accountingDate: '2026-01-31' })).toBe('Осчетоводено с контиране №0000000012 от дата 31.01.2026');
    expect(depreciationMonthTooltip({ status: 'postedDifferent', accountingNumber: '12', postedAmount: '83.5' })).toBe('Осчетоводено, има контиране №12, с различна сума (83,50)');
    expect(depreciationMonthTooltip({ status: 'readOnly' })).toBe('Само за четене, от приключена година или заключен период');
    expect(depreciationMonthTooltip({ status: 'disabled' })).toBe('Няма амортизационно отчисление за този месец');
    expect(strCreatingDepreciationSchedule).toBe('Съставяне на амортизационен план...');
  });
});

describe('password-protected ZIP (ZipPassword, 06 3.2)', () => {
  const files = [{ name: 'Фирма.shbak', data: new TextEncoder().encode('SHMBAK1\n{"x":1}\nданни') }, { name: 'b.txt', data: new Uint8Array(0) }];
  it('round-trips with the password and refuses a wrong or missing one', () => {
    const zip = zipStore(files, new Date(Date.UTC(2026, 9, 19)), 'tajna-123');
    expect(isZip(zip)).toBe(true);
    // Encrypted: the plain text is not in the archive, and bit 0 of the flags is set.
    expect(new TextDecoder().decode(zip)).not.toContain('данни');
    expect(new DataView(zip.buffer).getUint16(6, true) & 1).toBe(1);
    const back = unzipStore(zip, 'tajna-123');
    expect(new TextDecoder().decode(back.get('Фирма.shbak'))).toBe('SHMBAK1\n{"x":1}\nданни');
    expect(back.get('b.txt')!.length).toBe(0);
    expect(() => unzipStore(zip)).toThrow(ZipPasswordError);
    try {
      unzipStore(zip, 'wrong');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ZipPasswordError);
      expect((e as ZipPasswordError).reason).toBe('wrong');
    }
  });
  it('writes plain archives without a password', () => {
    const zip = zipStore(files);
    expect(new DataView(zip.buffer).getUint16(6, true) & 1).toBe(0);
    expect(unzipStore(zip).size).toBe(2);
  });
});
