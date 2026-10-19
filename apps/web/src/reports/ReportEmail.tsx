import { useState } from 'react';
import { buildXlsx, EMAIL_MESSAGES, reportAttachmentName, validateReportEmail, type XlsxSheet } from '@shmi/core';
import { api } from '../api.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Button, Dialog, Field, TextInput } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

/** Base64 of the workbook bytes (chunked: String.fromCharCode cannot take a large array at once). */
function toBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * "Изпращане по e-mail" of the report viewer (XAMLReportView e-mail form,
 * 07 5.1; 04b 3): До, Копие до, Тема, attachment name and text. The report
 * goes as an .xlsx attachment through the company's SMTP server.
 */
export function ReportEmailDialog({ title, sheets, endDate, entityType, onClose }: {
  title: string;
  sheets: () => XlsxSheet[];
  endDate?: string | null;
  entityType: string;
  onClose: () => void;
}) {
  const s = useSession();
  const dialogs = useDialogs();
  const [f, setF] = useState({ to: '', cc: '', subject: `${title} - ${s.company.name}`, fileName: reportAttachmentName(title, endDate), body: '' });
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const errors = validateReportEmail({ to: f.to, cc: f.cc, subject: f.subject });
    if (errors.length) return dialogs.messages('Изпращане по e-mail', errors);
    setBusy(true);
    try {
      const fileName = f.fileName.trim().toLowerCase().endsWith('.xlsx') ? f.fileName.trim() : `${f.fileName.trim() || title}.xlsx`;
      const r = await api.post<{ message: string }>('/email/report', {
        to: f.to, cc: f.cc || undefined, subject: f.subject, body: f.body || undefined, report: title, entityType,
        attachment: { fileName, contentBase64: toBase64(buildXlsx(sheets())) },
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
        <Field label="До" hint="Няколко адреса се разделят с „;“.">
          <TextInput aria-label="До" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="name@firma.bg" />
        </Field>
        <Field label="Копие до">
          <TextInput aria-label="Копие до" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} />
        </Field>
        <Field label="Тема">
          <TextInput aria-label="Тема" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <Field label="Прикачен файл">
          <TextInput aria-label="Прикачен файл" value={f.fileName} onChange={(e) => setF({ ...f, fileName: e.target.value })} />
        </Field>
        <Field label="Текст">
          <textarea aria-label="Текст на писмото" className="field-input h-24 py-1" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
