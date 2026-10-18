import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { isMonthLocked } from '@shmi/core';
import { api } from '../../api.ts';
import { bgDate } from '../../format.ts';
import { Button, Panel } from '../../components/ui.tsx';
import { useCan, useLookups, useSession } from '../../session.tsx';
import { useWorkspace } from '../../shell/workspace.tsx';
import { InfoRow } from './common.tsx';

interface MyCompanyData {
  name: string; name1: string | null; bulstat: string; vatId: string | null; isVat: boolean; isNotVat: boolean; contactName: string | null; accountant: string; email: string | null;
  addresses: { addressTypeId: number | null; countryId: number | null; city: string | null; postalCode: string | null; address: string | null; phone: string | null }[];
  bankAccounts: { account: string }[];
}
interface Role { id: number; name: string }

const MONTHS = ['Ян', 'Фев', 'Мар', 'Апр', 'Май', 'Юни', 'Юли', 'Авг', 'Сеп', 'Окт', 'Ное', 'Дек'];

/** Активна фирма (Ctrl+A): read-only summary of the open company, year and user. */
export function ActiveCompany() {
  const s = useSession();
  const can = useCan();
  const ws = useWorkspace();
  const lookups = useLookups();
  const my = useQuery({ queryKey: ['my-company'], queryFn: () => api.get<MyCompanyData>('/my-company') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const m = my.data;
  const addr = m?.addresses[0];
  const addrText = addr
    ? [lookups.data?.countries.find((c) => c.id === addr.countryId)?.name, [addr.postalCode, addr.city].filter(Boolean).join(' '), addr.address].filter(Boolean).join(', ')
    : '';
  const locked = MONTHS.filter((_, i) => isMonthLocked(s.year.lockedMonths, i + 1));

  return (
    <div className="h-full overflow-auto p-3">
      <div className="flex max-w-[1000px] flex-wrap items-start gap-3">
        <Panel
          title="Фирма"
          className="min-w-[460px] flex-1"
          actions={can('UI_Edit_Administration_MyCompany') ? <Button variant="ghost" className="-my-1 h-6" icon={<Building2 className="size-3.5" />} onClick={() => ws.open('myCompany')}>Моята фирма</Button> : undefined}
        >
          <table className="grid-table">
            <tbody>
              <InfoRow label="Име на фирмата"><span className="font-semibold">{s.company.name}</span></InfoRow>
              <InfoRow label="Име на английски">{m?.name1}</InfoRow>
              <InfoRow label="ЕИК">{s.company.bulstat}</InfoRow>
              <InfoRow label="Регистрация по ЗДДС">{s.company.isVat ? `Да, ДДС номер ${s.company.vatId}` : m?.isNotVat ? 'Не подлежи на регистрация' : 'Не'}</InfoRow>
              <InfoRow label="МОЛ">{m?.contactName}</InfoRow>
              <InfoRow label="Главен счетоводител">{m?.accountant}</InfoRow>
              <InfoRow label="E-mail">{m?.email}</InfoRow>
              <InfoRow label="Адрес">{addrText}</InfoRow>
              <InfoRow label="Телефон">{addr?.phone}</InfoRow>
              <InfoRow label="Банкова сметка">{m?.bankAccounts.map((b) => b.account).join(', ')}</InfoRow>
              <InfoRow label="База данни"><span className="font-mono text-[12px]">{s.company.db}</span></InfoRow>
            </tbody>
          </table>
        </Panel>
        <Panel title="Работна сесия" className="w-[440px]">
          <table className="grid-table">
            <tbody>
              <InfoRow label="Потребител"><span className="font-semibold">{s.user.name}</span></InfoRow>
              <InfoRow label="Потребителска група">{roles.data?.find((r) => r.id === s.user.roleId)?.name ?? (s.user.isAdmin ? 'Администратор' : '')}</InfoRow>
              <InfoRow label="Счетоводна година"><span className="font-semibold">{s.year.year}</span> (от {bgDate(s.year.startDate)})</InfoRow>
              <InfoRow label="Състояние на годината">
                {s.year.isLocked ? <span className="text-red-700">Заключена за редакция</span> : locked.length ? <span className="text-amber-700">Заключени месеци: {locked.join(', ')}</span> : 'Отворена'}
                {s.year.isConcluded && ', приключена'}
              </InfoRow>
              <InfoRow label="Работна дата">{bgDate(s.workingDate)}</InfoRow>
              <InfoRow label="Клон">{s.branch?.name}</InfoRow>
              <InfoRow label="Основна валута">{s.baseCurrency === 'EUR' ? 'EUR – Евро' : 'BGN – Български лев'}</InfoRow>
              <InfoRow label="Сметкоплан">{s.chartIsEmpty ? <span className="text-amber-700">не е избран</span> : 'Фирмен (Търговски)'}</InfoRow>
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
