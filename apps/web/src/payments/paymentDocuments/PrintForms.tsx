import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formattedQtty, effectiveCurrency, PAYMENT_DOCUMENT_TYPES_DEF, type PaymentDocumentFields, type PaymentDocumentTypeId } from '@shmi/core';
import { bgDate } from '../../format.ts';

/**
 * Printed bank forms (02c 1.7): one block per document in the layout of the
 * Bulgarian bank/budget forms, with the report parameters of the original
 * (PlaceAndDate, FormattedQtty, InWords, ...).
 */

interface Cell {
  label: string;
  value?: string | null;
  span?: number;
  mono?: boolean;
  /** Character boxes (IBAN, BIC, amount). */
  boxes?: number;
}
type Row = Cell[];

const PRINT_CSS = `
.paydoc-print-portal { display: none; }
@media print {
  @page paydoc { size: A4 portrait; margin: 8mm; }
  html, body, #root { height: auto !important; background: #fff !important; }
  body > *:not(.paydoc-print-portal):not(.report-print-portal) { display: none !important; }
  .paydoc-print-portal { display: block; page: paydoc; color: #000; font-family: Arial, Helvetica, sans-serif; }
  .paydoc-print-portal * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .paydoc-print-portal .grid-table { font-size: 8.5pt; width: 100%; }
  .paydoc-print-portal .grid-table thead th { position: static; background: #e2e8f0; }
  .paydoc-print-portal .grid-table td, .paydoc-print-portal .grid-table th { padding: 1px 4px; white-space: normal; }
  .paydoc-print-portal .grid-table tr { break-inside: avoid; }
}
.paydoc-form { border: 1.5px solid #000; margin: 0 0 6mm; padding: 2mm 3mm; break-inside: avoid; page-break-inside: avoid; font-size: 9.5pt; }
.paydoc-form h2 { text-align: center; font-size: 12pt; font-weight: bold; margin: 1mm 0 2mm; letter-spacing: .3px; text-transform: uppercase; }
.paydoc-head { display: grid; grid-template-columns: 1fr 1fr; gap: 1mm 4mm; margin-bottom: 1.5mm; }
.paydoc-row { display: grid; grid-template-columns: repeat(12, 1fr); border-top: 1px solid #000; }
.paydoc-row:last-of-type { border-bottom: 1px solid #000; }
.paydoc-cell { border-left: 1px solid #000; padding: .6mm 1.2mm 1mm; min-height: 9mm; }
.paydoc-cell:last-child { border-right: 1px solid #000; }
.paydoc-cell .lbl { font-size: 6.5pt; color: #222; text-transform: none; }
.paydoc-cell .val { font-size: 10pt; font-weight: 600; min-height: 4.5mm; white-space: pre-wrap; word-break: break-word; }
.paydoc-cell .mono { font-family: 'Courier New', monospace; letter-spacing: .5px; }
.paydoc-boxes { display: flex; }
.paydoc-boxes span { display: inline-block; width: 3.6mm; height: 4.8mm; border: .6px solid #555; margin-right: -.6px; text-align: center; font-family: 'Courier New', monospace; font-weight: bold; font-size: 9.5pt; line-height: 4.8mm; }
.paydoc-sign { display: flex; justify-content: space-between; margin-top: 3mm; font-size: 8pt; }
.paydoc-sign span { border-top: 1px dotted #000; padding-top: .5mm; min-width: 45mm; text-align: center; }
.paydoc-note { font-size: 7pt; margin-top: 1mm; }
`;

function Boxes({ value, n }: { value: string; n: number }) {
  const chars = value.replace(/\s/g, '').slice(0, n).padEnd(n, ' ').split('');
  return (
    <div className="paydoc-boxes">
      {chars.map((c, i) => (
        <span key={i}>{c.trim() ? c : ' '}</span>
      ))}
    </div>
  );
}

function FormRow({ cells }: { cells: Row }) {
  return (
    <div className="paydoc-row">
      {cells.map((c, i) => (
        <div key={i} className="paydoc-cell" style={{ gridColumn: `span ${c.span ?? 12}` }}>
          <div className="lbl">{c.label}</div>
          {c.boxes ? <Boxes value={c.value ?? ''} n={c.boxes} /> : <div className={c.mono ? 'val mono' : 'val'}>{c.value ?? ''}</div>}
        </div>
      ))}
    </div>
  );
}

