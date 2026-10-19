import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

/** Skins (spec 06 2.7): ApplicationSkin, stored per user; saving without a skin is strNoSkinSelected. */

let t: TestCompany;

beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);
afterAll(() => t.close());

describe('ApplicationSkin (06 2.7, 3.2)', () => {
  it('defaults to the default skin, saves a skin and refuses an empty or unknown one', async () => {
    expect((await t.call('GET', '/settings/user')).body.ApplicationSkin).toBe('default');
    expect((await t.call('PUT', '/settings/user', { ApplicationSkin: 'sunset' })).status).toBe(200);
    expect((await t.call('GET', '/settings/user')).body.ApplicationSkin).toBe('sunset');
    for (const v of ['', 'dawn']) {
      const r = await t.call('PUT', '/settings/user', { ApplicationSkin: v, KeepAccountingOpen: 'True' });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('Не е избран визуален стил!');
      expect(r.body.messages.map((m: { key: string }) => m.key)).toEqual(['strNoSkinSelected']);
    }
    // Nothing of a refused request is written.
    expect((await t.call('GET', '/settings/user')).body).toMatchObject({ KeepAccountingOpen: 'False', ApplicationSkin: 'sunset' });
  });

  it('is kept per user: another user starts with the default skin', async () => {
    const u = await t.call('POST', '/users', { name: 'Оператор Стил', password: 'parola1', roleId: 5 });
    expect(u.status, u.text).toBe(201);
    const admin = t.session.get();
    const companies = (await t.call('GET', '/companies')).body as { name: string }[];
    t.session.set('');
    try {
      expect((await t.call('POST', '/login', { companyDb: companies[0]!.name, userId: u.body.id, password: 'parola1' })).status).toBe(200);
      expect((await t.call('GET', '/settings/user')).body.ApplicationSkin).toBe('default');
      expect((await t.call('PUT', '/settings/user', { ApplicationSkin: 'violetlane' })).status).toBe(200);
    } finally {
      t.session.set(admin);
    }
    expect((await t.call('GET', '/settings/user')).body.ApplicationSkin).toBe('sunset');
  });
});
