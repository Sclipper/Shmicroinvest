/**
 * Действия по потребители (01b 8, 05 7.7): the activity types of the log
 * and the "По документи" report (spReport_UserActivitiesByDocuments).
 */

/** Activity of a DataActivityLog row (the log stores the code). */
export const USER_ACTIVITIES = [
  { code: 'add', id: 1, name: 'Добавяне' },
  { code: 'delete', id: 2, name: 'Изтриване' },
  { code: 'edit', id: 3, name: 'Редактиране' },
  { code: 'export', id: 4, name: 'Експорт на справка' },
  { code: 'print', id: 5, name: 'Печат на справка' },
  { code: 'login', id: 6, name: 'Вписване' },
  { code: 'logout', id: 0, name: 'Изход' },
] as const;
export type UserActivityCode = (typeof USER_ACTIVITIES)[number]['code'];
export const USER_ACTIVITY_CODES: readonly string[] = USER_ACTIVITIES.map((a) => a.code);

/** Report types of the options screen: "По документи" / "По менюта". */
export const USER_ACTIVITY_REPORT_TYPES = [
  { id: 'documents', name: 'По документи' },
  { id: 'menus', name: 'По менюта' },
] as const;

/** Document classes of the "По документи" report (01b 8: types 1, 2, 3, 42 / 11 / 8, 9 / 10 / others). */
export type ActivityDocumentClass = 'invoice' | 'bankStatement' | 'cashOrder' | 'memorial' | 'other';
export function activityDocumentClass(documentTypeId: number | null | undefined): ActivityDocumentClass {
  if (documentTypeId === 1 || documentTypeId === 2 || documentTypeId === 3 || documentTypeId === 42) return 'invoice';
  if (documentTypeId === 11) return 'bankStatement';
  if (documentTypeId === 8 || documentTypeId === 9) return 'cashOrder';
  if (documentTypeId === 10) return 'memorial';
  return 'other';
}

/** Column captions of the Excel template (header row 4; "Рзходни" is fixed here). */
export const ACTIVITY_DOCUMENT_COLUMNS: { key: keyof ActivityDocumentCounts; label: string }[] = [
  { key: 'invoices', label: 'Фактури, ДИ и КИ' },
  { key: 'bankStatements', label: 'Банкови извлечения' },
  { key: 'cashOrders', label: 'Разходни и приходни касови ордери' },
  { key: 'memorials', label: 'Мемориален ордер' },
  { key: 'others', label: 'Други документи' },
  { key: 'total', label: 'Общо документи' },
];

export interface ActivityDocumentCounts {
  invoices: number;
  bankStatements: number;
  cashOrders: number;
  memorials: number;
  others: number;
  /** Distinct documents. */
  total: number;
}

export interface ActivityAccountingRow {
  userId: number | null;
  userName: string | null;
  documentId: number | null;
  documentTypeId: number | null;
  isInitialBalance?: boolean;
  isInitialCorrespondence?: boolean;
}

const KEY: Record<ActivityDocumentClass, keyof ActivityDocumentCounts> = {
  invoice: 'invoices', bankStatement: 'bankStatements', cashOrder: 'cashOrders', memorial: 'memorials', other: 'others',
};

/**
 * Per user: accountings counted by document class, plus the number of
 * distinct documents; initial balances and correspondences are left out.
 * Ordered by user name.
 */
export function activityByDocuments(rows: ActivityAccountingRow[]): (ActivityDocumentCounts & { userId: number | null; userName: string })[] {
  const byUser = new Map<number | null, ActivityDocumentCounts & { userId: number | null; userName: string; docs: Set<number> }>();
  for (const r of rows) {
    if (r.isInitialBalance || r.isInitialCorrespondence) continue;
    let u = byUser.get(r.userId);
    if (!u) byUser.set(r.userId, (u = { userId: r.userId, userName: r.userName ?? '', invoices: 0, bankStatements: 0, cashOrders: 0, memorials: 0, others: 0, total: 0, docs: new Set() }));
    u[KEY[activityDocumentClass(r.documentTypeId)]]++;
    if (r.documentId != null) u.docs.add(r.documentId);
  }
  return [...byUser.values()]
    .map(({ docs, ...u }) => ({ ...u, total: docs.size }))
    .sort((a, b) => a.userName.localeCompare(b.userName, 'bg'));
}
