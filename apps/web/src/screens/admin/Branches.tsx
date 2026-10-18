import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Field, Panel, Select, TextInput, cx } from '../../components/ui.tsx';
import { useInvalidate, useLookups } from '../../session.tsx';

interface Address { countryId: number | null; city: string; postalCode: string; address: string; phone: string }
interface Branch { id?: number; code: string; name: string; contactName: string; address: Address | null }

const emptyAddress = (countryId: number | null): Address => ({ countryId, city: '', postalCode: '', address: '', phone: '' });

/** Клонове на моята фирма (03a 2.8). */
export function Branches() {
  const dialogs = useDialogs();
  const invalidate = useInvalidate();
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['branches'], queryFn: () => api.get<(Branch & { id: number; address: (Address & { id: number }) | null })[]>('/branches') });
  const [form, setForm] = useState<Branch | null>(null);
  const bg = lookups.data?.countries.find((c) => c.code === 'BG')?.id ?? null;

  const save = async () => {
    if (!form) return;
    const body = {
      code: form.code, name: form.name, contactName: form.contactName || null,
      address: form.address ? { ...form.address, postalCode: form.address.postalCode || null } : null,
    };
    try {
      if (form.id) await api.put(`/branches/${form.id}`, body);
      else await api.post('/branches', body);
      await invalidate('branches', 'lookups');
      setForm(null);
    } catch (e) {
      await dialogs.error(e, 'Клонът не може да бъде записан');
    }
  };
  const remove = async (id: number) => {
    if (!(await dialogs.confirm('Желаете ли изтриване на избрания клон?'))) return;
    try {
      await api.del(`/branches/${id}`);
      await invalidate('branches', 'lookups');
      setForm(null);
    } catch (e) {
      await dialogs.error(e);
    }
  };
  const setAddr = (p: Partial<Address>) => form && setForm({ ...form, address: { ...(form.address ?? emptyAddress(bg)), ...p } });

  return (
    <div className="flex max-w-[920px] gap-3">
      <Panel title="Клонове" className="w-80 shrink-0" actions={<Button className="h-6 px-2" icon={<Plus className="size-3.5" />} onClick={() => setForm({ code: '', name: '', contactName: '', address: emptyAddress(bg) })}>Нов</Button>}>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Код</th>
              <th>Име</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((b) => (
              <tr key={b.id} aria-selected={form?.id === b.id} className="cursor-default" onClick={() => setForm({ id: b.id, code: b.code, name: b.name, contactName: b.contactName ?? '', address: b.address ? { countryId: b.address.countryId, city: b.address.city ?? '', postalCode: b.address.postalCode ?? '', address: b.address.address ?? '', phone: b.address.phone ?? '' } : null })}>
                <td>{b.code}</td>
                <td className={cx(b.id === 1 && 'font-medium')}>{b.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {form && (
        <Panel title={form.id ? `Клон ${form.name}` : 'Нов клон'} className="flex-1">
          <div className="grid grid-cols-2 gap-2 p-3">
            <Field label="Код">
              <TextInput value={form.code} maxLength={50} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Име">
              <TextInput value={form.name} maxLength={50} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="МОЛ" className="col-span-2">
              <TextInput value={form.contactName} maxLength={50} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </Field>
            <Field label="Държава">
              <Select value={form.address?.countryId ?? ''} onChange={(e) => setAddr({ countryId: e.target.value ? Number(e.target.value) : null })}>
                <option value="" />
                {lookups.data?.countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Град">
              <TextInput value={form.address?.city ?? ''} maxLength={50} onChange={(e) => setAddr({ city: e.target.value })} />
            </Field>
            <Field label="Пощенски код">
              <TextInput value={form.address?.postalCode ?? ''} maxLength={10} onChange={(e) => setAddr({ postalCode: e.target.value })} />
            </Field>
            <Field label="Телефон">
              <TextInput value={form.address?.phone ?? ''} maxLength={50} onChange={(e) => setAddr({ phone: e.target.value })} />
            </Field>
            <Field label="Адрес" className="col-span-2">
              <TextInput value={form.address?.address ?? ''} maxLength={100} onChange={(e) => setAddr({ address: e.target.value })} />
            </Field>
            <div className="col-span-2 flex justify-end gap-2 pt-1">
              {form.id && form.id !== 1 && (
                <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => remove(form.id!)}>
                  Изтриване
                </Button>
              )}
              <Button variant="primary" icon={<Save className="size-3.5" />} onClick={save}>
                Запис
              </Button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
