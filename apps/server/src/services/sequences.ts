import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';

/** Format a sequence number: "[#]" is replaced by the zero-padded number (channel 999 unpadded). */
export function formatSequenceNumber(seq: { format: string; numericLength: number; channel: number }, n: number) {
  const digits = seq.channel === 999 ? String(n) : String(n).padStart(seq.numericLength, '0');
  return seq.format.includes('[#]') ? seq.format.replace('[#]', digits) : seq.format + digits;
}

export async function findSequence(db: DbOrTx, channel: number, financialYearId: number) {
  const rows = await db.select().from(s.sequences)
    .where(and(eq(s.sequences.channel, channel), or(eq(s.sequences.financialYearId, financialYearId), isNull(s.sequences.financialYearId))))
    .orderBy(desc(s.sequences.financialYearId));
  return rows[0] ?? null;
}

/** Next number without reserving it (shown in a new editor). */
export async function peekNextNumber(db: DbOrTx, channel: number, financialYearId: number) {
  const seq = await findSequence(db, channel, financialYearId);
  if (!seq) return '';
  return formatSequenceNumber(seq, seq.lastNumber + 1);
}

/**
 * Reserve the next number (spGetNextNumber): increments LastNumber, skipping
 * numbers already used by entries of the year so manual numbers never collide.
 */
export async function reserveNumber(db: DbOrTx, channel: number, financialYearId: number, isUsed: (n: string) => Promise<boolean>) {
  const seq = await findSequence(db, channel, financialYearId);
  if (!seq) throw new Error(`Няма номерация за канал ${channel}.`);
  let n = seq.lastNumber;
  let formatted: string;
  do {
    n++;
    formatted = formatSequenceNumber(seq, n);
    if (String(n).length > seq.numericLength && seq.channel !== 999) throw new Error('Номерацията е изчерпана.');
  } while (await isUsed(formatted));
  await db.update(s.sequences).set({ lastNumber: n }).where(eq(s.sequences.id, seq.id));
  return { number: formatted, sequenceId: seq.id };
}

export async function accountingNumberUsed(db: DbOrTx, financialYearId: number, number: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(s.accountings)
    .where(and(eq(s.accountings.financialYearId, financialYearId), eq(s.accountings.number, number)));
  return (r?.n ?? 0) > 0;
}
