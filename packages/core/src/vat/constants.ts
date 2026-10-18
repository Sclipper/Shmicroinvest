/**
 * VAT (ДДС) constants: term ids, VIES types, protocol (ICA) types, VAT-relevant
 * document types and every VAT message with its dictionary key (spec 02b 22).
 */

/** VatTerms ids (= TypeIdentifier, enum VATTermType). */
export const VAT_TERM = {
  Internal: 1,
  PurchaseFullCredit: 2,
  PurchaseNoCredit: 3,
  PurchasePartialCredit: 4,
  AnnualAdjustment: 5,
  TriangularAcquisition: 6,
  Sale20: 7,
  IntraCommunityAcquisition: 8,
  Art82: 9,
  PersonalUse: 10,
  Sale9: 11,
  Sale0: 12,
  IntraCommunitySupply: 13,
  Art140: 14,
  ServicesArt21: 15,
  DistanceSales: 16,
  Exempt: 17,
  TriangularSupply: 18,
  /** Pseudo ids used by filters: all purchase / all sale terms. */
  AllSales: 19,
  AllPurchases: 20,
} as const;

export const PURCHASE_TERMS = [2, 3, 4, 5, 6] as const;
export const SALE_TERMS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;
/** Terms excluded from the generic sales columns 9/10 (spec 02b 4). */
export const SALES_SPECIAL_TERMS = new Set([15, 16, 17, 18]);
/** Sale-type terms a Purchase entry may carry (self-assessed rows, spec 02b 1.6). */
export const SELF_ASSESSED_TERMS = new Set([7, 8, 9]);

export const VIES_TYPE = {
  None: 1,
  IntraCommunitySupply: 2,
  TriangularIntermediary: 3,
  ServicesArt21: 4,
  CallOffSending: 5,
  CallOffReturn: 6,
  CallOffReplacement: 7,
} as const;
export const VIES_PART1 = new Set([2, 3, 4]);
export const VIES_PART2 = new Set([5, 6, 7]);

/** ICATypes (protocol types, spec 02b 2). */
export const ICA_TYPE = {
  None: 0,
  IntraCommunityAcquisition: 1,
  ServiceFromEu: 2,
  Other: 3,
  Art163a: 4,
  Art167a: 5,
  CallOffStock: 6,
  ThirdCountryService: 7,
  BreadFlourAcquisition: 8,
  BreadFlourDomestic: 9,
} as const;
/** Protocol types whose sibling link feeds the diary protocol code (fnPurchaseDiaryReport). */
export const ICA_CODE_TYPES = new Set([4, 5, 6, 8, 9]);

/** Document types with VAT meaning (ids = TypeIdentifier). */
export const VAT_DOC = {
  Invoice: 1,
  DebitNote: 2,
  CreditNote: 3,
  CustomsDeclaration: 4,
  Protocol: 5,
  MemorialOrder: 10,
  VatProtocol: 13,
  InvoiceKo: 25,
  DebitNoteKo: 26,
  CreditNoteKo: 27,
  ProtRegisteredKo: 31,
  CallOffSendRegister: 36,
  CallOffReceiveRegister: 37,
} as const;
/** Cash-accounting (КО) codes excluded from the declaration diaries (spec 02b 3). */
export const KO_SALE_CODES = new Set(['11', '12', '13']);
export const KO_PURCHASE_CODES = new Set(['11', '12', '13', '94']);
/** Cash-accounting document types counted separately in the NAP lines (spec 04a 1.7). */
export const KO_SALE_DOC_TYPES = new Set([25, 26, 27]);
export const KO_PURCHASE_DOC_TYPES = new Set([25, 26, 27, 31]);
/** Invoice-class documents (AccountingsValidationService). */
export const INVOICE_DOC_TYPES = new Set([1, 2, 3, 25, 26, 27]);

