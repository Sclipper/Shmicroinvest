/**
 * Main menu (spec 06 1.3). Items without a screen are shown disabled
 * ("Предстои") until the module is implemented.
 */
export type MenuItem =
  | { sep: true }
  | {
      label: string;
      permission?: string;
      gesture?: string;
      /** Screen id to open. */
      screen?: string;
      /** Shell command. */
      command?: 'newCompany' | 'chooseCompany' | 'logout' | 'closeCurrent' | 'closeAllButCurrent' | 'closeAll' | 'about' | 'changeUser' | 'updateCheck';
      children?: MenuItem[];
    };

export interface TopMenu {
  label: string;
  permission: string;
  items: MenuItem[];
}

export const MENU: TopMenu[] = [
  {
    label: 'Файл', permission: 'UI_File', items: [
      { label: 'Нова фирма...', permission: 'UI_File_NewCompany', command: 'newCompany' },
      { label: 'Избор на фирма...', permission: 'UI_File_ChooseCompany', gesture: 'Ctrl+O', screen: 'chooseCompany' },
      { sep: true },
      { label: 'Активна фирма', permission: 'UI_File_ActiveCompany', gesture: 'Ctrl+A', screen: 'activeCompany' },
      { sep: true },
      { label: 'Архивиране на фирма', permission: 'UI_File_BackupDatabase', screen: 'backup' },
      { label: 'Възстановяване на фирма', permission: 'UI_File_RestoreDatabaseBackup', screen: 'restore' },
      { label: 'Изход', permission: 'UI_File_Exit', command: 'logout' },
    ],
  },
  {
    label: 'Операции', permission: 'UI_Operations', items: [
      { label: 'Контиране', permission: 'UI_Operations_Accounting', gesture: 'F2', screen: 'entry' },
      { label: 'Бързо контиране', permission: 'UI_Operations_FastAccounting', gesture: 'F12', screen: 'fastEntry' },
      { label: 'Шаблони', permission: 'UI_Operations_Templates', gesture: 'Shift+F2', screen: 'templates' },
      { label: 'График с шаблони за осчетоводяване', permission: 'UI_Operations_TemplateSchedules', screen: 'templateSchedules' },
      { label: 'Разплащания', permission: 'UI_Operations_Payments', gesture: 'F3', screen: 'payments' },
      { sep: true },
      {
        label: 'Стоково-материални запаси', permission: 'UI_Operations_Products', children: [
          { label: 'Дефиниране на СМЗ', permission: 'UI_Operations_Products_DefineProducts', screen: 'products' },
          { label: 'Доставка на СМЗ', permission: 'UI_Operations_Products_Delivery', gesture: 'Ctrl+Shift+D', screen: 'productDelivery' },
          { label: 'Продажба на СМЗ', permission: 'UI_Operations_Products_Sale', gesture: 'Ctrl+Shift+S', screen: 'productSale' },
          { label: 'Изписване на СМЗ', permission: 'UI_Operations_Products_WriteOffs', gesture: 'Ctrl+I', screen: 'writeOffs' },
        ],
      },
      { sep: true },
      { label: 'Дълготрайни активи', permission: 'UI_Operations_Depreciations', gesture: 'Ctrl+D', screen: 'assets' },
      { label: 'Разсрочване на приходи/разходи', permission: 'UI_Operations_AccountingReschedules', gesture: 'Ctrl+R', screen: 'reschedules' },
      { label: 'Заявки за осчетоводяване', permission: 'UI_Operations_AccountingRequests', gesture: 'Ctrl+Q', screen: 'accountingRequests' },
      { sep: true },
      {
        label: 'Сметкоплан и начални салда', permission: 'UI_Operations_ChartOfAccounts', children: [
          { label: 'Индивидуален сметкоплан', permission: 'UI_Operations_ChartOfAccounts_IndividualChartOfAccounts', gesture: 'Ctrl+H', screen: 'chart' },
          { label: 'Начални салда', permission: 'UI_Operations_ChartOfAccounts_ChartOfAccountsBalance', gesture: 'Alt+U', screen: 'initialBalances' },
          { label: 'Начални кореспонденции', permission: 'UI_Operations_ChartOfAccounts_InitialCorrespondence', gesture: 'Alt+Y', screen: 'initialCorrespondences' },
          { label: 'Избор на сметкоплан', permission: 'UI_Operations_ChartOfAccounts_ChartOfAccountsSelection', gesture: 'Alt+K', screen: 'chartSelection' },
        ],
      },
      {
        label: 'Импорт на операции', permission: 'UI_Operations_Import', children: [
          { label: 'Импорт от текстов файл', permission: 'UI_Operations_Import_TXTImport', screen: 'textImport' },
          { label: 'Импорт от ДДС Дневници', permission: 'UI_Operations_Import_VATDiaryImport', screen: 'vatImport' },
          { label: 'Импорт от Excel', permission: 'UI_Operations_Import_ExcelImport', screen: 'excelImport' },
          { label: 'Импорт от XML', permission: 'UI_Operations_Import_XMLImport', screen: 'xmlImport' },
          { label: 'Импорт от ТРЗ Pro', permission: 'UI_Operations_Import_TRZProImport', screen: 'trzImport' },
        ],
      },
      {
        label: 'Експорт на операции', permission: 'UI_Operations_Export', children: [
          { label: 'Експорт към XML', permission: 'UI_Operations_Export_XMLExport', screen: 'xmlExport' },
        ],
      },
      {
        label: 'Банкови извлечения', permission: 'UI_Operations_BankStatements', children: [
          { label: 'Импорт на банкови извлечения', permission: 'UI_Operations_BankStatements_BankStatementsImport', screen: 'bankImport' },
          { label: 'Шаблони за банков импорт', permission: 'UI_Operations_BankStatements_BankTemplatesImport', screen: 'bankTemplates' },
        ],
      },
      { sep: true },
      {
        label: 'Автоматични операции', permission: 'UI_Operations_AutoOperations', children: [
          { label: 'Приключване на ДДС', permission: 'UI_Operations_AutoOperations_VAT', gesture: 'Alt+F', screen: 'vatClosing' },
          { label: 'Коефициент по чл. 73 от ЗДДС', permission: 'UI_Operations_AutoOperations_VATOperations_VATRatio', screen: 'article73' },
          { label: 'Преоценка', permission: 'UI_Operations_AutoOperations_Reevaluation', gesture: 'Ctrl+E', screen: 'reevaluation' },
          { label: 'Приключване на разходни и приходни сметки', permission: 'UI_Operations_AutoOperations_ConcludeAccounts', screen: 'concludeAccounts' },
          { label: 'Автоматично приключване на сметки', permission: 'UI_Operations_AutoOperations_ConcludeChartOfAccounts', screen: 'autoConclude' },
          { label: 'Закриване на документи', permission: 'UI_Operations_AutoOperations_DocumentsClosing', gesture: 'Ctrl+C', screen: 'documentsClosing' },
        ],
      },
      {
        label: 'Платежни документи', permission: 'UI_Operations_PaymentDocuments', children: [
          { label: 'Платежно нареждане за плащане от/към бюджета', permission: 'UI_Operations_PaymentDocuments_BlankBudgetDue', gesture: 'Ctrl+Shift+2', screen: 'paymentDoc5' },
          { label: 'Вносна бележка за плащане към бюджета', permission: 'UI_Operations_PaymentDocuments_BudgetOrder', gesture: 'Ctrl+Shift+3', screen: 'paymentDoc6' },
          { label: 'Платежно нареждане за кредитен превод', permission: 'UI_Operations_PaymentDocuments_OrderCredit', gesture: 'Ctrl+Shift+4', screen: 'paymentDoc3' },
          { label: 'Платежно нареждане за директен дебит', permission: 'UI_Operations_PaymentDocuments_OrderDebit', gesture: 'Ctrl+Shift+5', screen: 'paymentDoc4' },
          { label: 'Вносна бележка', permission: 'UI_Operations_PaymentDocuments_Due', gesture: 'Ctrl+Shift+6', screen: 'paymentDoc2' },
          { label: 'Нареждане разписка', permission: 'UI_Operations_PaymentDocuments_Order', gesture: 'Ctrl+Shift+7', screen: 'paymentDoc1' },
          { label: 'Нареждане за масово плащане', permission: 'UI_Operations_PaymentDocuments_OrderMassPayment', gesture: 'Ctrl+Shift+8', screen: 'paymentDoc8' },
        ],
      },
    ],
  },
  {
    label: 'Редакция', permission: 'UI_Edit', items: [
      { label: 'Редакция на контиране', permission: 'UI_Edit_Accountings', gesture: 'Ctrl+F2', screen: 'journal' },
      { sep: true },
      { label: 'Партньори', permission: 'UI_Edit_Companies', gesture: 'Ctrl+P', screen: 'partners' },
      { sep: true },
      { label: 'Валути', permission: 'UI_Edit_Currencies', screen: 'currencies' },
      { label: 'Държави', permission: 'UI_Edit_Administration_EditTermsAndReferences', screen: 'countries' },
      { sep: true },
      {
        label: 'Администриране', permission: 'UI_Edit_Administration', children: [
          { label: 'Моята фирма', permission: 'UI_Edit_Administration_MyCompany', gesture: 'Ctrl+F', screen: 'myCompany' },
          { label: 'Потребители', permission: 'UI_Edit_Administration_Users', gesture: 'Ctrl+U', screen: 'users' },
          { label: 'Смяна на активния потребител', permission: 'UI_Edit_Administration_ChangeActiveUser', gesture: 'Ctrl+0', command: 'changeUser' },
          { label: 'Основания и забележки', permission: 'UI_Edit_Administration_EditTermsAndReferences', screen: 'dictionary' },
          { label: 'Редакция на отчети и баланс', permission: 'UI_Edit_Administration_StatementFormulas', gesture: 'Ctrl+B', screen: 'statementFormulas' },
          { label: 'Преподреждане на документи', permission: 'UI_Edit_Administration_ReorderDocuments', screen: 'reorder' },
          { label: 'Редакция на контировки', permission: 'UI_Edit_Administration_EditAccountings', screen: 'massEdit' },
          { label: 'Импорт от Microinvest Делта', permission: 'UI_Edit_Administration_DeltaConversion', screen: 'deltaConversion' },
          { label: 'Конвертиране към евро', permission: 'UI_Edit_Administration', screen: 'euroConversion' },
        ],
      },
      { sep: true },
      { label: 'Счетоводна година', permission: 'UI_Edit_ChangeActiveFinancialYear', gesture: 'Ctrl+Y', screen: 'years' },
    ],
  },
  {
    label: 'Справки', permission: 'UI_Reporting', items: [
      { label: 'Оборотна ведомост', permission: 'UI_Reporting_TurnoverReport', gesture: 'Alt+O', screen: 'trialBalance' },
      { label: 'Хронологичен регистър', permission: 'UI_Reporting_ChronologicalReport', gesture: 'Alt+H', screen: 'chronological' },
      { label: 'Аналитичен регистър', permission: 'UI_Reporting_AnalyticalReport', gesture: 'Alt+A', screen: 'analytical' },
      { label: 'Главна книга', permission: 'UI_Reporting_GeneralLedger', gesture: 'Alt+G', screen: 'generalLedger' },
      { sep: true },
      {
        label: 'Фирми', permission: 'UI_Reporting_Companies', children: [
          { label: 'Задължения/вземания по партньори', permission: 'UI_Reporting_Companies_PartnersDebtReport', gesture: 'Alt+P', screen: 'partnerDebts' },
          { label: 'Оборотна ведомост по партньори', permission: 'UI_Reporting_Companies_PartnersDebtReport', screen: 'partnerTurnover' },
          { label: 'Получени и издадени документи', permission: 'UI_Reporting_Companies_ReceivedAndIssuedDocuments', screen: 'receivedIssued' },
          { label: 'Движение по партньор', permission: 'UI_Reporting_Companies_PartnerPaymentsAndDebtsReport', screen: 'partnerMovement' },
          { label: 'Разплащания и обвързани документи', permission: 'UI_Reporting_Companies_PaymentsReport', gesture: 'Alt+R', screen: 'paymentsReport' },
          { label: 'Потвърдително писмо за задължения/вземания', permission: 'UI_Reporting_Companies_LiabilitiesLetterReport', screen: 'confirmationLetter' },
          { label: 'Просрочени задължения', permission: 'UI_Reporting_Companies_Overdues', screen: 'overdues' },
          { label: 'Справка партньори', permission: 'UI_Reporting_Companies', screen: 'companiesReport' },
        ],
      },
      { sep: true },
      { label: 'ДДС дневници, декларация и VIES', permission: 'UI_Reporting_VATDiary', gesture: 'Alt+D', screen: 'vatDiary' },
      { label: 'Протоколи по чл. 117 от ЗДДС', permission: 'UI_Reporting_ICAReport', screen: 'icaReport' },
      {
        label: 'Проверки', permission: 'UI_Reporting_Validation', children: [
          { label: 'Проверка за дублирани и липсващи документи', permission: 'UI_Reporting_Validation_AccountingsValidation', screen: 'vatValidation' },
          { label: 'Проверка на документи с файл от НАП', permission: 'UI_Reporting_Validation_AccountingsNAPFileValidation', screen: 'napCheck' },
        ],
      },
      { label: 'Отчети и баланс', permission: 'UI_Reporting_FinancialReports', gesture: 'Alt+B', screen: 'financialStatements' },
      { sep: true },
      {
        label: 'Стоково-материални запаси', permission: 'UI_Reporting_MaterialReports', children: [
          { label: 'Доставки', permission: 'UI_Reporting_MaterialReports_PurchaseReport', screen: 'purchaseReport' },
          { label: 'Продажби', permission: 'UI_Reporting_MaterialReports_SaleReport', screen: 'saleReport' },
          { label: 'Движение на стоки', permission: 'UI_Reporting_MaterialReports_GoodsMovementReport', screen: 'goodsMovementReport' },
          { label: 'Стойност за изписване при продажба', permission: 'UI_Reporting_MaterialReports_WriteOutReport', gesture: 'Alt+W', screen: 'writeOutReport' },
          { label: 'Средно претеглена стойност и изписване', permission: 'UI_Reporting_MaterialReports_AveragePriceReport', gesture: 'Alt+S', screen: 'averagePriceReport' },
          { label: 'Инвентаризационен опис', permission: 'UI_Reporting_MaterialReports', screen: 'inventoryListReport' },
        ],
      },
      { label: 'Разсрочване на приходи и разходи', permission: 'UI_Reporting_AccountingReschedules', screen: 'reschedulesReport' },
      { sep: true },
      {
        label: 'Дълготрайни активи', permission: 'UI_Reporting_Depreciations', children: [
          { label: 'Месечни амортизационни квоти', permission: 'UI_Reporting_Depreciations_MonthlyDepreciationQuotas', gesture: 'Alt+M', screen: 'assetQuotas' },
          { label: 'Инвентарна книга', permission: 'UI_Reporting_Depreciations_InventoryBook', gesture: 'Alt+I', screen: 'assetInventoryBook' },
          { label: 'Амортизационен план', permission: 'UI_Reporting_Depreciations_DepreciationPlan', screen: 'assetPlan' },
          { label: 'Активи по категории', permission: 'UI_Reporting_Depreciations_AssetsByCategories', screen: 'assetCategories' },
          { label: 'Инвентаризационен опис на ДМА', permission: 'UI_Reporting_Depreciations_InventoryListMOL', screen: 'assetInventoryMol' },
        ],
      },
      { sep: true },
      { label: 'Индивидуален сметкоплан', permission: 'UI_Reporting_ChartOfAccountsReport', screen: 'chartReport' },
      { label: 'Действия по потребители', permission: 'UI_Reporting_UsersActivitiesReport', screen: 'activity' },
      { sep: true },
      {
        label: 'Каса', permission: 'UI_Reporting_CashReports', children: [
          { label: 'Касова наличност и вземания', permission: 'UI_Reporting_CashReports_CashAndReceivables', screen: 'cashAndReceivables' },
          { label: 'Касова книга', permission: 'UI_Reporting_CashReports_CashBook', screen: 'cashBook' },
          { label: 'Касов ордер', permission: 'UI_Reporting_CashReports_CashOrder', screen: 'cashOrder' },
        ],
      },
      { label: 'Експорт към външни системи', permission: 'UI_Reporting', screen: 'reportExports' },
      { label: 'Мениджър на потребителските справки', permission: 'UI_Reporting_UserReportsManager', screen: 'userReports' },
    ],
  },
  {
    label: 'Други', permission: 'UI_Other', items: [
      { label: 'Настройки', permission: 'UI_Other_Settings', gesture: 'Ctrl+T', screen: 'settings' },
      { label: 'Проверка на ДДС номер, ЕИК, ЕГН, IBAN', permission: 'UI_Other_Validator', gesture: 'Alt+V', screen: 'validator' },
      { label: 'GDPR проверка', permission: 'UI_Other_GDPRValidator', screen: 'gdpr' },
      { label: 'Клавишни комбинации', permission: 'UI_Other_Shortcuts', gesture: 'Ctrl+K', screen: 'shortcuts' },
    ],
  },
  {
    label: 'Прозорци', permission: 'UI_Windows', items: [
      { label: 'Затваряне на текущия прозорец', permission: 'UI_Windows_CloseCurrent', gesture: 'Ctrl+F4', command: 'closeCurrent' },
      { label: 'Затваряне на всички без текущия', permission: 'UI_Windows_CloseAllButCurrent', command: 'closeAllButCurrent' },
      { label: 'Затваряне на всички прозорци', permission: 'UI_Windows_CloseAll', gesture: 'Shift+F4', command: 'closeAll' },
    ],
  },
  {
    label: 'Помощ', permission: 'UI_Help', items: [
      { label: 'Нови версии', permission: 'UI_Help_UpdateCheck', command: 'updateCheck' },
      { label: 'Дневник на приложението', permission: 'UI_Help_ApplicationLog', screen: 'appLog' },
      { sep: true },
      { label: 'За Шмелта Про', permission: 'UI_Help_About', command: 'about' },
    ],
  },
];

