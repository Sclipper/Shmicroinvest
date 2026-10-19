/**
 * User-facing texts of the data-exchange area (spec 04a, 04b, 01b 2).
 * Keys follow the Delta dictionary. Where the spec names a key without a
 * dictionary text (marked "no text" below) the Bulgarian wording is ours.
 */
export const EXCHANGE_MESSAGES = {
  // --- common import
  strFileNotFound: 'Файлът не е намерен!',
  strFileDoesNotExist: 'Избраният файл не съществува.',
  strFilePathNotSpecified: 'Не е избран път към файла за импорт.',
  strImportFileHasNoDataErrorMessage: 'В импортния файл няма операции!',
  strOperationsImportErrorOccured: 'Възникна грешка при импорт на операциите: {0}',
  strImportOfDataFailed: 'Възникнала е грешка при импорт на данни. Подробна информация е записана в дневника на приложението.',
  strSomeRowsWereNotImportedMessage: 'Някои редове бяха игнорирани при импорта поради следните причини:',
  strTransferCompleted: 'Прехвърлянето завърши.',
  strTransferError: 'Прехвърлянето не завърши успешно.', // no text
  strOperationDateInDifferentFY: 'Датата на операцията ({0}) е в счетоводна година, различна от текущата на ред {1} от файла за импорт.',
  strOperationDateInLockedMonth: 'Не може да бъде извършен импорт в заключен месец({0}).',
  strErrorSavedInLog: 'Грешката е записана в дневника на приложението.', // no text
  strAccountParentNotFound: 'Не е намерена главна сметка за сметка {0}.', // no text
  strAccountNotFound: 'Не е намерена сметка с номер {0}.', // shared "account not found" (no text)
  strTerm: 'Основание',

  // --- TransferData XML (04a 3)
  strXMLImportError: 'Файлът не отговаря на XML схемата за импорт:', // no text
  strXMLImportCurrencyError: 'strXMLImportCurrencyError', // spec: key shown, no dictionary text
  strXMLImportMissingCurrencyError: 'Липсва валута на валутен ред в контиране.', // no text
  strXMLImportDetailError: 'Контирането няма нито един ред.', // no text
  strXMLImportAccountingVatTermError: 'Липсва тип на операцията по ДДС.',
  strXMLImportEmptyAccountingError: 'Контирането трябва да има поне един ред в дебит и един в кредит.', // no text
  strXMLImportAccountingSumsError: 'Различни суми в дебит и кредит (Дебит: {0}, Кредит: {1})',
  strXMLImportAccountingDetailsError: 'Контирането може да бъде едно към едно, едно към много или много към едно.', // no text
  strXMLImportAccountingAnalyticalDetailsError: 'Валутни и материални данни не могат да бъдат на един ред (сметка {0}).', // no text
  strXMLImportInvalidProductAccount: 'Невалидни материални данни за сметка {0}.', // no text
  strXMLImportAccountingProductError: 'Не е намерен материал за сметка {0}.', // no text
  strXMLImportSynteticAccountCurrency: 'Невалидни данни за сметка {0}. Въведена е валута на синтетично ниво.',
  strXMLImportInvalidAccount: 'Не е избрана сметка в категория {0}!',
  strXMLImportInvalidVies: 'Невалиден VIES ({0}).', // no text
  strXMLImportInvalidCategory: 'Невалидна категория ({0}) за сметка {1}.', // no text
  strXMLImportInvalidCurrencyForAccount: 'Невалидна валута ({0}) за сметка {1}.', // no text
  strXMLProductAccountCategoryError: 'Сметка {0} е с невалидна категория за материал.', // no text
  strXMLProductAccountTypeError: 'Сметка {0} е валутна или материална и не може да бъде главна сметка на материал.', // no text
  strXMLProductAccountSubAccountsError: 'Сметка {0} има подсметки на повече от едно ниво.', // no text
  strProductHasNoReleaseAccount: 'Не е въведена сметка за изписване на материал {0}.', // no text
  strVATNotAllowedInOperation: 'В избрания тип операция не се използват ДДС сметки, а има начислен ДДС {0}лв.',
  strVATRequiredInOperation: 'В избрания тип операция се изисква задължително използване на ДДС сметки!',
  strUnrecognizedOperationType: 'Неразпознат тип операция ({0}).',
  strAccountCategoryNotDefinedWarningWithParam1: 'Не е намерена сметка в категория {0}.', // no text
  strCloseWindowsToImport: 'Преди импорта е препоръчително да затворите останалите прозорци. Желаете ли да продължите?', // no text
  strEnteredIncorrectFileNameError: 'Въведено е невалидно име на файл.', // no text
  strExportHaveNoAccountingsForSelectedCriteria: 'В Делта Pro няма контирания, удовлетворяващи зададените във филтъра параметри.',
  strFilterHasWriteOffAccountings: 'Експортират се всички операции, с изключение на многоредови операции от автоматично изписване на СМЗ.',

  // --- text import (04a 4)
  strInvalidDataFormatInRow: 'Невалиден формат на данните на ред {0} от файла за импорт.',
  strInvalidDataFormatInRowField: 'Невалиден формат на данните на ред {0} от файла за импорт в поле {1}: {2}.',
  strInvalidDocumentTypeInImport: 'Невалиден тип на документ на ред {0} от файла за импорт в поле {1}: {2}.',
  strInvalidVatTermTypeInImport: 'Невалиден тип на сделката по ДДС на ред {0} от файла за импорт в поле {1}: {2}.', // no text
  strInvalidDocumentTypesDatabaseTable: 'Таблицата с типове документи съдържа дублирани съкращения ({0}).', // no text
  strAccountNotDefinedInCategory: 'Не е дефинирана сметка в категория {0} на ред {1}.',
  strVATNotAllowedInOperationErrorWithRowNumber: 'Грешка при импортирането на ред {0} от файла. В избрания тип операция не се използват ДДС сметки, а има начислен ДДС {1} лв.',
  strProductsDelivery: 'Доставка на стоки',
  strProductsSale: 'Продажба на стоки',
  strServicesInvoice: 'Фактуриране на услуги',
  strSpecialSalesAndReturns: 'Специални продажби и рекламации',
  strDeliveryWithoutDocument: 'Доставка без документ',
  strProductsWriteOff: 'Изписване на стоки по отчетна стойност',
  strPaymentInLevaToSupplier: 'Плащане в брой на доставчик', // no text
  strPaymentFromClientInLeva: 'Плащане в брой от клиент', // no text
  strInvoiceWithout411: 'Касов отчет',
  strItemSaleOSS: 'Продажба стоки OSS',
  strServiceSaleOSS: 'Продажба услуги OSS',

  // --- Excel wizard (04a 5)
  strError: 'Грешка',
  strInvalidColumnSetting: 'Невалидна настройка за {0}: {1}.',
  strEmptyColumnSetting: 'Не e въведена настройка за {0}.',
  strInvalidDataFormatInExcelCell: 'Невалидни данни в клетка {1}{0}: {2}.', // shape of the sibling messages
  strInvalidAccountingSumsInExcel: 'Невалидни данни в клетка {1}{0}. Броят на зададените суми не отговаря на броя на зададените сметки.',
  strInvalidDebitCreditAmounts: 'Сумите въведени в дебит и кредит се различават!',
  strInvalidMaterialCurrencyAccountInExcelCell: 'Невалидни данни в клетка {1}{0}. Не се поддържат материални и валутни сметки. {2}',
  strDocumentTypeMissingError: 'Не е въведен валиден тип на документа на ред {0} от файла за импорт, но са въведени други данни за него.',
  strInvalidPartnerField: 'Не е попълнен партньор на ред {0} колона {1}.',
  strInvalidTermInRowField: 'Не е попълнено основание на ред {0} колона {1}.',
  strInvalidVIESInExcel: 'Невалиден VIES на операцията в клетка {1}{0}: {2}.',
  strInvalidVatTermInExcel: 'Невалиден тип на операцията по ДДС в клетка {1}{0}: {2}.',
  strInvalidCompanyAccountCategory: 'Невалидни данни в клетка {1}{0}. Въведената сметка не е с категория от тип партньори: {2}.',
  strNotUniqueAccountNumberInExcel: 'Невалидни данни в клетка {1}{0}. Сметка със същия номер вече съществува: {2}.',
  strProductAccountNotFound: 'Невалидни данни в клетка {1}{0}. Не е намерена сметка със зададения номер: {2}.',
  strProductAccountCategoryError: 'Невалидни данни в клетка {1}{0}. Сметката е с невалидна категория: {2}. Категорията на сметката трябва да бъде: {3}.',
  strProductAccountTypeError: 'Невалидни данни в клетка {1}{0}. Сметката е валутна или материална: {2}.', // no text
  strProductAccountSubAccountsError: 'Невалидни данни в клетка {1}{0}. Сметката има подсметки, които не са материални: {2}.', // no text
  strInvalidOperationGoodTypeInExcelCell: 'Невалидни данни в клетка {1}{0}. Не е въведен вид на стоката/операцията.', // no text
  strInvalidExpenceAccountInExcelCell: 'Невалидни данни в клетка {1}{0}. Не е въведена валидна разходна сметка.', // no text
  strExcelSheetNotFound: 'Не е намерен лист „{0}“ във файла.',
  strICATerm: 'Самоначисляване на ДДС при ВОП',
  strICATypeServiceTerm: 'Самоначисляване на ДДС при услуга',
  strICATerm163a: 'Обратно начисляване по чл. 163а от ЗДДС',
  strICATerm167a01: 'Начисляване на данък по чл. 57, ал. 5 и 6 от ЗДДС',
  strICATypeThirdPart: 'Услуга от трета страна',
  strDefaultBreadTerm: 'Самоначисляване на ДДС при доставка на хляб', // no text
  strDefaultFlourTerm: 'Самоначисляване на ДДС при доставка на брашно', // no text

  // --- ТРЗ Pro (04a 6)
  strTrzProNoValueSalaryPeriods: 'В избраната фирма от ТРЗ и ЛС Pro няма периоди с начислени заплати за текущата счетоводна година!',
  strImportTrzProIncorrectAccountingDate: 'Въведената дата на осчетоводяване е преди избрания период или в друга счетоводна година!',
  strDefaultTRZProImportOperationsTerm: 'Заплати за м. {0}',
  strTrzProOperationsImportAccountsNotDefined: 'Необходимите сметки от националния сметкоплан за импорт от ТРЗ Pro не са дефинирани. Дефиниране сега?',
  strTrzProOperationsImportConfirmAccountsToDefine: 'Ще бъдат дефинирани следните сметки:', // no text
  strTrzProOperationsImportAccountsDefined: 'Сметките са дефинирани успешно.', // no text
  strTrzProOperationsImportNoAccountsToDefine: 'Всички необходими сметки са дефинирани.', // no text
  strInvalidAccountNumberWithParam: 'Невалиден номер на сметка ({0})!',
  strSelectedAccountHasSubaccountsWithParam: 'Сметка {0} има подсметки!', // no text
  strNotAllowedCurrencyAccountWithParam: 'Сметка {0} е валутна и не може да бъде използвана!', // no text
  strNotAllowedCompanyAccountWithParam: 'Сметка {0} е с партньори и не може да бъде използвана!', // no text
  strNotAllowedMaterialAccountWithParam: 'Сметка {0} е материална и не може да бъде използвана!', // no text
  strTrzProOperationsImportCantImportData: 'Данните не могат да бъдат импортирани поради следните причини:', // no text
  strTrzProOperationsImportIsImportedPeriod: 'За избраният период вече има импортирани данни от ТРЗ Pro! Желаете ли повторно зареждане на данни?',
  strTrzProOperationsImportFinished: 'Данните за м. {0} са импортирани успешно.',
  strImportFromTRZProFailed: 'Неуспешен импорт от Microinvest ТРЗ Pro!',

  // --- legacy Delta (04a 7)
  strDeltaConversionNotSupported: 'Импортът от Microinvest Делта (.mdb, Microsoft Jet) не се поддържа в уеб версията. Използвайте експорт към текстов файл или XML от старата програма.',
  strPartners: 'Партньори',
  strChartAndPartners: 'Сметкоплан и партньори',
  strOperationsChartPartners: 'Операции, сметкоплан и партньори',
  strDeltaConversionWarningMessage: 'При импорта от Microinvest Делта ще бъдат прехвърлени номенклатурите на партньорите, структурата на сметкоплана и всички осчетоводени операции след 31.12.2007г. Не се прехвърлят количествени движения на материални и валутни сметки, както и счетоводни и данъчни амортизационни планове. За да бъде извършен успешно импорта, моля изключете активната настройка за номерация на документите от меню Други / Настройки / Номерация.',
  strAccountsAlreadyExist: 'Вече съществуват сметки в индивидуалния сметкоплан. Те трябва да бъдат изтрити преди импорт.',
  strImportDatabaseNotEmptyError: 'Фирмата не е празна: в нея вече има операции, сметки или партньори. Импортът от Microinvest Делта се извършва в празна фирма.', // no text
  strTransferringMyCompany: 'Прехвърляне на данните за фирмата', // no text
  strTransferringChartOfAccounts: 'Прехвърляне на сметкоплана', // no text
  strTransferringPartners: 'Прехвърляне на партньорите', // no text
  strTransferringOperations: 'Прехвърляне на операциите', // no text
  strErrorMDBFileNotFound: 'Не е избран файл на Microinvest Делта (*.mdb).', // no text
  strErrorMDBUnrecognizedDatabaseFormat: 'Некоректен файлов формат!',
  strErrorReadingMDBFile: 'Грешка при четене на файла на Microinvest Делта: {0}', // no text
  strImportFromDeltaFailed: 'Неуспешен импорт от Microinvest Делта!', // no text
  DeltaConversionInvalidAccountError: 'Сметка {0} в таблица {1} с AccountingID = {2} е невалидна!',
  strDefaultPartner: 'Служебен партньор',
  // Rebuild texts (the conversion fails on these without a dictionary key).
  strDeltaConversionMissingTable: 'липсва таблица {0}',
  strDeltaConversionInvalidOperType: 'Невалиден тип операция по ДДС (OperType = {0}) в таблица {1} с AccountingID = {2}!',
  strDeltaConversionUnbalanced: 'Различни суми в дебит и кредит в таблица {0} с AccountingID = {1} (Дебит: {2}, Кредит: {3}).',
  strDeltaConversionAccountingError: 'Операцията в таблица {0} с AccountingID = {1} не може да бъде записана:',
  strDeltaConversionOpeningError: 'Началното салдо на сметка {0} от таблица {1} не може да бъде записано:',
  strDeltaConversionEuroYearSkipped: 'Таблица {0} не е прехвърлена: от 2026 г. основната валута е евро. Използвайте преминаването към евро след импорта.',

  // --- report exports (04a 8.3)
  strExportReportParameterNotFilled: 'Параметър "{0}" не е попълнен.',
  strCannotExecuteSQLQuery: 'Заявката към базата не може да бъде изпълнена успешно. Моля проверете дали сте попълнили всички нужни параметри.',
  strInvalidExportReportDefinition: 'Невалидна дефиниция на отчет за експорт: {0}', // no text

  // --- bank statements (04b 1)
  strWrongFileOrBrokenStructures: 'Избран е грешен файл или файлът е с нарушена структура!', // no text
  strChooseImportFilePath: 'Изберете файл за импорт!', // no text
  strHelpInvalidFilePath: 'Невалиден път до файла!', // no text
  strMissingAccountingAccount: 'Към избраната банкова сметка няма свързана счетоводна сметка!', // no text
  strCurrenciesAreNotTheSame: 'Валутата на файла е различна от валутата на банковата сметка!', // no text
  strBankStatementDatesInDifferentYear: 'Периодът на извлечението е извън текущата счетоводна година!', // IsFileDatesValid (no text)
  strBankStatementImportHeader: 'Движение по сметка {0}, {1}, {2} за период {3} - {4}',
  strCustomDocumentNumber: 'Номер на банково извлечение',
  strNoBankTemplateWarning: 'Няма шаблон, отговарящ на реда. Изберете насрещна сметка.', // no text
  strBankStatementsPreview: 'Преглед на данните',
  strMapperProgressBarMessage1: 'Зареждане на данните от файла',
  strMapperProgressBarMessage2: 'Сравнение на данните с базата данни',
  strMapperProgressBarMessage3: 'Проверка и генериране на контировки',
  strLoadingExchangeRatesFromBNB: 'Изтегляне на валути от БНБ',
  strBindIbanToPartnerConfirm: 'Искате ли да обвържете IBAN {0} с партньор {1}?',
  strMissingValidDebitAccount: 'Не е въведена валидна сметка за дебит!',
  strMissingValidCreditAccount: 'Не е въведена валидна сметка за кредит!',
  strWrongAccountingDate: 'Датата на контирането е различна от текущата счетоводна година!',
  strEmptyDocumentDate: 'Не е въведена датата на контирането!',
  strMissingValidDebitAndCreditAmount: 'Не е въведена валидна сума!', // gloss "no valid amount"
  strHelpSelectBankAccount: 'Избраната сметка има подсметки. Изберете аналитична сметка.', // gloss "account has sub-accounts"
  strMissingCompany: 'Не е избран партньор!',
  strCompanyNotFound: 'Не е намерен партньор с име: {0}',
  strMissingCompanyAccount: 'Липсва партньорна сметка на ред, където има избран партньор!',
  strCompanyAccountsOnBothSidesWarning: 'Въведени са сметки с партньори и в дебита и в кредита.',
  strCurrencyAccountsNotFound: 'Не са намерени сметки за приходи и разходи от валутни операции.', // no text
  // template editor (03a 9.4)
  strMissingTemplateName: 'Не е въведено валидно име за шаблон!',
  strMissingCondition: 'Не е въведено условие!',
  strInvalidFomula: 'Невалидно условие: {0}', // key has no text; engine message attached
  strMissingValidDebitOrCreditAccount: 'Не е въведена валидна сметка в дебит или кредит!',
  strSelectedAccountHasAtLeastOneSubAccount: 'Избраната сметка има поне една подсметка!',
  strMergeRowsValidationError: 'Не е избран партньор за автоматично обединяване при импорт.',
  strConfirmTemplateVoid: 'Желаете ли да изтриете избрания шаблон?',
  strCopyAccountingTemplate: 'Копие на {0}', // no text
  strChooseOwnAccountsOption: "Желаете ли автоматично активиране на настройка 'Собствени сметки'?",

  // --- backup / restore / company (01b)
  strBackupDatabaseSucceded: 'Архивирането на фирмата завърши успешно.', // no text
  strRestoreDatabaseBackupInCurrentDatabaseWarning: 'Внимание! Данните на текущата фирма ще бъдат заменени с данните от архива. Желаете ли да продължите?', // no text
  strRestoreDatabaseBackupInDifferentDatabaseWarning: 'Архивът ще бъде възстановен като нова фирма. Желаете ли да продължите?', // no text
  strRestoreDatabaseBackupSucceded: 'Фирмата е възстановена успешно.', // no text
  strRestoreDatabaseBackupInDifferentDatabaseSucceded: 'Архивът е възстановен успешно като нова фирма „{0}“.', // no text
  strRestoreCompanyError: 'Възникна грешка при възстановяване на фирмата.', // no text
  strInvalidChoosenFilePathError: 'Избраният файл не е валиден архив на фирма.', // no text
  strInconsistentDatabaseVersion: 'Архивът е създаден с по-нова версия на програмата ({0}) и не може да бъде възстановен.', // no text
  strDBIncompatibleError: 'Промяната на активната фирма беше неуспешна. Версията на избраната фирма е несъвместима с тази версия на програмата. Моля, актуализирайте програмата.',
  strActiveCompanyInfo: 'Фирмата с която работите в момента е {0}, {1}.',
  strDeleteCompanyConfirm: 'Внимание! Фирма „{0}“ ще бъде изтрита безвъзвратно. Преди изтриването ще бъде направен архив. Желаете ли да продължите?', // no feature in Delta
  strDeleteCompanyDone: 'Фирма „{0}“ е изтрита. Архивът е запазен като „{1}“.',
  strCannotDeleteActiveCompany: 'Не може да бъде изтрита фирмата, с която работите в момента.',

  // --- euro conversion (04b 4)
  strEuroConversionFailed: 'Конвертирането на базата данни в евро не беше успешно.', // no text
  strErrorDatabaseBackupWhenConvertingToEuro: 'Архивирането на фирмата преди конвертиране в евро не беше успешно. Конвертирането е прекратено.', // no text
  strEuroConversionDone: 'Базата данни е конвертирана в евро успешно.', // no text
  strEuroConversionNeedsYears: 'За конвертиране в евро са необходими счетоводни години 2025 и 2026.', // no text
  strEuroConversionDifferenceAccountMissing: 'Не е избрана сметка за обиране на разлики.', // no text
  strEuroConversionInvalidMapping: 'Невалидно съответствие на сметка {0}: {1}', // no text
  strDifferencesAccountDescription: 'Сметка за обиране на разлики',
} as const;