/** VAT-diary codes of protocols (AccountingExtendedDetails.VatDiaryCode, spec 02b 2). */
export const VAT_DIARY_CODES: { code: string; text: string }[] = [
  { code: '01', text: 'Доставка по чл. 163а, ал. 2 от ЗДДС - част I' },
  { code: '02', text: 'Доставка по чл. 163а, ал. 2 от ЗДДС - част II' },
  { code: '03', text: 'Внос по чл. 167а от ЗДДС' },
  { code: '07', text: 'Доставка на хляб' },
  { code: '08', text: 'Доставка на брашно' },
  { code: '41', text: 'Изпращане или транспортиране на стоки под режим складиране на стоки до поискване по чл. 15а' },
  { code: '43', text: 'Замяна на лицето, за което са предназначени стоките' },
  { code: '46', text: 'Корекция на допусната грешка при посочване на идентификационен номер по ДДС' },
  { code: '48', text: 'Връщане на стоки' },
  { code: '51', text: 'Пристигане на стоки на територията на страната' },
  { code: '53', text: 'Замяна на лицето' },
  { code: '54', text: 'Брак, липса или унищожаване на стоки' },
  { code: '58', text: 'Прекратяване на договора' },
];

/** Codes offered by document type: РСИЕС -> 41..49, РСПЕС -> above 50, otherwise below 40. */
export function vatDiaryCodesFor(documentTypeId: number | null): string[] {
  const all = VAT_DIARY_CODES.map((c) => Number(c.code));
  const pick = documentTypeId === VAT_DOC.CallOffSendRegister ? all.filter((n) => n >= 41 && n <= 49)
    : documentTypeId === VAT_DOC.CallOffReceiveRegister ? all.filter((n) => n > 50)
    : all.filter((n) => n < 40);
  return pick.map((n) => String(n).padStart(2, '0'));
}

