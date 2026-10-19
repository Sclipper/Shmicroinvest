import type { ScreenDef } from './shell/workspace.tsx';
import { AutoConclude } from './payments/AutoConclude.tsx';
import { ConcludeAccounts } from './payments/ConcludeAccounts.tsx';
import { DocumentsClosing } from './payments/DocumentsClosing.tsx';
import { PaymentDocuments } from './payments/PaymentDocuments.tsx';
import { Payments } from './payments/Payments.tsx';
import { Reevaluation } from './payments/Reevaluation.tsx';
import { CashAndReceivables } from './reports/payments/CashAndReceivables.tsx';
import { CashBook } from './reports/payments/CashBook.tsx';
import { CashOrder } from './reports/payments/CashOrder.tsx';
import { CompaniesReport } from './reports/payments/CompaniesReport.tsx';
import { ConfirmationLetter } from './reports/payments/ConfirmationLetter.tsx';
import { Overdues } from './reports/payments/Overdues.tsx';
import { PartnerDebts } from './reports/payments/PartnerDebts.tsx';
import { PartnerMovement } from './reports/payments/PartnerMovement.tsx';
import { PaymentsReport } from './reports/payments/PaymentsReport.tsx';
import { ReceivedIssued } from './reports/payments/ReceivedIssued.tsx';

/**
 * Payment documents (spec 02c 1): one registry screen per form type. The id
 * suffix is the PaymentDocumentType identifier.
 */
export const PAYMENT_DOCUMENT_SCREENS: { id: string; type: number; title: string; permission: string; gesture: string }[] = [
  { id: 'paymentDoc5', type: 5, title: 'Платежно нареждане за плащане от/към бюджета', permission: 'UI_Operations_PaymentDocuments_BlankBudgetDue', gesture: 'Ctrl+Shift+2' },
  { id: 'paymentDoc6', type: 6, title: 'Вносна бележка за плащане към бюджета', permission: 'UI_Operations_PaymentDocuments_BudgetOrder', gesture: 'Ctrl+Shift+3' },
  { id: 'paymentDoc3', type: 3, title: 'Платежно нареждане за кредитен превод', permission: 'UI_Operations_PaymentDocuments_OrderCredit', gesture: 'Ctrl+Shift+4' },
  { id: 'paymentDoc4', type: 4, title: 'Платежно нареждане за директен дебит', permission: 'UI_Operations_PaymentDocuments_OrderDebit', gesture: 'Ctrl+Shift+5' },
  { id: 'paymentDoc2', type: 2, title: 'Вносна бележка', permission: 'UI_Operations_PaymentDocuments_Due', gesture: 'Ctrl+Shift+6' },
  { id: 'paymentDoc1', type: 1, title: 'Нареждане разписка', permission: 'UI_Operations_PaymentDocuments_Order', gesture: 'Ctrl+Shift+7' },
  { id: 'paymentDoc8', type: 8, title: 'Нареждане за масово плащане', permission: 'UI_Operations_PaymentDocuments_OrderMassPayment', gesture: 'Ctrl+Shift+8' },
];

/** Payments, binding, automatic operations, payment documents, partner and cash reports. */
export const PAYMENT_SCREENS: ScreenDef[] = [
  { id: 'payments', title: 'Разплащания', component: Payments, permission: 'UI_Operations_Payments' },
  { id: 'documentsClosing', title: 'Закриване на документи', component: DocumentsClosing, permission: 'UI_Operations_AutoOperations_DocumentsClosing' },
  { id: 'reevaluation', title: 'Преоценка', component: Reevaluation, permission: 'UI_Operations_AutoOperations_Reevaluation' },
  { id: 'concludeAccounts', title: 'Приключване на разходни и приходни сметки', component: ConcludeAccounts, permission: 'UI_Operations_AutoOperations_ConcludeAccounts' },
  { id: 'autoConclude', title: 'Автоматично приключване на сметки', component: AutoConclude, permission: 'UI_Operations_AutoOperations_ConcludeChartOfAccounts' },
  ...PAYMENT_DOCUMENT_SCREENS.map((d): ScreenDef => ({ id: d.id, title: d.title, permission: d.permission, component: (p) => <PaymentDocuments tab={p.tab} type={d.type} /> })),
  { id: 'partnerDebts', title: 'Задължения/вземания по партньори', component: PartnerDebts, permission: 'UI_Reporting_Companies_PartnersDebtReport' },
  { id: 'receivedIssued', title: 'Получени и издадени документи', component: ReceivedIssued, permission: 'UI_Reporting_Companies_ReceivedAndIssuedDocuments' },
  { id: 'partnerMovement', title: 'Движение по партньор', component: PartnerMovement, permission: 'UI_Reporting_Companies_PartnerPaymentsAndDebtsReport' },
  { id: 'paymentsReport', title: 'Разплащания и обвързани документи', component: PaymentsReport, permission: 'UI_Reporting_Companies_PaymentsReport' },
  { id: 'confirmationLetter', title: 'Потвърдително писмо за задължения/вземания', component: ConfirmationLetter, permission: 'UI_Reporting_Companies_LiabilitiesLetterReport' },
  { id: 'overdues', title: 'Просрочени задължения', component: Overdues, permission: 'UI_Reporting_Companies_Overdues' },
  { id: 'companiesReport', title: 'Справка партньори', component: CompaniesReport, permission: 'UI_Reporting_Companies' },
  { id: 'cashAndReceivables', title: 'Касова наличност и вземания', component: CashAndReceivables, permission: 'UI_Reporting_CashReports_CashAndReceivables' },
  { id: 'cashBook', title: 'Касова книга', component: CashBook, permission: 'UI_Reporting_CashReports_CashBook' },
  { id: 'cashOrder', title: 'Касов ордер', component: CashOrder, permission: 'UI_Reporting_CashReports_CashOrder' },
];
