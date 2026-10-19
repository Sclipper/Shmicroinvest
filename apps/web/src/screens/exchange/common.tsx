import { useRef, type ReactNode } from 'react';
import { FileUp } from 'lucide-react';
import { ApiError, type Message } from '../../api.ts';
import { Button, cx } from '../../components/ui.tsx';

/** Multipart upload: the file plus JSON-encoded fields (the server parses each field as JSON when it can). */
export async function upload<T>(url: string, file: File, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const fd = new FormData();
  fd.set('file', file, file.name);
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    fd.set(k, JSON.stringify(v));
  }
  const res = await fetch(`/api${url}`, { method: 'POST', body: fd, credentials: 'same-origin', signal });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.messages);
  return data as T;
}

/** POST (or GET) returning a file; saves it in the browser. Returns the response headers. */
export async function download(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Headers> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.messages);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]!) : 'file';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return res.headers;
}

/** File chooser button with the chosen name ("Път до файла"). */
export function FileInput({ file, onChange, accept, label = 'Избор на файл...', testId }: { file: File | null; onChange: (f: File | null) => void; accept?: string; label?: string; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <input ref={ref} type="file" className="hidden" accept={accept} data-testid={testId} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      <Button icon={<FileUp className="size-3.5" />} onClick={() => ref.current?.click()}>{label}</Button>
      <span className={cx('truncate text-[13px]', file ? 'text-slate-800' : 'text-slate-400')}>{file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : 'Не е избран файл'}</span>
    </div>
  );
}

/** Inline list of import messages (critical red, warnings amber). */
export function MessageList({ messages }: { messages: Message[] }) {
  if (!messages.length) return null;
  return (
    <ul className="max-h-60 space-y-1 overflow-auto rounded-sm border border-slate-200 bg-slate-50 p-2 text-[13px]">
      {messages.map((m, i) => (
        <li key={i} className={m.severity === 'critical' ? 'text-red-700' : 'text-amber-700'}>{m.text}</li>
      ))}
    </ul>
  );
}

/** Wizard frame: numbered steps on the left, the page on the right. */
export function Wizard({ steps, step, children, footer }: { steps: string[]; step: number; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        <ol className="w-56 shrink-0 space-y-1 border-r border-slate-200 bg-slate-50 p-3 text-[13px]">
          {steps.map((s, i) => (
            <li key={s} className={cx('rounded-sm px-2 py-1', i === step ? 'bg-brand-500 text-white' : i < step ? 'text-slate-700' : 'text-slate-400')}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
        <div className="min-w-0 flex-1 overflow-auto p-4">{children}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2">{footer}</div>
    </div>
  );
}

export const errorMessages = (e: unknown): Message[] =>
  e instanceof ApiError ? (e.messages?.length ? e.messages : [{ key: 'error', text: e.message, severity: 'critical' }]) : [{ key: 'error', text: e instanceof Error ? e.message : String(e), severity: 'critical' }];

export const yearRange = (year: number) => ({ from: `${year}-01-01`, to: `${year}-12-31` });