/** Every VAT message (key -> Bulgarian text), spec 02b 22, 04a 1.3, 7.2. */
export const VAT_MESSAGES = {
  strWrongAccountingDate: 'Датата на контирането е различна от текущата счетоводна година!',
  strWrongAccountingMonth: 'Датата на контирането обхваща заключен месец/период!',
  strAskIfViesMonthIsBeforeDocumentDate: 'Месец за експорт е в период преди дата на документа! Желаете ли да продължите?',
  strViesMonthAfterTaxCredit: 'Месецът за експорт е след законно установения срок за ползване на данъчен кредит. Желаете ли да продължите?',
  strCreditNoteAmountConfirmation: 'Документ Кредитно известие (КИ) се осчетоводява с отрицателен знак! Сигурни ли сте, че искате да запазите операцията?',
  strCreditNoteAmountWarning: 'При избран документ КИ, поле Сума е необходимо да се попълни с отрицателни стойности.',
  strDocumentWithSaleAttention: 'Избраният документ следва да бъде с тип на сделката „Продажба“!',
  strDocumentWithPurchaseAttention: 'Избраният документ следва да бъде с тип на сделката „Покупка“!',
  strVatPurchasesAccountNotDefined: 'Не е дефинирана сметка Начислен данък за покупките в Индивидуален сметкоплан.',
  strVatSalesAccountNotDefined: 'Не е дефинирана сметка Начислен данък за продажбите в Индивидуален сметкоплан.',
  strVatAccountPurchaseNotDefined: 'Не е дефинирана сметка за ДДС за покупки в индивидуалния сметкоплан. Моля дефинирайте сметка с категория "Начислен данък за покупките".',
  strVatAccountSalesNotDefined: 'Не е дефинирана сметка за ДДС за продажби в индивидуалния сметкоплан. Моля дефинирайте сметка с категория "Начислен данък за продажбите".',
  strVATAccountMissing: 'Липсват следните ДДС сметки:',
  strDuplicatedDocumentWarning: 'Съществува въведен документ с този номер! Желаете ли продължение?',
  strMissingTerm: 'Не е въведено основание!',
  strMissingDocumentNumber: 'Не е въведен номер на документ!',
  strMissingDocumentType: 'Не е избран коректен тип на документ!',
  strMissingCompany: 'Не е избран партньор!',
  strInvalidDocNumberLenght: 'Невалидна дължина на Номер на документа',
  strMissingCreditAccount: 'Не е избрана валидна сметка в поле Сметка за разход!',
  strICACreditAccountHasSubAccounts: 'Към посочената сметка в поле Сметка за разход има създадени подсметки в Индивидуален сметкоплан!',
  strInvalidICAVatAmount: 'Изчислената сума в поле Стойност на ДДС е различна от 20%',
  strCalculateVATConfirmationPrompt: 'Желаете ли да бъде преизчислена и заредена ДДС сумата?',
  strIncorrectViesOperation: 'Избраната операция за VIES не съответства на посочения код на операцията по режим на складиране в меню Протоколи по ЗДДС и други! Желаете ли да продължите?',
  strNotUpdatedArticle73RatioWarning: 'Стойността на коефициента не е изчислена спрямо въведените данни. За да получите правилен резултат натиснете "Изчисли".',
  strNotUpdatedNewArticle73RatioWarning: 'Стойността на новия коефициент не е изчислена спрямо въведените данни. За да получите правилен резултат натиснете "Изчисли".',
  strSumCannotBeZero: 'Сумата на операцията не може да бъде нулева.',
  strInvalidNegativeAmount: 'Сумата за контиране не може да бъде отрицателна.',
  strInitialBalanceWarning: 'Следните сметки имат начални салда: {0}.',
  strVATRequiredInOperation: 'В избрания тип операция се изисква задължително използване на ДДС сметки!',
  strVATNotAllowedInOperation: 'В избрания тип операция не се използват ДДС сметки, а има начислен ДДС {0}лв.',
  strVATNotAllowedInOperationErrorWithRowNumber: 'Грешка при импортирането на ред {0} от файла. В избрания тип операция не се използват ДДС сметки, а има начислен ДДС {1} лв.',
  strInvalidVatTermInExcel: 'Невалиден тип на операцията по ДДС в клетка {1}{0}: {2}.',
  strInvalidVatTermTypeInImport: 'Невалиден тип на операцията по ДДС на ред {0} от файла за импорт в поле {1}: {2}.',
  strXMLImportAccountingVatTermError: 'Липсва тип на операцията по ДДС.',
  strDifferentVATEditWarning: 'В избраното за редакция контиране има повече от един режим по ДДС. Желаете ли продължение?',
  strICATypeDefaultBreadFlourEditWarning: 'Към избраното за редакция контиране има операция ВОП - хляб и брашно. Желаете ли продължение?',
  strMyCompanyVatNumberIsEmpty: 'Не е попълнен данъчен номер за фирмата',
  strMyCompanyVATSubscriberNameIsEmpty: 'Не е попълнено име на подаващия ДДС декларацията',
  strMyCompanyVATSubscriberEGNIsInvalid: 'ЕГН на подаващия ДДС декларацията е невалидeн',
  strMyCompanyVATSubscriberPositionIsEmpty: 'Не е попълнена длъжност за СД на подаващия ДДС декларацията',
  strCompanyVatNumberIsEmpty: 'Не е попълнен ДДС номер на партньора',
  strInvalidVatNumber: 'Невалиден ДДС номер',
  // Report / NAP files (04a 1.1, 1.3)
  strCreatingVatDiaryReportFiles: 'Създаване на файловете за дневниците по ДДС...',
  strVatDiaryGenerateFilesReportError: 'Грешка при изготвянето на файловете за дневниците по ДДС. За повече информация вижте дневника на приложението.',
  strAccountingsWithMissingTermsMessage: 'Към контиране № {0} няма въведно основание. Моля въведете основание и генерирайте наново справка ДДС дневници, декларация и VIES.',
  strExportFilePathInvalid: 'Пътят до файловете за НАП е невалиден. Моля, коригирайте полето в Параметри и генерирайте справката отново!',
  strDeleteViesFilesDelta: 'Желаете ли създаване на нови файлове за НАП за избрания период? Съществуващите файлове ще бъдат изтрити.',
  strHasViesDataMessage: 'Има налични данни за VIES декларация за избрания период. Ако желаете попълване на декларацията, моля изпълнете справката отново с включен избор "Създаване на VIES Декларация".',
  // VAT-diary import (04a 2)
  strFileNotFound: 'Файлът не е намерен!',
  strInvalidDataFormatInRow: 'Невалиден формат на данните на ред {0} от файла за импорт.',
  strInvalidDocumentTypeInImport: 'Невалиден тип на документ на ред {0} от файла за импорт в поле {1}: {2}.',
  strProductsDelivery: 'Доставка на стоки',
  strProductsSale: 'Продажба на стоки',
  // Closing / annual adjustment term texts
  strConcludeVAT: 'Приключване на ДДС',
  strAnnualAdjustmentTerm: 'Годишна корекция по чл. 73, ал. 8 от ЗДДС',
} as const;
export type VatMessageKey = keyof typeof VAT_MESSAGES;

/** Replace {0}, {1}... placeholders. */
export function fmtMessage(key: VatMessageKey, ...args: (string | number)[]): string {
  return VAT_MESSAGES[key].replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}
