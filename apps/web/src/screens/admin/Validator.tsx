import { useState } from 'react';
import { CheckCircle2, ScanSearch, XCircle } from 'lucide-react';
import { api } from '../../api.ts';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Panel, TextInput, cx } from '../../components/ui.tsx';
import { useLookups } from '../../session.tsx';

interface Result { kind: 'iban' | 'vat' | 'eik' | 'egn' | 'lnch' | 'unknown'; valid: boolean; details?: Record<string, string> }
interface Check { code: string; result: Result; at: Date }

const KIND: Record<Result['kind'], string> = { iban: 'IBAN', vat: 'ДДС номер', eik: 'ЕИК (БУЛСТАТ)', egn: 'ЕГН', lnch: 'ЛНЧ', unknown: 'Неразпознат код' };

/** Проверка на ДДС номер, ЕИК, ЕГН, IBAN (Alt+V). */
export function Validator() {
  const dialogs = useDialogs();
  const lookups = useLookups();
  const [code, setCode] = useState('');
  const [history, setHistory] = useState<Check[]>([]);
  const last = history[0];

  const check = async () => {
    const c = code.trim().replace(/\s/g, '');
    if (!c) return;
    try {
      const result = await api.get<Result>(`/validator/${encodeURIComponent(c)}`);
      setHistory((h) => [{ code: c.toUpperCase(), result, at: new Date() }, ...h].slice(0, 50));
    } catch (e) {
      await dialogs.error(e);
    }
  };

  const details = (r: Result) => {
    const d = r.details ?? {};
    const out: [string, string][] = [];
    if (d.country) out.push(['Държава', `${d.country}${lookups.data?.countries.find((c) => c.code === d.country) ? ` – ${lookups.data.countries.find((c) => c.code === d.country)!.name}` : ''}`]);
    if (d.bankCode) {
      const bank = lookups.data?.banks.find((b) => b.code && d.bankCode && b.code.toUpperCase().startsWith(d.bankCode.toUpperCase()));
      out.push(['Банков код', `${d.bankCode}${bank ? ` – ${bank.name}` : ''}`]);
    }
    if (d.birthDate) out.push(['Дата на раждане', d.birthDate]);
    if (d.sex) out.push(['Пол', d.sex]);
    return out;
  };

  return (
    <div className="h-full overflow-auto p-3">
      <div className="flex max-w-[760px] flex-col gap-3">
        <Panel title="Проверка на ДДС номер, ЕИК, ЕГН, IBAN">
          <div className="flex flex-col gap-3 p-3">
            <div className="flex items-center gap-2">
              <TextInput
                autoFocus
                className="flex-1 font-mono tracking-wide"
                placeholder="Въведете ДДС номер, ЕИК, ЕГН, ЛНЧ или IBAN"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && check()}
              />
              <Button variant="primary" icon={<ScanSearch className="size-3.5" />} onClick={check} disabled={!code.trim()}>
                Проверка
              </Button>
            </div>
            <div className="text-[12px] text-slate-500">Видът на кода се разпознава автоматично: 9 или 13 цифри – ЕИК; 10 цифри – ЕГН/ЛНЧ; с префикс на държава – ДДС номер; IBAN – буквен код на държава, контролни цифри и сметка.</div>
            {last && (
              <div className={cx('flex items-start gap-3 rounded-sm border px-3 py-2', last.result.valid ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50')}>
                {last.result.valid ? <CheckCircle2 className="mt-0.5 size-5 text-emerald-600" /> : <XCircle className="mt-0.5 size-5 text-red-600" />}
                <div className="flex flex-col gap-1">
                  <div className="font-mono text-[14px] font-semibold">{last.code}</div>
                  <div className={cx('font-medium', last.result.valid ? 'text-emerald-800' : 'text-red-800')}>
                    {last.result.kind === 'unknown' ? 'Кодът не е разпознат като ДДС номер, ЕИК, ЕГН, ЛНЧ или IBAN.' : `${KIND[last.result.kind]}: ${last.result.valid ? 'валиден' : 'невалиден'}`}
                  </div>
                  {details(last.result).map(([k, v]) => (
                    <div key={k} className="text-[12.5px] text-slate-700">
                      <span className="text-slate-500">{k}:</span> {v}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Panel>
        {history.length > 1 && (
          <Panel title="Проверени кодове">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Час</th>
                  <th>Код</th>
                  <th>Вид</th>
                  <th>Резултат</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i} className="cursor-default" onClick={() => setCode(h.code)}>
                    <td className="w-20">{h.at.toTimeString().slice(0, 8)}</td>
                    <td className="font-mono">{h.code}</td>
                    <td>{KIND[h.result.kind]}</td>
                    <td className={h.result.valid ? 'text-emerald-700' : 'text-red-700'}>{h.result.valid ? 'валиден' : 'невалиден'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}
