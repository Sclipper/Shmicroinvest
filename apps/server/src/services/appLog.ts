import { appendFile, readFile } from 'node:fs/promises';

/**
 * Application log (Дневник на приложението, 06 7.2). Delta writes XML
 * <LogEntry> records (DateTime dd.MM.yyyy HH:mm:ss, BuildVersion, Message);
 * here each entry is a JSON line in a file when one is configured, with an
 * in-memory copy of the most recent entries.
 */
export interface LogEntry {
  dateTime: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  details?: string;
  company?: string | null;
  user?: string | null;
}

const MAX = 1000;
const memory: LogEntry[] = [];
let file: string | null = null;

export function configureAppLog(path: string | null) {
  file = path;
}

export async function logApp(entry: Omit<LogEntry, 'dateTime'>) {
  const e: LogEntry = { dateTime: new Date().toISOString(), ...entry };
  memory.push(e);
  if (memory.length > MAX) memory.splice(0, memory.length - MAX);
  if (file) await appendFile(file, `${JSON.stringify(e)}\n`).catch(() => {});
}

/** Newest first. Reads the file when configured so the log survives restarts. */
export async function readAppLog(limit = 500): Promise<LogEntry[]> {
  let rows = memory;
  if (file) {
    const text = await readFile(file, 'utf8').catch(() => '');
    rows = text.split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l) as LogEntry];
      } catch {
        return [];
      }
    });
  }
  return rows.slice(-limit).reverse();
}

export function clearAppLogMemory() {
  memory.length = 0;
}
