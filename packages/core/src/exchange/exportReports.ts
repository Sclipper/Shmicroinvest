import { zipStore } from '../zip.ts';
import { parseXml, type XmlElement } from './xml.ts';
import { DataImportError, critical } from './messages.ts';

/**
 * "Експорт към външни системи" (spec 04a 8.3): data-driven exports defined by
 * ExportReport XML documents (namespace http://schemas.microinvest.net/ExportReports).
 */
export const EXPORT_REPORTS_NS = 'http://schemas.microinvest.net/ExportReports';

export interface ExportReportParameter { name: string; title: string; type: 'DateTime' | 'Text'; description: string }
export interface ExportColumn { name: string; index: number; type: 'Integer' | 'Decimal' | 'String' | 'DateTime' | 'RecordNumber'; format: string; isSummarizable: boolean }
export interface ExportDocument {
  kind: 'excel' | 'csv';
  name: string;
  description: string;
  fileNameFormat: string;
  query: string;
  separator: string;
  columns: ExportColumn[];
}
export interface ExportReport { name: string; description: string; parameters: ExportReportParameter[]; documents: ExportDocument[] }

const childText = (e: XmlElement, local: string) => e.children.find((c) => c.local === local)?.text.trim() ?? '';
const childList = (e: XmlElement, local: string) => e.children.find((c) => c.local === local)?.children ?? [];

export function parseExportReport(xml: string): ExportReport {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    throw new DataImportError(critical('strInvalidExportReportDefinition', (e as Error).message));
  }
  if (root.local !== 'ExportReport') throw new DataImportError(critical('strInvalidExportReportDefinition', root.name));
  const name = childText(root, 'Name');
  if (!name) throw new DataImportError(critical('strInvalidExportReportDefinition', 'Name'));
  const parameters = childList(root, 'Parameters').map((p): ExportReportParameter => ({
    name: childText(p, 'Name'),
    title: childText(p, 'Title') || childText(p, 'Name'),
    type: childText(p, 'Type') === 'DateTime' ? 'DateTime' : 'Text',
    description: childText(p, 'Description'),
  }));
  const documents = childList(root, 'Documents').map((d): ExportDocument => {
    const typeAttr = Object.entries(d.attrs).find(([k]) => k === 'type' || k.endsWith(':type'))?.[1] ?? '';
    const kind: ExportDocument['kind'] = /CSV/i.test(`${typeAttr} ${d.local}`) ? 'csv' : 'excel';
    const query = childText(d, 'Query');
    if (!query) throw new DataImportError(critical('strInvalidExportReportDefinition', `Query (${childText(d, 'Name')})`));
    return {
      kind,
      name: childText(d, 'Name'),
      description: childText(d, 'Description'),
      fileNameFormat: childText(d, 'FileNameFormat') || childText(d, 'Name') || 'export',
      query,
      separator: d.children.find((c) => c.local === 'Separator')?.text || ';',
      columns: childList(d, 'Columns').map((c, i) => ({
        name: childText(c, 'Name'),
        index: Number(childText(c, 'Index') || i),
        type: (childText(c, 'Type') || 'String') as ExportColumn['type'],
        format: childText(c, 'Format'),
        isSummarizable: childText(c, 'IsSummarizable') === 'true',
      })),
    };
  });
  return { name, description: childText(root, 'Description'), parameters, documents };
}

/** All parameters must be filled (strExportReportParameterNotFilled). */
export function checkExportParameters(r: ExportReport, values: Record<string, string | null | undefined>) {
  for (const p of r.parameters) {
    const v = values[p.name];
    if (v === undefined || v === null || v === '') throw new DataImportError(critical('strExportReportParameterNotFilled', p.title));
  }
}

/**
 * Replaces @name parameters (outside string literals) by $1..$n placeholders.
 * Names without a value are left as they are, so the database rejects them.
 */
export function bindNamedParameters(query: string, values: Record<string, unknown>): { sql: string; params: unknown[]; parts: (string | number)[] } {
  const params: unknown[] = [];
  const parts: (string | number)[] = [''];
  const index = new Map<string, number>();
  const lookup = new Map(Object.entries(values).map(([k, v]) => [k.replace(/^@/, '').toLowerCase(), v]));
  let out = '';
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    if (ch === "'") {
      const j = query.indexOf("'", i + 1);
      const end = j < 0 ? query.length : j + 1;
      out += query.slice(i, end);
      parts[parts.length - 1] += query.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '@' && /[A-Za-z_]/.test(query[i + 1] ?? '')) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(query.slice(i))!;
      const key = m[1]!.toLowerCase();
      if (lookup.has(key)) {
        if (!index.has(key)) {
          params.push(lookup.get(key));
          index.set(key, params.length);
        }
        out += `$${index.get(key)}`;
        parts.push(index.get(key)! - 1, '');
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    parts[parts.length - 1] += ch;
    i++;
  }
  return { sql: out, params, parts };
}

