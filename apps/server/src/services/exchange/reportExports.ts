import { asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  DataImportError, bindNamedParameters, checkExportParameters, critical, exportFileName, isReadOnlyQuery, parseExportReport, writeExportCsv, zipFiles,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { CompanyDb, DbOrTx } from '../../db/provider.ts';
import { writeWorkbook } from './xlsx.ts';

export async function listExportReports(db: DbOrTx) {
  const rows = await db.select().from(s.exportReports).orderBy(asc(s.exportReports.name));
  return rows.map((r) => {
    const def = parseExportReport(r.definition);
    return { id: r.id, name: r.name, fileName: r.fileName, description: def.description, parameters: def.parameters, documents: def.documents.map((d) => ({ name: d.name, kind: d.kind })) };
  });
}

export async function addExportReport(db: DbOrTx, fileName: string, xml: string) {
  const def = parseExportReport(xml);
  const [row] = await db.insert(s.exportReports).values({ name: def.name.slice(0, 255), fileName: fileName.slice(0, 255), definition: xml }).returning({ id: s.exportReports.id });
  return { id: row!.id, name: def.name };
}

function toSql(parts: (string | number)[], params: unknown[]): SQL {
  const chunks: SQL[] = parts.map((p) => (typeof p === 'number' ? sql`${params[p]}` : sql.raw(p)));
  return sql.join(chunks, sql.raw(''));
}

/**
 * Runs a report: every document's query is executed read-only with the
 * parameters (@fileName added automatically); one file per document, a zip
 * when there are several.
 */
export async function runExportReport(db: CompanyDb, id: number, values: Record<string, string>) {
  const [row] = await db.select().from(s.exportReports).where(eq(s.exportReports.id, id));
  if (!row) return null;
  const def = parseExportReport(row.definition);
  checkExportParameters(def, values);
  const files: { name: string; data: Uint8Array }[] = [];
  for (const doc of def.documents) {
    const fileName = exportFileName(doc, def, values);
    if (!isReadOnlyQuery(doc.query)) throw new DataImportError(critical('strCannotExecuteSQLQuery'));
    const { parts, params } = bindNamedParameters(doc.query, { ...values, '@fileName': fileName });
    let rows: Record<string, unknown>[];
    try {
      rows = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return ((await tx.execute(toSql(parts, params))) as unknown as { rows: Record<string, unknown>[] }).rows;
      });
    } catch (e) {
      throw new DataImportError(critical('strCannotExecuteSQLQuery'), [(e as Error).message]);
    }
    const columns = doc.columns.length ? [...doc.columns].sort((a, b) => a.index - b.index).map((c) => c.name) : rows[0] ? Object.keys(rows[0]) : [];
    if (doc.kind === 'csv') files.push({ name: fileName, data: new TextEncoder().encode(writeExportCsv(rows, doc.separator, columns)) });
    else files.push({ name: fileName, data: await writeWorkbook([{ name: 'Export Data', header: columns, rows: rows.map((r) => columns.map((c) => r[c] as unknown)) }]) });
  }
  if (files.length === 1) return { fileName: files[0]!.name, data: files[0]!.data };
  return { fileName: `${def.name.replace(/[\\/:*?"<>|]/g, '_')}.zip`, data: zipFiles(files) };
}
