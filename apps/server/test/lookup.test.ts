import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);
afterAll(() => t.close());
afterEach(() => vi.unstubAllGlobals());

/** Replaces VIES with a canned answer (the app itself is called through app.request, not fetch). */
function stubVies(answer: (body: { countryCode: string; vatNumber: string }) => { status: number; json: unknown } | 'network') {
  const calls: { countryCode: string; vatNumber: string }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const a = answer(body);
    if (a === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

describe('partner online lookup (03a 2.5)', () => {
  it('looks up by EIK and fills name, VAT number and the parsed address', async () => {
    const calls = stubVies(() => ({ status: 200, json: { valid: true, name: 'ИНФОРМАЦИОННО ОБСЛУЖВАНЕ - АД', address: 'ул. ПАНАЙОТ ВОЛОВ  №2 обл.СОФИЯ, гр.СОФИЯ 1504' } }));
    const r = await t.call('GET', '/partners/lookup?bulstat=831641791&vatNumber=BG999');
    expect(r.status, r.text).toBe(200);
    expect(calls).toEqual([{ countryCode: 'BG', vatNumber: '831641791' }]);
    expect(r.body).toMatchObject({
      companyName: 'ИНФОРМАЦИОННО ОБСЛУЖВАНЕ - АД', bulstat: '831641791', vatNumber: 'BG831641791', isVatRegistered: true,
      city: 'СОФИЯ', postalCode: '1504', location: 'ул. ПАНАЙОТ ВОЛОВ №2', countryCode: 'BG',
    });
  });

  it('uses the VAT number when there is no EIK; Greek numbers go to VIES as EL', async () => {
    const calls = stubVies(() => ({ status: 200, json: { valid: true, name: 'Hellas SA', address: '---' } }));
    const r = await t.call('GET', '/partners/lookup?vatNumber=GR094014201');
    expect(calls[0]).toEqual({ countryCode: 'EL', vatNumber: '094014201' });
    expect(r.body).toMatchObject({ companyName: 'Hellas SA', bulstat: '', vatNumber: 'EL094014201', countryCode: 'GR', address: '' });
  });

  it('reports invalid numbers, service errors and connection failures with the spec texts', async () => {
    stubVies(() => ({ status: 200, json: { valid: false } }));
    const invalid = await t.call('GET', '/partners/lookup?bulstat=831903183');
    expect([invalid.status, invalid.body.error]).toEqual([404, 'Заличен или невалиден ЕИК/ДДС номер!']);
    stubVies(() => ({ status: 200, json: { errorWrappers: [{ error: 'MS_UNAVAILABLE' }] } }));
    expect((await t.call('GET', '/partners/lookup?bulstat=831641791')).body.error).toBe('В момента се извършва профилактика, моля опитайте по-късно!');
    stubVies(() => 'network');
    expect((await t.call('GET', '/partners/lookup?bulstat=831641791')).body.error).toMatch(/^Възникна грешка при връзката към сървъра!/);
    expect((await t.call('GET', '/partners/lookup?name=Фирма')).status).toBe(400);
  });
});
