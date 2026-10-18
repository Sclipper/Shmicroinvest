/**
 * AccountingDataMemorizer (02a 4.1): one remembered copy of entry header data,
 * shared by the entry editor and fast entry (Копиране / Поставяне на данни,
 * Alt+C / Alt+V).
 */
export interface MemorizedHeader {
  documentTypeId: number | null;
  documentNumber: string;
  documentDate: string;
  companyId: number | null;
  companyName?: string | null;
  term: string;
  reference: string;
  optionalReference: string;
  paragraph: string;
  transactionTypeId: number;
  viesId: number | null;
  viesMonth: string;
}

let memory: MemorizedHeader | null = null;

export const memorizer = {
  copy(h: MemorizedHeader) {
    memory = { ...h };
  },
  paste(): MemorizedHeader | null {
    return memory ? { ...memory } : null;
  },
  get hasData() {
    return memory !== null;
  },
};
