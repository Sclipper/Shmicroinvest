/** Data of the letter reports (confirmation letter 05 6.5, overdue liabilities 05 6.7). */

export interface PartnerCard { id: number; name: string; bulstat: string; vatNumber: string; mol: string; address: string; city: string; phone: string; postalCode: string; iban: string; dueDays: number }
export interface MyCompanyCard { name: string; bulstat: string; vatId: string; mol: string; accountant: string; address: string; city: string; phone: string; email: string }
export interface LetterItem {
  accountingId: number; accountNumber: string; documentTypeShortName: string; documentNumber: string; documentDate: string;
  dueDate: string; amount: string; sumAmount: string; currencyAmount: string; currencyIso: string;
  term: string; reference: string; optionalReference: string; overdueDays: number; overdueDaysText: string;
}
export interface PartnerLetter { company: PartnerCard; items: LetterItem[]; total: string; totalSum: string; totalCurrency: string }
export interface LettersResult { myCompany: MyCompanyCard; startDate: string; endDate: string; letters: PartnerLetter[] }

/** Base currency word of a report by its end date (EUR from 2026). */
export const baseCurrencyWord = (endDate: string) => (endDate >= '2026-01-01' ? 'евро' : 'лв.');
