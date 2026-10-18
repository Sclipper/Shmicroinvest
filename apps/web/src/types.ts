export interface Session {
  company: { db: string; name: string; bulstat: string; vatId: string; isVat: boolean };
  user: { id: number; name: string; roleId: number; isAdmin: boolean };
  year: { id: number; year: number; startDate: string; isLocked: boolean; lockedMonths: number; isConcluded: boolean };
  branch: { id: number; name: string } | null;
  workingDate: string;
  baseCurrency: 'BGN' | 'EUR';
  chartIsEmpty: boolean;
  permissions: Record<string, boolean>;
  settings: Record<string, string>;
}

export interface Account {
  id: number;
  parentId: number | null;
  number: string;
  description: string;
  englishDescription: string | null;
  level: number;
  categoryId: number | null;
  currencyId: number;
  productId: number | null;
  isActive: boolean | null;
  concludeAccountId: number | null;
  isHidden: boolean;
  iban: string | null;
  isLeaf: boolean;
  isForeignCurrency: boolean;
  isMaterial: boolean;
  isUsed: boolean;
}

export interface Lookups {
  documentTypes: { id: number; name: string; shortName: string; code: string; channel: number; visible: boolean; position: number }[];
  vatTerms: { id: number; code: string; description: string; percent?: string }[];
  transactionTypes: { id: number; name: string }[];
  vieses: { id: number; name: string; code?: string }[];
  icaTypes: { id: number; name: string }[];
  currencies: { id: number; isoCode: string; name: string; exchangeRate: string; fixedRate: string }[];
  countries: { id: number; code: string; name: string }[];
  banks: { id: number; name: string; code: string; bic?: string }[];
  addressTypes: { id: number; name: string }[];
  branches: { id: number; name: string }[];
  companyGroups: { id: number; name: string; parentId: number | null; level: number }[];
}

export interface PartnerRow {
  id: number;
  name: string;
  bulstat: string | null;
  vatNumber: string | null;
  isVat: boolean;
  priority: number;
  groupId: number;
  isNotUsing: boolean;
  contactName: string | null;
  dueDays: number;
  city: string | null;
  address: string | null;
}
