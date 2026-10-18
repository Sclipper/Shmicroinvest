/**
 * Online company lookup helpers (03a 2.5). The vendor's CompanyInfo service is
 * replaced by the EU VIES service, which returns name and address for a VAT number.
 */

/** Lookup key in Delta's order: Bulstat, else VAT number, else name. */
export type LookupKey = { kind: 'bulstat'; value: string } | { kind: 'vat'; value: string } | { kind: 'name'; value: string };
export function lookupKey(p: { bulstat?: string | null; vatNumber?: string | null; name?: string | null }): LookupKey | null {
  if (p.bulstat?.trim()) return { kind: 'bulstat', value: p.bulstat.trim() };
  if (p.vatNumber?.trim()) return { kind: 'vat', value: p.vatNumber.trim().toUpperCase().replace(/\s/g, '') };
  if (p.name?.trim()) return { kind: 'name', value: p.name.trim() };
  return null;
}

/** Country code and number for VIES; Greece is "EL" in VIES while its ISO code is "GR". */
export function viesParts(key: { kind: 'bulstat' | 'vat'; value: string }): { country: string; number: string } | null {
  if (key.kind === 'bulstat') return /^\d{9}(\d{4})?$/.test(key.value) ? { country: 'BG', number: key.value.slice(0, 9) } : null;
  const m = key.value.match(/^([A-Z]{2})([0-9A-Z+*]{2,13})$/);
  if (!m) return /^\d{9,10}$/.test(key.value) ? { country: 'BG', number: key.value } : null;
  return { country: m[1] === 'GR' ? 'EL' : m[1]!, number: m[2]! };
}

/**
 * Splits a one-line address into city, postal code and location (03a 2.5):
 * the place follows "гр." or "с.", a trailing 4-digit number is the postcode,
 * and the rest is the location.
 */
export function parseCompanyAddress(address: string): { city: string; postalCode: string; location: string } {
  let s = address.replace(/\s+/g, ' ').trim();
  let postalCode = '';
  const pc = s.match(/[\s,]+(\d{4})\s*$/);
  if (pc) {
    postalCode = pc[1]!;
    s = s.slice(0, pc.index).trim();
  }
  let city = '';
  const place = s.match(/(?:^|[\s,])(гр\.|с\.)\s*([^,]+?)\s*(?:,|$)/i);
  if (place) {
    city = place[2]!.trim();
    s = (s.slice(0, place.index) + ',' + s.slice(place.index! + place[0].length)).trim();
  } else {
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) city = parts.pop()!;
    s = parts.join(', ');
  }
  // Drop the region ("обл.СОФИЯ") and tidy separators.
  const location = s.replace(/обл\.\s*[^,]+/i, '').replace(/\s*,\s*/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').replace(/(, )+/g, ', ');
  return { city, postalCode, location };
}