export type ExchangeMessageKey = keyof typeof EXCHANGE_MESSAGES;

/** Message with {0}, {1}... placeholders filled. */
export function msg(key: ExchangeMessageKey, ...args: (string | number)[]): string {
  return EXCHANGE_MESSAGES[key].replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}

export interface ExchangeMessage {
  key: string;
  text: string;
  severity: 'critical' | 'warning';
}

export const critical = (key: ExchangeMessageKey, ...args: (string | number)[]): ExchangeMessage => ({ key, text: msg(key, ...args), severity: 'critical' });
export const warning = (key: ExchangeMessageKey, ...args: (string | number)[]): ExchangeMessage => ({ key, text: msg(key, ...args), severity: 'warning' });

/** Error thrown by the pure import helpers (Delta's DataImportException). */
export class DataImportError extends Error {
  messages: ExchangeMessage[];
  /** Extra lines (e.g. schema messages "... on line N position M"). */
  details: string[];
  constructor(messages: ExchangeMessage[] | ExchangeMessage, details: string[] = []) {
    const list = Array.isArray(messages) ? messages : [messages];
    super([...list.map((m) => m.text), ...details].join('\n'));
    this.messages = list;
    this.details = details;
  }
}

/** Date helpers shared by the importers: dd.MM.yyyy <-> yyyy-mm-dd. */
export function parseImportDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s.*)?$/.exec(t);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(t);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

export function isoDate(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function bgDateText(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** Excel serial date (OADate) -> yyyy-mm-dd. */
export function fromOADate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400_000);
  const d = new Date(ms);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return isoDate(year, month, d.getUTCDate())!;
}

/** Decimal text: "1234.50" or "1234,50" (comma accepted where Delta accepts it). */
export function parseDecimalText(s: string, allowComma = true): string | null {
  let t = s.trim().replace(/[\s ]/g, '');
  if (allowComma) t = t.replace(',', '.');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  return t.replace(/^\+/, '');
}
