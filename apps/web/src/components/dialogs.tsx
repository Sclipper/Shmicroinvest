import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Message } from '../api.ts';
import { ApiError } from '../api.ts';
import { Button, Dialog } from './ui.tsx';

interface Pending {
  kind: 'alert' | 'confirm' | 'messages';
  title: string;
  text?: ReactNode;
  messages?: Message[];
  /** messages dialog: allow continuing when there are only warnings */
  canContinue?: boolean;
  resolve: (v: boolean) => void;
}

interface DialogApi {
  alert: (text: ReactNode, title?: string) => Promise<void>;
  confirm: (text: ReactNode, title?: string) => Promise<boolean>;
  /** Shows validation messages; resolves true when the user chooses to continue (warnings only). */
  messages: (title: string, messages: Message[], canContinue?: boolean) => Promise<boolean>;
  /** Shows an error (ApiError messages, or plain text). */
  error: (e: unknown, title?: string) => Promise<void>;
}

const Ctx = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Pending[]>([]);
  const push = useCallback((p: Omit<Pending, 'resolve'>) => new Promise<boolean>((resolve) => setStack((s) => [...s, { ...p, resolve }])), []);
  const close = (p: Pending, v: boolean) => {
    setStack((s) => s.filter((x) => x !== p));
    p.resolve(v);
  };
  const apiValue: DialogApi = {
    alert: async (text, title = 'Шмелта Про') => {
      await push({ kind: 'alert', title, text });
    },
    confirm: (text, title = 'Потвърждение') => push({ kind: 'confirm', title, text }),
    messages: (title, messages, canContinue = false) => push({ kind: 'messages', title, messages, canContinue }),
    error: async (e, title = 'Грешка') => {
      if (e instanceof ApiError && e.messages?.length) await push({ kind: 'messages', title, text: e.message, messages: e.messages });
      else await push({ kind: 'alert', title, text: e instanceof Error ? e.message : String(e) });
    },
  };
  return (
    <Ctx.Provider value={apiValue}>
      {children}
      {stack.map((p, i) => (
        <Dialog
          key={i}
          title={p.title}
          onClose={() => close(p, false)}
          width={p.kind === 'messages' ? 560 : 420}
          footer={
            p.kind === 'confirm' ? (
              <>
                <Button variant="primary" data-autofocus onClick={() => close(p, true)}>
                  Да
                </Button>
                <Button onClick={() => close(p, false)}>Не</Button>
              </>
            ) : p.kind === 'messages' && p.canContinue ? (
              <>
                <Button variant="primary" data-autofocus onClick={() => close(p, true)}>
                  Продължи
                </Button>
                <Button onClick={() => close(p, false)}>Отказ</Button>
              </>
            ) : (
              <Button variant="primary" data-autofocus onClick={() => close(p, true)}>
                OK
              </Button>
            )
          }
        >
          {p.text && <div className="mb-2 whitespace-pre-line">{p.text}</div>}
          {p.messages && (
            <ul className="flex flex-col gap-1">
              {p.messages.map((m, j) => (
                <li key={j} className="flex items-start gap-2">
                  <span className={m.severity === 'critical' ? 'text-red-600' : 'text-amber-600'}>{m.severity === 'critical' ? '⛔' : '⚠'}</span>
                  <span>{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      ))}
    </Ctx.Provider>
  );
}

export function useDialogs() {
  const c = useContext(Ctx);
  if (!c) throw new Error('DialogProvider missing');
  return c;
}
