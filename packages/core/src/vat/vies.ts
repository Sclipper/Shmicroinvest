import { ZERO, type Dec } from '../money.ts';
import { VIES_PART1, VIES_PART2 } from './constants.ts';
import { cutOrPadLeft, cutOrPadRight, f2 } from './nap.ts';
import {
  convertRounded, convertUnrounded, indexAccountings, partnerOf, protocolOf, siblingsOf,
  type VatAccounting, type VatIndex,
} from './model.ts';

/**
 * VIES declaration (spec 02b 10, 04a 1.10, 05 7.5): the SQL report
 * (spVIESDeclarationReport / Part2 / Totals) and the NAP VIES.TXT records.
 */

export interface ViesPeriod {
  start: string;
  /** yyyy-mm-dd (inclusive). */
  end: string;
}

export interface ViesPart1Row {
  vatNumber: string | null;
  partnerName: string;
  /** Intra-community supplies of goods (ViesID 2). */
  k3: Dec;
  /** Supplies as intermediary in a triangular operation (ViesID 3). */
  k4: Dec;
  /** Services under art. 21(2) (ViesID 4). */
  k5: Dec;
  viesMonth: string;
}

export interface ViesPart2Row {
  k2: string;
  k3: string;
  k4: string;
  /** First day of the protocol month (origin month), or '' when none. */
  viesMonth: string;
}

const inRange = (d: string, p: ViesPeriod) => d.slice(0, 10) >= p.start && d.slice(0, 10) <= p.end;

/** spVIESDeclarationReport: Sign=+1 lines with a partner, grouped by partner VAT number. */
export function viesPart1(list: VatAccounting[], p: ViesPeriod): ViesPart1Row[] {
  const rows = new Map<string, ViesPart1Row>();
  for (const a of list) {
    if (a.isInitialBalance || a.viesId == null || !VIES_PART1.has(a.viesId) || !inRange(a.viesMonth, p)) continue;
    for (const d of a.details) {
      if (d.sign !== 1 || !d.partner) continue;
      const key = d.partner.vatNumber?.trim() || '\u0000null';
      const r = rows.get(key) ?? { vatNumber: d.partner.vatNumber?.trim() || null, partnerName: d.partner.name, k3: ZERO, k4: ZERO, k5: ZERO, viesMonth: a.viesMonth };
      const v = convertRounded(d.amount, p.end, a.accountingDate);
      if (a.viesId === 2) r.k3 = r.k3.plus(v);
      else if (a.viesId === 3) r.k4 = r.k4.plus(v);
      else r.k5 = r.k5.plus(v);
      if (a.viesMonth > r.viesMonth) r.viesMonth = a.viesMonth;
      rows.set(key, r);
    }
  }
  return [...rows.values()].sort((x, y) => (x.vatNumber ?? '').localeCompare(y.vatNumber ?? ''));
}

/** spVIESDeclarationTotalsReport: [01] = K3+K4+K5, [17] = K3, [02] = number of rows. */
export function viesTotals(rows: ViesPart1Row[]) {
  const k3 = rows.reduce((a, r) => a.plus(r.k3), ZERO);
  const all = rows.reduce((a, r) => a.plus(r.k3).plus(r.k4).plus(r.k5), ZERO);
  return { '01': all, '17': k3, '02': rows.length };
}

interface Part2Group {
  vat: string;
  viesId: number;
  term: string;
  month: string;
  code: string;
}

/** Project and group the call-off-stock accountings (04a 1.10, COS records). */
function part2Groups(list: VatAccounting[], p: ViesPeriod, ix: VatIndex): Part2Group[] {
  const groups = new Map<string, Part2Group>();
  for (const a of list) {
    if (a.isInitialBalance || a.viesId == null || !VIES_PART2.has(a.viesId) || !inRange(a.viesMonth, p)) continue;
    if (a.details.length === 0 || a.extendedCodes.length > 0) continue;
    const proto = protocolOf(a, ix) ?? siblingsOf(a, ix).find((s) => s.extendedCodes.length > 0);
    const code = proto?.extendedCodes[0] ?? '';
    const vat = partnerOf(a)?.vatNumber?.trim() ?? '';
    const term = a.viesId === 7 || code === '46' ? (proto?.term ?? a.term) : '';
    const month = proto ? `${proto.viesMonth.slice(5, 7)}/${proto.viesMonth.slice(0, 4)}` : '';
    const k = [vat, a.viesId, term, month].join('\u0001');
    const g = groups.get(k);
    if (!g) groups.set(k, { vat, viesId: a.viesId, term, month, code });
    else if (code > g.code) g.code = code;
  }
  return [...groups.values()];
}