const placeAndDate = (d: PaymentDocumentFields) => [d.issuePlace, d.issueDate ? bgDate(d.issueDate) : ''].filter(Boolean).join(' ');
const taxesText = (t: number | null) => (t === 1 ? '1 – за сметка на наредителя' : t === 2 ? '2 – споделени' : t === 3 ? '3 – за сметка на получателя' : '');

function layout(type: number, d: PaymentDocumentFields): { rows: Row[]; signs: string[]; note?: string } {
  const cur = effectiveCurrency(d.currency);
  const amount: Row = [
    { label: 'Вид валута', value: cur, span: 3, boxes: 3 },
    { label: 'Сума', value: formattedQtty(d.qtty), span: 9, boxes: 13 },
  ];
  const words: Row = [{ label: 'Словом', value: d.inWords }];
  const beneficiary = (title = 'Платете на – име на получателя'): Row[] => [
    [{ label: title, value: d.personName }],
    [
      { label: 'IBAN на получателя', value: d.personIban, span: 8, boxes: 22 },
      { label: 'BIC на банката на получателя', value: d.personBic, span: 4, boxes: 8 },
    ],
    [{ label: 'При банка – име на банката на получателя', value: d.personBank }],
  ];
  const reason = (label: string): Row[] => [
    [{ label, value: d.reason }],
    [{ label: 'Още пояснения', value: d.reasonEx }],
  ];
  const orderer = (label: string, ibanLabel: string, bicLabel: string): Row[] => [
    [{ label, value: d.customer }],
    [
      { label: ibanLabel, value: d.customerIban, span: 8, boxes: 22 },
      { label: bicLabel, value: d.customerBic, span: 4, boxes: 8 },
    ],
  ];
  const exec: Row = [
    { label: 'Платежна система', value: d.paymentSystem, span: 4 },
    { label: 'Такси', value: taxesText(d.taxes), span: 4 },
    { label: 'Дата на изпълнение', value: d.executionDate ? bgDate(d.executionDate) : '', span: 4 },
  ];
  const duePerson: Row[] = [
    [{ label: 'Задължено лице – наименование на юридическото лице или трите имена на физическото лице', value: d.duePerson }],
    [
      { label: 'БУЛСТАТ на задълженото лице', value: d.bulstat, span: 4, boxes: 13 },
      { label: 'ЕГН на задълженото лице', value: d.egn, span: 4, boxes: 10 },
      { label: 'ЛНЧ на задълженото лице', value: d.lnch, span: 4, boxes: 10 },
    ],
  ];
  switch (type) {
    case 1:
      return {
        rows: [
          [{ label: 'Наредител – име', value: d.personName }],
          [
            { label: 'IBAN', value: d.personIban, span: 8, boxes: 22 },
            { label: 'Банка', value: d.personBank, span: 4 },
          ],
          amount, words,
          [
            { label: 'Упълномощено лице', value: d.autorizedPerson, span: 6 },
            { label: 'Лична карта №', value: d.idNumber, span: 3 },
            { label: 'ЕГН', value: d.egn, span: 3, mono: true },
          ],
          [{ label: 'Получил сумата', value: d.receivedBy }],
        ],
        signs: ['Подпис на наредителя', 'Получил', 'Касиер'],
      };
    case 2:
      return {
        rows: [...beneficiary('В полза на – име на получателя'), amount, words, [{ label: 'Вносител – име', value: d.customer }], [{ label: 'Основание за внасяне', value: d.reason }]],
        signs: ['Подпис на вносителя', 'Касиер', 'Контрольор'],
      };
    case 3:
      return {
        rows: [...beneficiary(), amount, ...reason('Основание за превод – информация за получателя'), ...orderer('Наредител – име', 'IBAN на наредителя', 'BIC на банката на наредителя'), exec],
        signs: ['Подпис на наредителя', 'Банково бордеро / подпис на служителя'],
      };
    case 4:
      return {
        rows: [
          [{ label: 'Платец – име', value: d.personName }],
          [
            { label: 'IBAN на платеца', value: d.personIban, span: 8, boxes: 22 },
            { label: 'BIC на банката на платеца', value: d.personBic, span: 4, boxes: 8 },
          ],
          [{ label: 'При банка – име на банката на платеца', value: d.personBank }],
          amount,
          ...reason('Основание за дебитиране'),
          ...orderer('Получател – име', 'IBAN на получателя', 'BIC на банката на получателя'),
          exec,
        ],
        signs: ['Подпис на получателя', 'Банково бордеро / подпис на служителя'],
        note: 'Платецът е дал съгласие за директен дебит.',
      };
    case 5:
      return {
        rows: [
          ...beneficiary('Платете на – име на получателя'),
          [{ label: 'Вид плащане', value: d.paymentType == null ? '' : String(d.paymentType), span: 4, boxes: 6 }, { label: 'Код SEBRA', value: d.sebra, span: 8 }],
          amount,
          ...reason('Основание за плащане'),
          ...duePerson,
          ...orderer('Наредител – име', 'IBAN на наредителя', 'BIC на банката на наредителя'),
          exec,
        ],
        signs: ['Подпис на наредителя', 'Банково бордеро / подпис на служителя'],
      };
    case 6:
      return {
        rows: [
          ...beneficiary('В полза на – име на получателя'),
          [{ label: 'Вид плащане', value: d.paymentType == null ? '' : String(d.paymentType), span: 4, boxes: 6 }, { label: 'Платежна система', value: d.paymentSystem, span: 8 }],
          amount, words,
          ...reason('Основание за плащане'),
          ...duePerson,
          [{ label: 'Вносител – име', value: d.customer, span: 8 }, { label: 'Получил', value: d.receivedBy, span: 4 }],
        ],
        signs: ['Подпис на вносителя', 'Касиер'],
      };
    case 8:
      return {
        rows: [
          [{ label: 'Наредител – име', value: d.customer }],
          [
            { label: 'IBAN на сметката за задължаване', value: d.personIban, span: 8, boxes: 22 },
            { label: 'BIC', value: d.personBic, span: 4, boxes: 8 },
          ],
          amount,
          [{ label: 'Основание', value: d.reason }],
          [{ label: 'Брой редове (плащания)', value: d.rowsCount, span: 6 }, { label: 'Контролна сума / код', value: d.controlCode, span: 6 }],
        ],
        signs: ['Подпис на наредителя', 'Подпис на служителя'],
        note: 'Приложение: файл / списък с получателите и сумите.',
      };
    default:
      return { rows: [], signs: [] };
  }
}

