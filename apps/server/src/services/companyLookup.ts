import { lookupKey, parseCompanyAddress, viesParts } from '@shmi/core';
import { ApiError } from '../lib/errors.ts';

export const LOOKUP_MESSAGES = {
  strInvalidEIKOrVAtNumber: 'Заличен или невалиден ЕИК/ДДС номер!',
  strLookupByNameNotSupported: 'Търсенето по име не се поддържа. Въведете ЕИК или ДДС номер.',
  strServiceUnavailable: 'В момента се извършва профилактика, моля опитайте по-късно!',
  strWebExceptionError: 'Възникна грешка при връзката към сървъра! Проверете връзката с интернет.',
} as const;

export interface CompanyInfo {
  companyName: string;
  bulstat: string;
  vatNumber: string;
  isVatRegistered: boolean;
  address: string;
  city: string;
  postalCode: string;
  location: string;
  countryCode: string;
}

const VIES_URL = process.env.VIES_URL ?? 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

/** Online partner lookup ("Търсене", 03a 2.5) through the EU VIES service. */
export async function lookupCompany(p: { bulstat?: string; vatNumber?: string; name?: string }): Promise<CompanyInfo> {
  const key = lookupKey(p);
  if (!key) throw new ApiError(400, LOOKUP_MESSAGES.strInvalidEIKOrVAtNumber);
  if (key.kind === 'name') throw new ApiError(400, LOOKUP_MESSAGES.strLookupByNameNotSupported);
  const parts = viesParts(key);
  if (!parts) throw new ApiError(404, LOOKUP_MESSAGES.strInvalidEIKOrVAtNumber, [{ key: 'strInvalidEIKOrVAtNumber', text: LOOKUP_MESSAGES.strInvalidEIKOrVAtNumber, severity: 'warning' }]);
  let res: Response;
  try {
    res = await fetch(VIES_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ countryCode: parts.country, vatNumber: parts.number }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(500, LOOKUP_MESSAGES.strWebExceptionError);
  }
  const body = (await res.json().catch(() => null)) as { valid?: boolean; name?: string; address?: string; errorWrappers?: { error: string }[] } | null;
  if (!res.ok || !body || body.errorWrappers?.length) throw new ApiError(500, LOOKUP_MESSAGES.strServiceUnavailable);
  if (!body.valid) throw new ApiError(404, LOOKUP_MESSAGES.strInvalidEIKOrVAtNumber, [{ key: 'strInvalidEIKOrVAtNumber', text: LOOKUP_MESSAGES.strInvalidEIKOrVAtNumber, severity: 'warning' }]);
  const clean = (v?: string) => (v && v !== '---' ? v.replace(/\s+/g, ' ').trim() : '');
  const address = clean(body.address);
  const country = parts.country === 'EL' ? 'GR' : parts.country;
  return {
    companyName: clean(body.name),
    bulstat: country === 'BG' ? (key.kind === 'bulstat' ? key.value : parts.number) : '',
    vatNumber: `${parts.country}${parts.number}`,
    isVatRegistered: true,
    address,
    countryCode: country,
    ...parseCompanyAddress(address),
  };
}
