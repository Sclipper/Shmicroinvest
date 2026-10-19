import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Send } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Spinner, TextInput } from '../../components/ui.tsx';
import { useCan } from '../../session.tsx';

interface SmtpView { host: string; port: number; userName: string; email: string; enableSsl: boolean; hasPassword: boolean; password: string }

/**
 * Настройки > E-mail (SmtpConfigurationView, 06 3.2): the company's SMTP
 * server for "Изпращане по e-mail". The stored password is never sent back;
 * an empty password field keeps it.
 */
export function SmtpPage() {
  const can = useCan();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const editable = can('UI_Other_Settings');
  const q = useQuery({ queryKey: ['settings', 'smtp'], queryFn: () => api.get<SmtpView>('/settings/smtp') });
  const [f, setF] = useState({ host: '', port: '587', userName: '', password: '', email: '', enableSsl: true, clearPassword: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setF({ host: q.data.host, port: String(q.data.port), userName: q.data.userName, password: '', email: q.data.email, enableSsl: q.data.enableSsl, clearPassword: false });
  }, [q.data]);
  if (q.isError) return <Empty>{q.error.message}</Empty>;
  if (!q.data) return <Empty><Spinner /></Empty>;

  const save = async () => {
    try {
      await api.put('/settings/smtp', {
        host: f.host, port: Number(f.port) || 0, userName: f.userName, email: f.email, enableSsl: f.enableSsl,
        ...(f.clearPassword ? { password: '' } : f.password ? { password: f.password } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['settings', 'smtp'] });
      return true;
    } catch (e) {
      await dialogs.error(e, 'E-mail');
      return false;
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      if (!(await save())) return;
      const r = await api.post<{ message: string; to: string }>('/settings/smtp/test', {});
      await dialogs.alert(`${r.message} (${r.to})`, 'Тестово изпращане');
    } catch (e) {
      await dialogs.error(e, 'Тестово изпращане');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Save className="size-3.5" />} disabled={!editable} onClick={save}>
          Запис
        </Button>
        <Button icon={<Send className="size-3.5" />} disabled={!editable || busy || !f.host.trim()} onClick={test}>
          Тестово изпращане
        </Button>
      </CommandBar>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <Panel title="Сървър за изходяща поща (SMTP)" className="max-w-[560px]">
          <div className="grid grid-cols-[1fr_110px] gap-x-3 gap-y-2 p-3">
            <Field label="SMTP сървър">
              <TextInput aria-label="SMTP сървър" value={f.host} disabled={!editable} placeholder="smtp.firma.bg" onChange={(e) => setF({ ...f, host: e.target.value })} />
            </Field>
            <Field label="Порт">
              <TextInput aria-label="Порт" inputMode="numeric" value={f.port} disabled={!editable} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Потребител" className="col-span-2">
              <TextInput aria-label="Потребител на SMTP" value={f.userName} disabled={!editable} autoComplete="off" onChange={(e) => setF({ ...f, userName: e.target.value })} />
            </Field>
            <Field label="Парола" className="col-span-2" hint={q.data.hasPassword ? `Запазена парола ${q.data.password}. Оставете полето празно, за да я запазите.` : 'Няма запазена парола.'}>
              <TextInput aria-label="Парола на SMTP" type="password" value={f.password} disabled={!editable || f.clearPassword} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} />
            </Field>
            {q.data.hasPassword && (
              <Checkbox className="col-span-2" label="Изтриване на запазената парола" checked={f.clearPassword} disabled={!editable} onChange={(v) => setF({ ...f, clearPassword: v, password: '' })} />
            )}
            <Field label="E-mail адрес на подателя" className="col-span-2">
              <TextInput aria-label="E-mail адрес на подателя" value={f.email} disabled={!editable} placeholder="office@firma.bg" onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
            <Checkbox className="col-span-2" label="Защитена връзка (SSL/TLS)" checked={f.enableSsl} disabled={!editable} onChange={(v) => setF({ ...f, enableSsl: v })} />
          </div>
        </Panel>
        <p className="mt-2 max-w-[560px] text-[12px] text-slate-500">
          Справките се изпращат като прикачен Excel файл от бутона „Изпращане по e-mail“. Без SMTP сървър изпращането не е възможно. Празен сървър изключва изпращането.
        </p>
      </div>
    </div>
  );
}
