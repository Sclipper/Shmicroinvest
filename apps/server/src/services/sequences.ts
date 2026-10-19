import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';

/** Format a sequence number: "[#]" is replaced by the zero-padded number (channel 999 unpadded). */
export function formatSequenceNumber(seq: { format: string; numericLength: number; channel: number }, n: number) {
  const digits = seq.channel === 999 ? String(n) : String(n).padStart(seq.numericLength, '0');
  return seq.format.includes('[#]') ? seq.format.replace('[#]', digits) : seq.format + digits;
}

/**
 * The series used for a channel: the user's active series of the year
 * (UserSequences, 06 3.7) when one is chosen, else the channel's series of the
 * year (or the year-independent one).
 */
export async function findSequence(db: DbOrTx, channel: number, financialYearId: number, userId?: number | null) {
  if (userId) {
    const [mine] = await db.select({ seq: s.sequences }).from(s.userSequences)
      .innerJoin(s.sequences, eq(s.sequences.id, s.userSequences.sequenceId))
      .where(and(eq(s.userSequences.userId, userId), eq(s.sequences.channel, channel),
        or(eq(s.userSequences.financialYearId, financialYearId), isNull(s.userSequences.financialYearId))))
      .orderBy(desc(s.userSequences.financialYearId), desc(s.userSequences.id))
      .limit(1);
    if (mine) return mine.seq;
  }
  const rows = await db.select().from(s.sequences)
    .where(and(eq(s.sequences.channel, channel), or(eq(s.sequences.financialYearId, financialYearId), isNull(s.sequences.financialYearId))))
    .orderBy(desc(s.sequences.financialYearId), s.sequences.id);
  return rows[0] ?? null;
}

/** Next number without reserving it (shown in a new editor). */
export async function peekNextNumber(db: DbOrTx, channel: number, financialYearId: number, userId?: number | null) {
  const seq = await findSequence(db, channel, financialYearId, userId);
  if (!seq) return '';
  return formatSequenceNumber(seq, seq.lastNumber + 1);
}

/**
 * Reserve the next number (spGetNextNumber): increments LastNumber, skipping
 * numbers already used by entries of the year so manual numbers never collide.
 *
 * Atomic under concurrency (01b 9): each step is one
 * `UPDATE ... SET last_number = last_number + 1 RETURNING`, so the increment
 * happens on the stored value (not on a value read earlier) and the row stays
 * locked until the caller's transaction ends; two concurrent saves can never
 * get the same number.
 */
export async function reserveNumber(db: DbOrTx, channel: number, financialYearId: number, isUsed: (n: string) => Promise<boolean>, userId?: number | null) {
  const seq = await findSequence(db, channel, financialYearId, userId);
  if (!seq) throw new Error(`Няма номерация за канал ${channel}.`);
  let formatted: string;
  for (;;) {
    const [row] = await db.update(s.sequences).set({ lastNumber: sql`${s.sequences.lastNumber} + 1` })
      .where(eq(s.sequences.id, seq.id)).returning({ lastNumber: s.sequences.lastNumber });
    const n = row!.lastNumber;
    if (String(n).length > seq.numericLength && seq.channel !== 999) throw new Error('Номерацията е изчерпана.');
    formatted = formatSequenceNumber(seq, n);
    if (!(await isUsed(formatted))) break;
  }
  return { number: formatted, sequenceId: seq.id };
}

export async function accountingNumberUsed(db: DbOrTx, financialYearId: number, number: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(s.accountings)
    .where(and(eq(s.accountings.financialYearId, financialYearId), eq(s.accountings.number, number)));
  return (r?.n ?? 0) > 0;
}
