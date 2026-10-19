import { YEAR_MESSAGES, yearChangeMovesDateForward } from '@shmi/core';
import { ApiError, api } from '../../api.ts';
import type { useDialogs } from '../../components/dialogs.tsx';

/** The year questions whose "Да" leads to the conclusion of the previous year (01b 6.3). */
const CONCLUDE_FIRST = ['strNextFinancialYearConcludePreviousWarning', 'strSelect2026yearMessage'];

/**
 * Selects the active year (status bar and the Избор tab): a later year moves the
 * working date, so that is confirmed first (01b 5). Returns 'conclude' when the
 * user answered "Да" to a question that needs the previous year concluded.
 */
export async function chooseActiveYear(dialogs: ReturnType<typeof useDialogs>, workingDate: string, year: number, create?: () => Promise<unknown>): Promise<'done' | 'cancel' | 'conclude'> {
  if (yearChangeMovesDateForward(workingDate, year) && !(await dialogs.confirm(YEAR_MESSAGES.strChangeApplicationDateWithAccountingYearConfirmation))) return 'cancel';
  try {
    if (create) await create();
    await api.put('/years/active', { year });
    return 'done';
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && CONCLUDE_FIRST.includes(e.code ?? '')) return (await dialogs.confirm(e.message)) ? 'conclude' : 'cancel';
    throw e;
  }
}

