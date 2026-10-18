import { describe, expect, it } from 'vitest';
import { lookupKey, parseCompanyAddress, viesParts } from '../src/index.ts';

describe('company lookup (03a 2.5)', () => {
  it('takes the key in Delta order', () => {
    expect(lookupKey({ bulstat: '831641791', vatNumber: 'BG1', name: 'X' })).toEqual({ kind: 'bulstat', value: '831641791' });
    expect(lookupKey({ bulstat: ' ', vatNumber: 'de 123456789', name: 'X' })).toEqual({ kind: 'vat', value: 'DE123456789' });
    expect(lookupKey({ name: 'Фирма' })).toEqual({ kind: 'name', value: 'Фирма' });
    expect(lookupKey({})).toBeNull();
  });
  it('maps keys to VIES parts', () => {
    expect(viesParts({ kind: 'bulstat', value: '831641791' })).toEqual({ country: 'BG', number: '831641791' });
    expect(viesParts({ kind: 'bulstat', value: '8316417910001' })).toEqual({ country: 'BG', number: '831641791' });
    expect(viesParts({ kind: 'bulstat', value: '12' })).toBeNull();
    expect(viesParts({ kind: 'vat', value: 'GR094014201' })).toEqual({ country: 'EL', number: '094014201' });
    expect(viesParts({ kind: 'vat', value: 'BG175074752' })).toEqual({ country: 'BG', number: '175074752' });
  });
  it('splits a VIES address into city, postcode and location', () => {
    expect(parseCompanyAddress('ул. ПАНАЙОТ ВОЛОВ  №2 обл.СОФИЯ, гр.СОФИЯ 1504')).toEqual({ city: 'СОФИЯ', postalCode: '1504', location: 'ул. ПАНАЙОТ ВОЛОВ №2' });
    expect(parseCompanyAddress('с. Беловица, ул. Първа 1, 4114')).toEqual({ city: 'Беловица', postalCode: '4114', location: 'ул. Първа 1' });
    expect(parseCompanyAddress('бул. Витоша 1, Пловдив')).toEqual({ city: 'Пловдив', postalCode: '', location: 'бул. Витоша 1' });
  });
});
