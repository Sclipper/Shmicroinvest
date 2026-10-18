/**
 * Account categories (spec 01a section 6). TypeIdentifier 1..61; 0 = none (NULL), 62 = sentinel.
 */
export interface AccountCategoryDef {
  id: number;
  code: string;
  description: string;
  english: string;
}

export const ACCOUNT_CATEGORIES: AccountCategoryDef[] = [
  { id: 1, code: '302', description: 'Материали', english: 'Materials' },
  { id: 2, code: '303', description: 'Продукция', english: 'Finished production' },
  { id: 3, code: '304', description: 'Стоки', english: 'Goods for resale' },
  { id: 4, code: '401', description: 'Доставчици', english: 'Suppliers' },
  { id: 5, code: '402', description: 'Доставчици по аванси', english: 'Suppliers - advances paid' },
  { id: 6, code: '403', description: 'Доставчици по търговски кредити', english: 'Suppliers - trade credits' },
  { id: 7, code: '404', description: 'Доставчици по доставки при определени условия', english: 'Suppliers - deliveries under special terms' },
  { id: 8, code: '406', description: 'Разчети със свързани лица по покупки', english: 'Settlements with related parties - purchases' },
  { id: 9, code: '409', description: 'Други разчети с доставчици', english: 'Other settlements with suppliers' },
  { id: 10, code: '411', description: 'Клиенти', english: 'Customers' },
  { id: 11, code: '412', description: 'Клиенти по аванси', english: 'Customers - advances received' },
  { id: 12, code: '413', description: 'Клиенти по търговски кредити', english: 'Customers - trade credits' },
  { id: 13, code: '414', description: 'Клиенти по продажби при определени условия', english: 'Customers - sales under special terms' },
  { id: 14, code: '416', description: 'Разчети със свързани лица по продажби', english: 'Settlements with related parties - sales' },
  { id: 15, code: '419', description: 'Други разчети с клиенти', english: 'Other settlements with customers' },
  { id: 16, code: '453/1', description: 'Начислен данък за покупките', english: 'VAT accrued on purchases' },
  { id: 17, code: '453/2', description: 'Начислен данък за продажбите', english: 'VAT accrued on sales' },
  { id: 18, code: '456', description: 'Разчети за акцизи', english: 'Excise settlements' },
  { id: 19, code: '498', description: 'Други дебитори', english: 'Other debtors' },
  { id: 20, code: '499', description: 'Други кредитори', english: 'Other creditors' },
  { id: 21, code: '501', description: 'Каса в основна валута', english: 'Cash in base currency' },
  { id: 22, code: '503', description: 'Разплащателна сметка в основна валута', english: 'Bank account in base currency' },
  { id: 23, code: '701', description: 'Приходи от продажба на продукция', english: 'Revenue from sale of production' },
  { id: 24, code: '702', description: 'Приходи от продажба на стоки', english: 'Revenue from sale of goods' },
  { id: 25, code: '703', description: 'Приходи от продажба на услуги', english: 'Revenue from sale of services' },
  { id: 26, code: '502', description: 'Каса във валута', english: 'Cash in foreign currency' },
  { id: 27, code: '504', description: 'Разплащателна сметка във валута', english: 'Bank account in foreign currency' },
  { id: 28, code: '624', description: 'Разходи по валутни операции', english: 'FX operation expenses' },
  { id: 29, code: '724', description: 'Приходи от валутни операции', english: 'FX operation income' },
  { id: 30, code: '422', description: 'Подотчетни лица', english: 'Accountable persons' },
  { id: 31, code: '707', description: 'Приходи от продажби на материали', english: 'Revenue from sale of materials' },
  { id: 32, code: '430', description: 'Вътрешни разчети', english: 'Internal settlements' },
  { id: 33, code: '405', description: 'Доставчици по доставки със свързани лица', english: 'Suppliers - related parties' },
  { id: 34, code: '415', description: 'Клиенти по продажби със свързани лица', english: 'Customers - related parties' },
  { id: 35, code: '453/8', description: 'Данък за възстановяване', english: 'VAT refundable' },
  { id: 36, code: '453/9', description: 'Данък за внасяне', english: 'VAT payable' },
  { id: 37, code: '601', description: 'Разходи за материали', english: 'Expenses for materials' },
  { id: 38, code: '602', description: 'Разходи за външни услуги', english: 'Expenses for external services' },
  { id: 39, code: '603', description: 'Разходи за амортизация', english: 'Depreciation expenses' },
  { id: 40, code: '604', description: 'Разходи за заплати /възнаграждения/', english: 'Salary expenses' },
  { id: 41, code: '605', description: 'Разходи за осигуровки', english: 'Social-security expenses' },
  { id: 42, code: '606', description: 'Разходи за данъци, такси и други подобни плащания', english: 'Taxes and fees' },
  { id: 43, code: '607', description: 'Разходи за провизии', english: 'Provision expenses' },
  { id: 44, code: '608', description: 'Разходи от последващи оценки на активи', english: 'Expenses from revaluation of assets' },
  { id: 45, code: '609', description: 'Други разходи', english: 'Other expenses' },
  { id: 46, code: '613', description: 'Разходи за придобиване на дълготрайни активи', english: 'Expenses for acquisition of fixed assets' },
  { id: 47, code: '616', description: 'Разходи за ликвидация на дълготрайни материални активи', english: 'Expenses for liquidation of fixed assets' },
  { id: 48, code: '651', description: 'Нефинансови разходи за бъдещи периоди', english: 'Non-financial prepaid expenses' },
  { id: 49, code: '652', description: 'Финансови разходи за бъдещи периоди', english: 'Financial prepaid expenses' },
  { id: 50, code: '751', description: 'Нефинансови приходи за бъдещи периоди', english: 'Non-financial deferred income' },
  { id: 51, code: '752', description: 'Финансови приходи за бъдещи периоди', english: 'Financial deferred income' },
  { id: 52, code: '', description: 'Други СМЗ', english: 'Other inventory items' },
  { id: 53, code: '', description: 'Продажба други СМЗ', english: 'Sale of other inventory items' },
  { id: 54, code: '', description: 'Кредитори', english: 'Creditors (generic)' },
  { id: 55, code: '', description: 'Дебитори', english: 'Debtors (generic)' },
  { id: 56, code: '457', description: 'Разчети с митници', english: 'Settlements with customs' },
  { id: 57, code: '629', description: 'Други финансови разходи', english: 'Other financial expenses' },
  { id: 58, code: '509', description: 'Други парични средства', english: 'Other cash equivalents' },
  { id: 59, code: '631', description: 'Загуби/разходи от обезценка', english: 'Impairment losses' },
  { id: 60, code: '731', description: 'Приходи от възстановени загуби от обезценка', english: 'Reversal of impairment losses' },
  { id: 61, code: '453/4', description: 'Начислен данък за продажбите извън страната', english: 'VAT on sales outside the country (OSS)' },
];