export function PaymentDocumentPrint({ type, doc }: { type: number; doc: PaymentDocumentFields }) {
  const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];
  const { rows, signs, note } = layout(type, doc);
  const title = type === 5 ? 'Платежно нареждане за плащане от/към бюджета' : def?.description;
  return (
    <div className="paydoc-form">
      <div className="paydoc-head">
        <div>
          <div style={{ fontSize: '6.5pt' }}>До банка</div>
          <div style={{ fontWeight: 600 }}>{doc.bankName}</div>
          <div style={{ fontSize: '8pt' }}>{[doc.bankBranch && `Клон ${doc.bankBranch}`, doc.bankAddress].filter(Boolean).join(', ')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '6.5pt' }}>Място и дата на подаване</div>
          <div style={{ fontWeight: 600 }}>{placeAndDate(doc)}</div>
          <div style={{ fontSize: '6.5pt', marginTop: '1mm' }}>уникален регистрационен номер ......................</div>
        </div>
      </div>
      <h2>{title}</h2>
      {rows.map((r, i) => (
        <FormRow key={i} cells={r} />
      ))}
      {note && <div className="paydoc-note">{note}</div>}
      <div className="paydoc-sign">
        {signs.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  );
}

/** Print portal: only its content is printed (window.print). */
export function PrintPortal({ children }: { children: ReactNode }) {
  return (
    <>
      <style href="shmi-paydoc-print" precedence="default">
        {PRINT_CSS}
      </style>
      {/* Also a report-print-portal, so the report screens' print CSS (if loaded) does not hide it. */}
      {createPortal(<div className="paydoc-print-portal report-print-portal">{children}</div>, document.body)}
    </>
  );
}

/** Printing hook: call print(); the content renders in the portal until the print dialog closes. */
export function usePrint() {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => {
      window.print();
      // Some browsers do not fire afterprint for a cancelled dialog.
      setTimeout(done, 500);
    }, 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);
  return { printing, print: () => setPrinting(true) };
}
