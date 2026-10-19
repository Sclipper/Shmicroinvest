import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EMAIL_MESSAGES, reportAttachmentName, validateReportEmail, withAttachmentExtension, type ReportAttachmentFormat } from '@shmi/core';
import { api } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Dialog, Field, Select, TextInput } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

/** Base64 of the file bytes (chunked: String.fromCharCode cannot take a large array at once). */
function toBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const FORMATS: { value: ReportAttachmentFormat; label: string }[] = [
  { value: 'pdf', label: 'PDF (.pdf)' },
  { value: 'xlsx', label: 'Excel (.xlsx)' },
];

/**
 * "Изпращане по e-mail" of the report viewer (XAMLReportView e-mail form,
 * 07 5.1; 04b 3; 05 11.3): До, Копие до, Тема, attachment format, name and
 * text. The report goes as a PDF attachment (or .xlsx) through the company's
 * SMTP server; for a report on one partner "До" starts with the partner's
 * e-mail.
 */
export function ReportEmailDialog({ title, attachment, endDate, entityType, partnerId, onClose }: {
  title: string;
  attachment: (format: ReportAttachmentFormat) => Promise<Uint8Array>;
  endDate?: string | null;
  entityType: string;
  partnerId?: number | null;
  onClose: () => void;
}) {
  const s = useSession();
  const dialogs = useDialogs();
  const [f, setF] = useState({ to: '', cc: '', subject: `${title} - ${s.company.name}`, format: 'pdf' as ReportAttachmentFormat, fileName: reportAttachmentName(title, endDate, 'pdf'), body: '' });
  const [busy, setBusy] = useState(false);
  const toTouched = useRef(false);
  const partner = useQuery({
    queryKey: ['partners', partnerId],
    queryFn: () => api.get<{ id: number; email: string | null }>(`/partners/${partnerId}`),
    enabled: !!partnerId,
    retry: false,
    staleTime: 30_000,
  });
  const partnerEmail = partner.data?.email?.trim() ?? '';
  useEffect(() => {
    if (partnerEmail && !toTouched.current) setF((cur) => (cur.to ? cur : { ...cur, to: partnerEmail }));
  }, [partnerEmail]);

  const send = async () => {
    const errors = validateReportEmail({ to: f.to, cc: f.cc, subject: f.subject });
    if (errors.length) return dialogs.messages('Изпращане по e-mail', errors);
    setBusy(true);
    try {
      const fileName = withAttachmentExtension(f.fileName, f.format, title);
      const bytes = await attachment(f.format);
      const r = await api.post<{ message: string }>('/email/report', {
        to: f.to, cc: f.cc || undefined, subject: f.subject, body: f.body || undefined, report: title, entityType,
        attachment: { fileName, contentBase64: toBase64(bytes) },
      });
      await dialogs.alert(r.message || EMAIL_MESSAGES.strEmailSendSuccessfully, 'Изпращане по e-mail');
      onClose();
    } catch (e) {
      await dialogs.error(e, 'Изпращане по e-mail');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Изпращане по e-mail"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="primary" disabled={busy} onClick={send}>
            {busy ? 'Изпращане…' : 'Изпрати'}
          </Button>
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Field label="До" hint={partnerEmail && f.to === partnerEmail ? 'E-mail на партньора от справката. Няколко адреса се разделят с „;“.' : 'Няколко адреса се разделят с „;“.'}>
          <TextInput
            aria-label="До"
            value={f.to}
            onChange={(e) => {
              toTouched.current = true;
              setF({ ...f, to: e.target.value });
            }}
            placeholder="name@firma.bg"
          />
        </Field>
        <Field label="Копие до">
          <TextInput aria-label="Копие до" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} />
        </Field>
        <Field label="Тема">
          <TextInput aria-label="Тема" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <div className="flex gap-2">
          <Field label="Формат">
            <Select
              aria-label="Формат на прикачения файл"
              className="w-36"
              value={f.format}
              onChange={(e) => {
                const format = e.target.value as ReportAttachmentFormat;
                setF({ ...f, format, fileName: withAttachmentExtension(f.fileName, format, title) });
              }}
            >
              {FORMATS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Прикачен файл" className="flex-1">
            <TextInput aria-label="Прикачен файл" value={f.fileName} onChange={(e) => setF({ ...f, fileName: e.target.value })} />
          </Field>
        </div>
        <Field label="Текст">
          <textarea aria-label="Текст на писмото" className="field-input h-24 py-1" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
