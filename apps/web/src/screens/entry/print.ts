import { bgDate, money } from '../../format.ts';

/**
 * Printouts of the journal (05 7.11): the entry card (AccountingReport) and the
 * shared hidden-frame printing used by it and the VAT protocol.
 */

export const esc = (s: string | null | undefined) => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Prints an HTML document from a hidden frame. The frame stays in the page
 * (data-testid "print-frame") until the next printout replaces it.
 */
export function printHtml(html: string) {
  for (const old of document.querySelectorAll('iframe[data-testid="print-frame"]')) old.remove();
  const frame = document.createElement('iframe');
  frame.dataset.testid = 'print-frame';
  frame.title = 'Печат';
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  frame.contentDocument!.open();
  frame.contentDocument!.write(html);
  frame.contentDocument!.close();
  setTimeout(() => frame.contentWindow?.print(), 50);
}

/** Downloads an HTML document as a Word file (the report export "Doc" format, 05 11). */
export function downloadDoc(fileName: string, html: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', html], { type: 'application/msword' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface CardLine {
  accountNumber: string; accountDescription: string; companyName: string | null; amount: string;
  currencyIso: string | null; currencyAmount: string | null; exchangeRate: string | null; fixedRate: string | null;
  quantity: string | null; price: string | null; measure: string | null;
}
interface CardSide { lines: CardLine[]; total: string; hasCurrency: boolean; hasMaterial: boolean }
export interface EntryCard {
  company: { name: string; bulstat: string };
  header: {
    id: number; number: string; accountingDate: string; documentType: string; documentTypeShort: string; documentNumber: string; documentDate: string;
    company: string; term: string; reference: string; transactionType: string; vatTerm: string; vies: string; viesMonth: string | null; isInitialBalance: boolean;
  };
  debit: CardSide;
  credit: CardSide;
}

const num = (v: string | null, digits = 5) => (v == null || v === '' ? '' : Number(v).toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: digits }));

function sideTable(title: string, s: CardSide) {
  const head = ['Сметка', 'Наименование', 'Партньор', ...(s.hasCurrency ? ['Валута', 'Вал. сума', 'Курс', 'Фиксинг'] : []), ...(s.hasMaterial ? ['Кол.', 'Цена', 'Мярка'] : []), 'Сума'];
  const rows = s.lines.map((l) => [
    `<td>${esc(l.accountNumber)}</td>`, `<td>${esc(l.accountDescription)}</td>`, `<td>${esc(l.companyName)}</td>`,
    ...(s.hasCurrency ? [`<td>${esc(l.currencyIso)}</td>`, `<td class="n">${l.currencyIso ? money(l.currencyAmount) : ''}</td>`, `<td class="n">${l.currencyIso ? num(l.exchangeRate) : ''}</td>`, `<td class="n">${l.currencyIso ? num(l.fixedRate) : ''}</td>`] : []),
    ...(s.hasMaterial ? [`<td class="n">${num(l.quantity, 3)}</td>`, `<td class="n">${l.quantity ? num(l.price, 3) : ''}</td>`, `<td>${esc(l.measure)}</td>`] : []),
    `<td class="n">${money(l.amount)}</td>`,
  ].join(''));
  return `<h2>${title}</h2><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r}</tr>`).join('')}
<tr class="t"><td colspan="${head.length - 1}">Общо ${title.toLowerCase()}</td><td class="n">${money(s.total)}</td></tr></table>`;
}

/** One entry card: header block, then the "Дебит" and "Кредит" tables with their totals. */
export function entryCardBody(c: EntryCard) {
  const h = c.header;
  const field = (label: string, value: string | null | undefined) => (value ? `<div><b>${label}:</b> ${esc(value)}</div>` : '');
  return `<section class="card">
<div class="co">${esc(c.company.name)}${c.company.bulstat ? `, ЕИК ${esc(c.company.bulstat)}` : ''}</div>
<h1>${h.isInitialBalance ? 'Начално салдо' : 'Мемориален ордер'} № ${esc(h.number)} от ${bgDate(h.accountingDate)}</h1>
<div class="hdr">
${field('Документ', h.documentType ? `${h.documentType} № ${h.documentNumber} от ${bgDate(h.documentDate)}` : '')}
${field('Партньор', h.company)}
${field('Основание', h.term)}
${field('Забележка', h.reference)}
${field('Тип на сделката', h.transactionType)}
${field('ДДС режим', h.vatTerm)}
${field('VIES', h.vies)}
${field('Месец за експорт', h.viesMonth ? `${h.viesMonth.slice(5, 7)}.${h.viesMonth.slice(0, 4)}` : '')}
</div>
${sideTable('Дебит', c.debit)}
${sideTable('Кредит', c.credit)}
<div class="sig"><span>Съставил: ....................</span><span>Гл. счетоводител: ....................</span></div>
</section>`;
}

export function entryCardsHtml(cards: EntryCard[]) {
  const title = cards.length === 1 ? `Контиране ${cards[0]!.header.number}` : `Контировки (${cards.length})`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:12px Arial,sans-serif;margin:20px}h1{font-size:16px;margin:4px 0 8px}h2{font-size:13px;margin:12px 0 4px}.co{font-size:11px;color:#444}
.hdr div{margin:1px 0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:3px 5px;text-align:left}td.n{text-align:right;white-space:nowrap}
tr.t td{font-weight:bold}.sig{display:flex;justify-content:space-between;margin-top:36px}.card+.card{page-break-before:always;margin-top:24px}</style></head><body>
${cards.map(entryCardBody).join('\n')}
</body></html>`;
}

export const printEntryCards = (cards: EntryCard[]) => printHtml(entryCardsHtml(cards));
