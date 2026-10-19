import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Checkbox, CommandBar, Empty, Field, Panel, Spinner, TextInput } from '../../components/ui.tsx';

type UserSettings = Record<string, string>;

/**
 * Настройки > Лични (06 3.2): Delta's local keys of the current user.
 * ZipPassword / IsZipPasswordEnabled protect the downloaded backups and the
 * NAP export ZIP; EmailUserName / EmailSignature are the sender name and the
 * signature of report e-mails; IsFileOpenAutomatically is kept for
 * compatibility (a browser opens downloads by its own settings).
 */
export function LocalPage() {
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'user'], queryFn: () => api.get<UserSettings>('/settings/user') });
  const [f, setF] = useState({ userName: '', signature: '', zipEnabled: false, zipPassword: '', fileOpen: false });
  useEffect(() => {
    if (q.data) setF({ userName: q.data.EmailUserName ?? '', signature: q.data.EmailSignature ?? '', zipEnabled: q.data.IsZipPasswordEnabled === 'True', zipPassword: '', fileOpen: q.data.IsFileOpenAutomatically === 'True' });
  }, [q.data]);
  if (q.isError) return <Empty>{q.error.message}</Empty>;
  if (!q.data) return <Empty><Spinner /></Empty>;
  const hasPassword = q.data.HasZipPassword === 'True';

  const save = async () => {
    try {
      await api.put('/settings/user', {
        EmailUserName: f.userName, EmailSignature: f.signature,
        IsZipPasswordEnabled: f.zipEnabled ? 'True' : 'False', IsFileOpenAutomatically: f.fileOpen ? 'True' : 'False',
        ...(f.zipPassword ? { ZipPassword: f.zipPassword } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['settings', 'user'] });
      await dialogs.alert('Данните са записани успешно.', 'Настройки');
    } catch (e) {
      await dialogs.error(e, 'Настройки');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CommandBar>
        <Button variant="primary" icon={<Save className="size-3.5" />} onClick={() => void save()}>
          Запис
        </Button>
      </CommandBar>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <Panel title="E-mail" className="max-w-[560px]">
          <div className="flex flex-col gap-2 p-3">
            <Field label="Име на подателя" hint="Показва се пред адреса на подателя в изпратените справки.">
              <TextInput aria-label="Име на подателя" value={f.userName} maxLength={100} onChange={(e) => setF({ ...f, userName: e.target.value })} />
            </Field>
            <Field label="Подпис" hint="Добавя се под текста на всяко изпратено писмо.">
              <textarea aria-label="Подпис" className="field-input h-20 py-1" value={f.signature} maxLength={2000} onChange={(e) => setF({ ...f, signature: e.target.value })} />
            </Field>
          </div>
        </Panel>
        <Panel title="Архиви" className="max-w-[560px]">
          <div className="flex flex-col gap-2 p-3">
            <Checkbox label="Защита на архивите с парола" checked={f.zipEnabled} onChange={(v) => setF({ ...f, zipEnabled: v })} />
            <Field label="Парола на архивите" hint={hasPassword ? 'Има запазена парола. Оставете полето празно, за да я запазите.' : 'Няма запазена парола.'}>
              <TextInput aria-label="Парола на архивите" type="password" autoComplete="new-password" value={f.zipPassword} disabled={!f.zipEnabled} onChange={(e) => setF({ ...f, zipPassword: e.target.value })} />
            </Field>
            <p className="text-[12px] text-slate-500">
              Изтеглените архиви на фирмата и файловете за НАП се дават в ZIP архив, защитен с паролата. При възстановяване от такъв архив се използва същата парола.
            </p>
            <Checkbox label="Автоматично отваряне на експортирания файл" checked={f.fileOpen} onChange={(v) => setF({ ...f, fileOpen: v })} />
            <p className="text-[12px] text-slate-500">Браузърът отваря изтеглените файлове според собствените си настройки за изтегляне.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
