import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api } from '../../api.ts';
import { Button, Dialog, ErrorText, Spinner } from '../../components/ui.tsx';
import { bgDate, money } from '../../format.ts';
import { useSession } from '../../session.tsx';
import type { DiaryRow } from './model.ts';
import { PrintPortal, usePrint } from './PrintForms.tsx';

/** "Дневник на платежните документи" (spPaymentsDiary, 02c 1.6) for the given documents. */
export function DiaryDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const s = useSession();
  const q = useQuery({
    queryKey: ['payment-documents', 'diary', ids.join(',')],
    queryFn: () => api.get<DiaryRow[]>(`/payment-documents/diary?ids=${ids.join(',')}`),
    enabled: ids.length > 0,
  });
  const { printing, print } = usePrint();
  const table = (rows: DiaryRow[]) => (
    <table className="grid-table">
      <thead>
        <tr>
          <th>№</th>
          <th>Вид документ</th>
          <th>IBAN на наредителя</th>
          <th>Получател</th>
          <th>IBAN на получателя</th>
          <th>BIC</th>
          <th>Основание</th>
          <th className="text-right">Сума</th>
          <th>Дата</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="num">{r.id}</td>
            <td>{r.typeDescription}</td>
            <td className="font-mono">{r.customerIban}</td>
            <td>{r.receiver}</td>
            <td className="font-mono">{r.personIban}</td>
            <td>{r.personBic}</td>
            <td>{r.reason}</td>
            <td className="num">{money(r.qtty)}</td>
            <td>{bgDate(r.date.slice(0, 10))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <Dialog
      title="Дневник на платежните документи"
      onClose={onClose}
      width={980}
      footer={
        <>
          <Button icon={<Printer className="size-3.5" />} disabled={!q.data?.length} onClick={print}>
            Печат
          </Button>
          <Button variant="primary" onClick={onClose}>
            Затвори
          </Button>
        </>
      }
    >
      {ids.length === 0 ? (
        <div className="text-slate-500">Няма избрани записани документи.</div>
      ) : q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : q.data?.length ? (
        table(q.data)
      ) : (
        <div className="text-slate-500">Няма данни.</div>
      )}
      {printing && q.data && (
        <PrintPortal>
          <div style={{ fontSize: '9pt' }}>
            <div>{s.company.name}{s.company.bulstat ? `, ЕИК ${s.company.bulstat}` : ''}</div>
            <h1 style={{ fontSize: '14pt', fontWeight: 'bold', margin: '2mm 0' }}>Дневник на платежните документи</h1>
            {table(q.data)}
          </div>
        </PrintPortal>
      )}
    </Dialog>
  );
}
