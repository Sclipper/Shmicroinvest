import type { DictionaryField } from '@shmi/core';
export interface Message {
  key: string;
  text: string;
  severity: 'critical' | 'warning';
  /** Add-to-list questions (03a 8.1): the header field of the new text. */
  field?: DictionaryField;
}

export class ApiError extends Error {
  status: number;
  messages?: Message[];
  code?: string;
  constructor(status: number, message: string, messages?: Message[], code?: string) {
    super(message);
    this.status = status;
    this.messages = messages;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.messages, data?.code);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