/** Normalised gesture of a keyboard event, e.g. "Ctrl+F2", "Alt+O". */
export function gestureOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
  // Alt+letter yields layout-dependent characters (e.g. Cyrillic); use the physical key.
  if (e.code.startsWith('Key')) k = e.code.slice(3);
  if (e.code.startsWith('Digit')) k = e.code.slice(5);
  parts.push(k);
  return parts.join('+');
}

/** Browser-reserved combinations we do not try to bind (Ctrl+W/T/N close/open browser tabs). */
export const UNBINDABLE = new Set(['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+F4', 'Ctrl+C']);

/**
 * Toolbar (06 1.5) in the XAML order. Each button runs the menu item with the
 * same label (the first one), so it shares that item's permissions and screen;
 * a button whose module is not available is not shown. Sendera, "Microinvest
 * общност" (never activated in Delta) and the support chat have no
 * counterpart here.
 */
export const TOOLBAR = [
  { id: 'tlbExit', menu: 'Изход', tooltip: 'Изход', caption: 'Изход' },
  { id: 'tlbAccounting', menu: 'Контиране', tooltip: 'Контиране', caption: 'Контиране' },
  { id: 'tlbTemplates', menu: 'Шаблони', tooltip: 'Шаблони', caption: 'Шаблони' },
  { id: 'tlbPayments', menu: 'Разплащания', tooltip: 'Разплащания', caption: 'Разплащания' },
  { id: 'tlbAccountingRequests', menu: 'Заявки за осчетоводяване', tooltip: 'Заявки за осчетоводяване', caption: 'Заявки' },
  { id: 'tlbChartOfAccounts', menu: 'Индивидуален сметкоплан', tooltip: 'Сметкоплан', caption: 'Сметкоплан' },
  { id: 'tlbEditAccountings', menu: 'Редакция на контиране', tooltip: 'Редакция на контиране', caption: 'Редакция' },
  { id: 'tlbTurnoverReport', menu: 'Оборотна ведомост', tooltip: 'Оборотна ведомост', caption: 'Оборотна' },
  { id: 'tlbGeneralLedgerReport', menu: 'Главна книга', tooltip: 'Главна книга', caption: 'Гл. книга' },
  { id: 'tlbChronologicalReport', menu: 'Хронологичен регистър', tooltip: 'Хронологичен регистър', caption: 'Хронологичен' },
  { id: 'tlbAnalyticalReport', menu: 'Аналитичен регистър', tooltip: 'Аналитичен регистър', caption: 'Аналитичен' },
  { id: 'tlbPartnersReport', menu: 'Задължения/вземания по партньори', tooltip: 'Задължения/вземания по партньори', caption: 'Партньори' },
  { id: 'tlbVATDiary', menu: 'ДДС дневници, декларация и VIES', tooltip: 'ДДС дневници, декларация и VIES', caption: 'ДДС' },
  { id: 'tlbAccountingsValidation', menu: 'Проверка за дублирани и липсващи документи', tooltip: 'Проверка за дублирани и липсващи документи', caption: 'Проверка' },
  { id: 'tlbAccountingsNAPValidation', menu: 'Проверка на документи с файл от НАП', tooltip: 'Проверка на документи с файл от НАП', caption: 'Файл НАП' },
  { id: 'tlbFinancialReports', menu: 'Отчети и баланс', tooltip: 'Отчети и баланс', caption: 'Отчети' },
  { id: 'tlbBankStatementsImport', menu: 'Импорт на банкови извлечения', tooltip: 'Импорт на банкови извлечения', caption: 'Извлечения' },
  { id: 'tlbSettings', menu: 'Настройки', tooltip: 'Настройки', caption: 'Настройки' },
  { id: 'tlbUpdate', menu: 'Нови версии', tooltip: 'Изтегляне на актуален бъгфикс', caption: 'Версии' },
] as const;

export type MenuEntry = Extract<MenuItem, { label: string }>;

/** First command item with this label, with the permissions along its menu path. */
export function findMenuItem(label: string): { item: MenuEntry; permissions: string[] } | null {
  const walk = (items: MenuItem[], perms: string[]): { item: MenuEntry; permissions: string[] } | null => {
    for (const i of items) {
      if ('sep' in i) continue;
      const p = i.permission ? [...perms, i.permission] : perms;
      if (i.label === label && !i.children) return { item: i, permissions: p };
      const found = i.children ? walk(i.children, p) : null;
      if (found) return found;
    }
    return null;
  };
  for (const m of MENU) {
    const found = walk(m.items, [m.permission]);
    if (found) return found;
  }
  return null;
}