export const CATEGORY = {
  Materials: 1, Production: 2, Goods: 3,
  Suppliers: 4, SupplierAdvances: 5, Customers: 10, CustomerAdvances: 11,
  VatPurchases: 16, VatSales: 17, Debtors: 19, Creditors: 20,
  CashBase: 21, BankBase: 22, CashForeign: 26, BankForeign: 27,
  FxExpense: 28, FxIncome: 29, AccountablePersons: 30,
  VatRefundable: 35, VatPayable: 36, OtherCash: 58, VatOss: 61,
} as const;

/** Supplier-side partner categories (credit nature). */
export const SUPPLIER_CATEGORIES = [4, 6, 7, 33, 8, 9, 54, 20] as const;
/** Client-side partner categories (debit nature). */
export const CLIENT_CATEGORIES = [10, 12, 13, 34, 14, 15, 55, 19] as const;
/** Categories whose accounts require a partner on the line (spec 01a 6.2). */
export const COMPANY_CATEGORIES: readonly number[] = [...SUPPLIER_CATEGORIES, ...CLIENT_CATEGORIES];
export const PRODUCT_CATEGORIES = [1, 2, 3, 52] as const;
export const PRODUCT_RELEASE_CATEGORIES = [23, 24, 31, 53] as const;
export const VAT_CATEGORIES = [16, 17] as const;
export const PAYMENT_CATEGORIES = [21, 22, 26, 27] as const;
export const PAYMENT_ACCOUNT_CATEGORIES = [21, 30, 32, 58] as const;
export const MULTI_CATEGORIES = [52, 53, 54, 55, 58] as const;

export const isCompanyCategory = (c: number | null | undefined) => c != null && COMPANY_CATEGORIES.includes(c);
export const isSupplierCategory = (c: number | null | undefined) => c != null && (SUPPLIER_CATEGORIES as readonly number[]).includes(c);
export const isClientCategory = (c: number | null | undefined) => c != null && (CLIENT_CATEGORIES as readonly number[]).includes(c);

export type ChartTemplateType = 'commercial' | 'nonProfit' | 'budget';
export const CHART_TEMPLATE_LABELS: Record<ChartTemplateType, string> = {
  commercial: 'Фирмен (Търговски)',
  nonProfit: 'ЮЛНЦ (Организации)',
  budget: 'Бюджетен',
};
