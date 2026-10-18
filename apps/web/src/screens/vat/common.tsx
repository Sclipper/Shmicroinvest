import { ApiError } from '../../api.ts';

/** Shared helpers of the VAT screens. */

export interface DiaryRow {
  accountingId: number;
  accountingNumber: string;
  branchCode: string;
  documentType: string;
  documentCode: string;
  documentNumber: string;
  documentDate: string;
  partnerVat: string;
  partnerName: string;
  description: string;
  vatDiaryCode: string;
  cols: string[];
}

export interface VatReportResult {
  declaration: Record<string, string>;
  sales: DiaryRow[];
  purchases: DiaryRow[];
  salesTotals: string[];
  purchasesTotals: string[];
  vies: {
    part1: { vatNumber: string | null; partnerName: string; k3: string; k4: string; k5: string; viesMonth: string }[];
    part2: { k2: string; k3: string; k4: string; viesMonth: string }[];
    totals: { '01': string; '17': string; '02': number };
  };
  hasViesData: boolean;
  info: string | null;
  messages: { key: string; text: string; severity: 'critical' | 'warning' }[];
}

export const SALE_COLUMNS: [number, string][] = [
  [9, 'Общ размер на ДО за облагане с ДДС'], [10, 'Всичко начислен ДДС'], [11, 'ДО на облагаемите доставки със ставка 20%'], [12, 'Начислен ДДС за доставки по к.11'],
  [13, 'ДО на ВОП'], [14, 'ДО на получени доставки по чл.82, ал.2-6'], [15, 'Начислен ДДС за ВОП и доставки по к.14'], [16, 'Начислен данък за доставки за лични нужди'],
  [17, 'ДО на доставки със ставка 9%'], [18, 'Начислен ДДС по к.17'], [19, 'ДО на доставки със ставка 0% по глава трета'], [20, 'ДО на ВОД'],
  [21, 'ДО по чл.140, 146, 173'], [22, 'ДО на услуги по чл.21, ал.2'], [23, 'ДО на доставки по чл.69, ал.2'], [24, 'ДО на освободени доставки и ВОП'],
  [25, 'ДО на доставки като посредник в тристранни операции'],
];

export const PURCHASE_COLUMNS: [number, string][] = [
  [9, 'ДО и данък на получените доставки, ВОП, доставки по чл.82 и внос без право на данъчен кредит или без данък'], [10, 'ДО с право на пълен данъчен кредит'],
  [11, 'ДДС с право на пълен данъчен кредит'], [12, 'ДО с право на частичен данъчен кредит'], [13, 'ДДС с право на частичен данъчен кредит'],
  [14, 'Годишна корекция по чл.73, ал.8 (+/-)'], [15, 'ДО от придобиване на стоки от посредник в тристранна операция'],
];

/** VAT return cells by section (05 7.4 layout). */
export const DECLARATION_SECTIONS: { title: string; cells: [string, string][] }[] = [
  {
    title: 'Раздел А: Данни за начислен данък върху добавената стойност',
    cells: [
      ['01', 'Общ размер на данъчните основи за облагане с ДДС'], ['20', 'Всичко начислен ДДС'],
      ['11', 'ДО на облагаемите доставки със ставка 20%'], ['21', 'Начислен ДДС (20%)'],
      ['12', 'ДО на ВОП и на получени доставки по чл.82, ал.2-6'], ['22', 'Начислен ДДС за ВОП и получени доставки по чл.82'],
      ['23', 'Начислен данък за доставки за лични нужди'], ['13', 'ДО на облагаемите доставки със ставка 9%'], ['24', 'Начислен ДДС (9%)'],
      ['14', 'ДО на доставки по глава трета (0%)'], ['15', 'ДО на ВОД на стоки (0%)'], ['16', 'ДО на доставки по чл.140, 146 и 173 (0%)'],
      ['17', 'ДО на доставки на услуги по чл.21, ал.2 в друга държава членка'], ['18', 'ДО на доставки по чл.69, ал.2 и като посредник в тристранна операция'],
      ['19', 'ДО на освободените доставки и освободените ВОП'],
    ],
  },
  {
    title: 'Раздел Б: Данни за упражненото право на данъчен кредит',
    cells: [
      ['30', 'ДО и данък на получените доставки без право на данъчен кредит или без данък'], ['31', 'ДО с право на пълен данъчен кредит'],
      ['41', 'ДДС с право на пълен данъчен кредит'], ['32', 'ДО с право на частичен данъчен кредит'], ['42', 'ДДС с право на частичен данъчен кредит'],
      ['43', 'Годишна корекция по чл.73, ал.8 (+/-)'], ['33', 'Коефициент по чл.73, ал.5 ЗДДС'], ['40', 'Общо данъчен кредит (41 + 42 x кл.33 + 43)'],
    ],
  },
  { title: 'Раздел В: Резултат за периода', cells: [['50', 'ДДС за внасяне (кл.20 - кл.40) >= 0'], ['60', 'ДДС за възстановяване (кл.20 - кл.40) < 0']] },
  { title: 'Раздел Г: ДДС за внасяне', cells: [['70', 'Данък за внасяне от кл.50, приспаднат по реда на чл.92, ал.1'], ['71', 'Данък за внасяне от кл.50, внесен ефективно']] },
  { title: 'Раздел Д: ДДС, подлежащ на възстановяване', cells: [['80', 'съгласно чл.92, ал.1'], ['81', 'съгласно чл.92, ал.3'], ['82', 'съгласно чл.92, ал.4']] },
];

/** Downloads a GET endpoint as a file; API errors become ApiError. */
export async function downloadUrl(url: string, fallbackName: string) {
  const res = await fetch(`/api${url}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.messages);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Reads a local file as base64 (for the import and NAP-check uploads). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const prevMonth = (workingDate: string) => {
  const y = Number(workingDate.slice(0, 4));
  const m = Number(workingDate.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { from: `${py}-${String(pm).padStart(2, '0')}-01`, to: `${py}-${String(pm).padStart(2, '0')}-${last}` };
};
