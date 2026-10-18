import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Empty, ErrorText, Field, Spinner, TextInput } from '../components/ui.tsx';
import { bgDate, money } from '../format.ts';
import type { ScreenProps } from '../shell/workspace.tsx';
import { DocHeader, PrintableDoc, Signatures } from './common.tsx';

interface Header {
  companyName: string;
  bulstat: string;
  address: string;
}
interface P58 extends Header {
  rows: { id: number; inventoryNumber: string; name: string; personInCharge: string; location: string; category: string; accountNumber: string; accountDescription: string; dateOfCommissioning: string; depreciableAmount: string; currency: string; percentage: string }[];
}
interface Scrap extends Header {
  rows: { id: number; inventoryNumber: string; name: string; location: string; dateOfCommissioning: string; terminationDate: string | null; depreciationAmount: string }[];
}

/** Протокол по чл. 58 от ЗКПО / Протокол за бракуване на ДА (spFixedAssetProtocol58, spScrappingFixedAssetProtocol). */
export function AssetProtocol({ tab }: ScreenProps) {
  const kind = tab.params?.kind as 'protocol58' | 'scrapping';
  const ids = (tab.params?.ids as number[] | undefined) ?? [];
  const q = useQuery({
    queryKey: ['assetProtocol', kind, ids.join(',')],
    queryFn: () => api.get<P58 | Scrap>(kind === 'protocol58' ? `/assets/protocol58?ids=${ids.join(',')}` : `/assets/scrapping-protocol?ids=${ids.join(',')}`),
    staleTime: 0,
  });
  const [number, setNumber] = useState('1');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  if (q.isLoading) return <Empty><Spinner /></Empty>;
  if (q.error) return <div className="p-3"><ErrorText error={q.error} /></div>;
  const d = q.data!;
  return (
    <div className="h-full overflow-auto p-3">
      <PrintableDoc
        toolbar={
          <>
            <Field label="Протокол №"><TextInput className="w-24" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
            <Field label="от дата"><TextInput type="date" className="w-36" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </>
        }
      >
        {kind === 'protocol58' ? (
          <>
            <DocHeader company={d} title={`ПРОТОКОЛ № ${number} / ${bgDate(date)}`} subtitle="за въвеждане в експлоатация на дълготрайни активи по чл. 58 от ЗКПО" />
            <table className="grid-table [&_td]:whitespace-normal [&_th]:whitespace-normal">
              <thead>
                <tr>
                  <th>Инв. №</th><th>Наименование</th><th>МОЛ</th><th>Местоположение</th><th>Категория</th><th>Сметка</th>
                  <th>Дата на въвеждане</th><th className="text-right">Данъчна амортизируема ст-ст</th><th>Валута</th><th className="text-right">Год. норма %</th>
                </tr>
              </thead>
              <tbody>
                {(d as P58).rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.inventoryNumber}</td><td>{r.name}</td><td>{r.personInCharge}</td><td>{r.location}</td><td>{r.category}</td><td title={r.accountDescription}>{r.accountNumber}</td>
                    <td>{bgDate(r.dateOfCommissioning)}</td><td className="num">{money(r.depreciableAmount)}</td><td>{r.currency}</td><td className="num">{r.percentage.replace('.', ',')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-[12px]">Активите са въведени в експлоатация на посочените дати и се включват в данъчния амортизационен план.</p>
            <Signatures labels={['Предал:', 'Приел:', 'Управител:']} />
          </>
        ) : (
          <>
            <DocHeader company={d} title={`ПРОТОКОЛ № ${number} / ${bgDate(date)}`} subtitle="за бракуване на дълготрайни активи" />
            <table className="grid-table [&_td]:whitespace-normal [&_th]:whitespace-normal">
              <thead>
                <tr><th>Инв. №</th><th>Наименование</th><th>Местоположение</th><th>Дата на въвеждане</th><th>Дата на отписване</th><th className="text-right">Отчетна стойност</th></tr>
              </thead>
              <tbody>
                {(d as Scrap).rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.inventoryNumber}</td><td>{r.name}</td><td>{r.location}</td><td>{bgDate(r.dateOfCommissioning)}</td><td>{bgDate(r.terminationDate)}</td><td className="num">{money(r.depreciationAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-[12px]">Комисията установи, че посочените активи са негодни за по-нататъшна употреба и следва да бъдат бракувани.</p>
            <Signatures labels={['Председател:', 'Членове:', 'Управител:']} />
          </>
        )}
      </PrintableDoc>
    </div>
  );
}