/** spVIESDeclarationPart2Report rows (K2, K3, K4, ViesMonth). */
export function viesPart2(list: VatAccounting[], p: ViesPeriod, ix: VatIndex = indexAccountings(list)): ViesPart2Row[] {
  const out: ViesPart2Row[] = [];
  for (const g of part2Groups(list, p, ix)) {
    const month = g.month ? `${g.month.slice(3)}-${g.month.slice(0, 2)}-01` : '';
    const k3 = g.viesId === 5 ? '1' : g.viesId === 6 ? (g.code === '46' ? '1' : '2') : '3';
    out.push({ k2: g.vat, k3, k4: g.viesId === 7 ? g.term : '', viesMonth: month });
    if (g.viesId === 6 && g.code === '46') out.push({ k2: g.term, k3: '2', k4: '', viesMonth: month });
  }
  return out;
}

export interface ViesFileInput {
  periodEnd: string;
  ownVatId: string;
  companyName: string;
  companyAddress: string;
  subscriber: { egn: string; name: string; city: string; postalCode: string; address: string; isProcurator: boolean };
}

/** VIES.TXT records (NAPExportFiles), without line terminators. */
export function viesFileLines(list: VatAccounting[], p: ViesPeriod, i: ViesFileInput): string[] {
  const ix = indexAccountings(list);
  const part1 = list.filter((a) => !a.isInitialBalance && a.viesId != null && VIES_PART1.has(a.viesId) && inRange(a.viesMonth, p));
  const groups = part2Groups(list, p, ix);
  const month = `${i.periodEnd.slice(5, 7)}/${i.periodEnd.slice(0, 4)}`;

  // VHR count: distinct Company.VatNumber over all details (both signs) of part-1 accountings.
  const distinct = new Set<string>();
  for (const a of part1) for (const d of a.details) if (d.partner) distinct.add(d.partner.vatNumber?.trim() || '\u0000null');

  const partners = new Map<string, { vat: string; vod: Dec; mediator: Dec; services: Dec }>();
  let total = ZERO;
  let ics = ZERO;
  for (const a of part1) {
    const partner = partnerOf(a);
    if (!partner) throw new Error(`Null partner in accounting ${a.number}`);
    const amount = a.details.filter((d) => d.sign === 1).reduce((acc, d) => acc.plus(convertUnrounded(d.amount, p.end, a.accountingDate)), ZERO);
    const vat = partner.vatNumber?.trim() ?? '';
    const b = partners.get(vat) ?? { vat, vod: ZERO, mediator: ZERO, services: ZERO };
    if (a.viesId === 2) {
      b.vod = b.vod.plus(amount);
      ics = ics.plus(amount);
    } else if (a.viesId === 3) b.mediator = b.mediator.plus(amount);
    else b.services = b.services.plus(amount);
    total = total.plus(amount);
    partners.set(vat, b);
  }

  const lines: string[] = [];
  lines.push('VHR' + month + cutOrPadLeft(String(distinct.size), 5));
  const s = i.subscriber;
  lines.push('VDR' + cutOrPadRight(s.egn, 15) + cutOrPadRight(s.name, 150) + cutOrPadRight(s.city, 50) + cutOrPadRight(s.postalCode, 4) + cutOrPadRight(s.address, 150) + (s.isProcurator ? 'A' : 'R'));
  lines.push('VTR' + cutOrPadRight(i.ownVatId, 15) + cutOrPadRight(i.companyName, 150) + cutOrPadRight(i.companyAddress, 200));
  if (ics.greaterThan(0) || groups.length === 0) {
    lines.push('TTR' + cutOrPadLeft(f2(total), 12) + cutOrPadLeft(f2(ics), 12));
    let seq = 0;
    for (const b of partners.values()) {
      seq++;
      lines.push('VIR' + cutOrPadLeft(String(seq), 5) + cutOrPadRight(b.vat, 15) + cutOrPadLeft(f2(b.vod), 12) + cutOrPadLeft(f2(b.mediator), 12) + cutOrPadLeft(f2(b.services), 12) + ' '.repeat(7));
    }
  }
  if (groups.length) {
    lines.push('CHR' + cutOrPadLeft(String(groups.length + groups.filter((g) => g.code === '46').length), 5));
    let seq = 0;
    for (const g of groups) {
      const m = g.month === month ? '' : g.month;
      if (g.code === '46') {
        seq++;
        lines.push('COS' + cutOrPadLeft(String(seq), 5) + cutOrPadRight(g.term, 15) + '2' + ' '.repeat(15) + cutOrPadRight(m, 7));
      }
      seq++;
      const type = g.viesId === 5 ? '1' : g.viesId === 6 ? (g.code === '46' ? '1' : '2') : g.viesId === 7 ? '3' : ' ';
      const term = g.viesId === 7 ? g.term : '';
      lines.push('COS' + cutOrPadLeft(String(seq), 5) + cutOrPadRight(g.vat, 15) + type + cutOrPadRight(term, 15) + cutOrPadRight(m, 7));
    }
  }
  return lines;
}

/** IsHasViesAccountingsByDate. */
export function hasViesData(list: VatAccounting[], p: ViesPeriod): boolean {
  return list.some((a) => !a.isInitialBalance && a.viesId != null && (VIES_PART1.has(a.viesId) || VIES_PART2.has(a.viesId)) && inRange(a.viesMonth, p));
}