/** Only one read-only statement is allowed (SELECT / WITH). */
export function isReadOnlyQuery(sql: string): boolean {
  const t = sql.trim().replace(/;\s*$/, '');
  if (t.includes(';')) return false;
  return /^(select|with)\b/i.test(t);
}

/**
 * Names an export query may not reference: the users table and its password
 * hashes, the stored configuration (it holds service credentials), the
 * server's role catalogs and the file, large-object, remote-connection and
 * settings functions. Delta runs these queries with the application's SQL
 * login (04a 8.3); here the definitions are user content, so they are fenced.
 */
export const EXPORT_QUERY_FORBIDDEN = [
  'users', 'password_hash', 'passwordhash', 'sessions', 'configuration',
  'pg_shadow', 'pg_authid', 'pg_user', 'pg_user_mapping', 'pg_user_mappings', 'pg_hba_file_rules', 'pg_file_settings',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_tmpdir',
  'lo_import', 'lo_export', 'lo_get', 'lo_open', 'loread', 'dblink', 'dblink_exec', 'dblink_connect',
  'set_config', 'current_setting', 'pg_reload_conf', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
] as const;

/** First forbidden name referenced by the query (outside string literals and comments), else null. */
export function forbiddenQueryReference(query: string): string | null {
  let s = query.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/'(?:[^']|'')*'/g, ' ');
  // Quoted identifiers count by their content; dollar-quoted strings are refused outright (they could hide anything).
  if (/\$[A-Za-z_0-9]*\$/.test(s)) return '$$';
  s = s.replace(/"((?:[^"]|"")*)"/g, (_, x: string) => ` ${x.replace(/""/g, '"')} `);
  const tokens = new Set(s.toLowerCase().split(/[^a-z0-9_$]+/).filter(Boolean));
  return EXPORT_QUERY_FORBIDDEN.find((n) => tokens.has(n)) ?? null;
}

/** Formats a .NET-style date pattern subset (yyyy, yy, MM, dd) of an ISO date. */
export function formatDatePattern(iso: string, pattern: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  const parts: Record<string, string> = { yyyy: y!, yy: y!.slice(2), MM: m!, dd: d! };
  return pattern.replace(/yyyy|yy|MM|dd/g, (t) => parts[t]!);
}

/**
 * FileNameFormat: "{Param}" or "{Param:yyyyMM}" are replaced by parameter
 * values; "{0}", "{1}" address parameters by position.
 */
export function exportFileName(doc: ExportDocument, r: ExportReport, values: Record<string, string>): string {
  const base = doc.fileNameFormat.replace(/\{([^}:]+)(?::([^}]+))?\}/g, (_, key: string, pattern?: string) => {
    const p = /^\d+$/.test(key) ? r.parameters[Number(key)] : r.parameters.find((x) => x.name.replace(/^@/, '') === key.replace(/^@/, ''));
    const v = p ? values[p.name] ?? '' : '';
    return pattern && /^\d{4}-\d{2}-\d{2}/.test(v) ? formatDatePattern(v, pattern) : v;
  });
  return `${base.replace(/[\\/:*?"<>|]/g, '_')}.${doc.kind === 'csv' ? 'csv' : 'xlsx'}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${pad(v.getDate())}.${pad(v.getMonth() + 1)}.${v.getFullYear()}`;
  return String(v);
}

/** Each value followed by the separator (a trailing separator on every line), CRLF line ends. */
export function writeExportCsv(rows: Record<string, unknown>[], separator: string, columns?: string[]): string {
  if (!rows.length) return '';
  const cols = columns?.length ? columns : Object.keys(rows[0]!);
  return rows.map((r) => cols.map((c) => csvValue(r[c]) + separator).join('') + '\r\n').join('');
}

/** Multi-file exports go out as one stored ZIP. */
export const zipFiles = (files: { name: string; data: Uint8Array }[], date = new Date()) => zipStore(files, date);
