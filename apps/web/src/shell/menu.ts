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
      { label: 'Избор на фирма...', permission: 'UI_File_ChooseCompany', command: 'chooseCompany' },
      { sep: true },
      { label: 'Активна фирма', permission: 'UI_File_ActiveCompany', gesture: 'Ctrl+A', screen: 'activeCompany' },
      { sep: true },
      { label: 'Архивиране на фирма', permission: 'UI_File_BackupDatabase' },
      { label: 'Възстановяване на фирма', permission: 'UI_File_RestoreDatabaseBackup' },
      { label: 'Изход', permission: 'UI_File_Exit', command: 'logout' },
    ],
  },
  {
    label: 'Операции', permission: 'UI_Operations', items: [
      { label: 'Контиране', permission: 'UI_Operations_Accounting', gesture: 'F2', screen: 'entry' },
      { label: 'Бързо контиране', permission: 'UI_Operations_FastAccounting', gesture: 'F12', screen: 'fastEntry' },
      { label: 'Шаблони', permission: 'UI_Operations_Templates', gesture: 'Shift+F2', screen: 'templates' },
      { label: 'График с шаблони за осчетоводяване', permission: 'UI_Operations_TemplateSchedules', screen: 'templateSchedules' },
      { label: 'Разплащания', permission: 'UI_Operations_Payments', gesture: 'F3' },
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
      { label: 'Дълготрайни активи', permission: 'UI_Operations_Depreciations' },
      { label: 'Разсрочване на приходи/разходи', permission: 'UI_Operations_AccountingReschedules', gesture: 'Ctrl+R', screen: 'reschedules' },
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
          { label: 'Импорт от текстов файл', permission: 'UI_Operations_Import_TXTImport' },
          { label: 'Импорт от ДДС Дневници', permission: 'UI_Operations_Import_VATDiaryImport', screen: 'vatImport' },
          { label: 'Импорт от Excel', permission: 'UI_Operations_Import_ExcelImport' },
          { label: 'Импорт от XML', permission: 'UI_Operations_Import_XMLImport' },
        ],
      },
      { sep: true },
      {
        label: 'Автоматични операции', permission: 'UI_Operations_AutoOperations', children: [
          { label: 'Приключване на ДДС', permission: 'UI_Operations_AutoOperations_VAT', gesture: 'Alt+F', screen: 'vatClosing' },
          { label: 'Коефициент по чл. 73 от ЗДДС', permission: 'UI_Operations_AutoOperations_VATOperations_VATRatio', screen: 'article73' },
          { label: 'Преоценка', permission: 'UI_Operations_AutoOperations_Reevaluation' },
          { label: 'Приключване на разходни и приходни сметки', permission: 'UI_Operations_AutoOperations_ConcludeAccounts' },
          { label: 'Закриване на документи', permission: 'UI_Operations_AutoOperations_DocumentsClosing' },
        ],
      },
      { label: 'Платежни документи', permission: 'UI_Operations_PaymentDocuments' },
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
          { label: 'Задължения/вземания по партньори', permission: 'UI_Reporting_Companies_PartnersDebtReport', gesture: 'Alt+P', screen: 'partnerTurnover' },
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
      { label: 'Индивидуален сметкоплан', permission: 'UI_Reporting_ChartOfAccountsReport', screen: 'chartReport' },
      { label: 'Действия по потребители', permission: 'UI_Reporting_UsersActivitiesReport', screen: 'activity' },
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
export const UNBINDABLE = new Set(['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+F4']);
