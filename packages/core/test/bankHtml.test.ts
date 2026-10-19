import { describe, expect, it } from 'vitest';
import { decodeText, htmlTableGrid, htmlTableRows, htmlText, isHtmlText, parseBankStatement, parseHtml, parseHtmlAmount, parseHtmlStatement, htmlDescendants } from '../src/index.ts';

/** HTML bank statements (spec 04b 1.13): the seven HTML services, their probes, Bulgarian numbers and encodings. */

/** windows-1251 bytes of a string (ASCII, Cyrillic А-я, Ёё, №, no-break space): what a Bulgarian Windows export writes. */
function cp1251(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else if (c === 0x2116) out.push(0xb9);
    else if (c === 0xa0) out.push(0xa0);
    else if (c === 0x201e) out.push(0x84);
    else if (c === 0x201c) out.push(0x93);
    else throw new Error(`no cp1251 for ${ch}`);
  }
  return new Uint8Array(out);
}

const OWN = 'BG80STSA93000012345678';
const SUPPLIER = 'BG11UNCR70001512345678';
const CLIENT = 'BG22FINV91501014771636';
const rowsOf = (s: ReturnType<typeof parseBankStatement>) => s!.rows.map((r) => [r.date, r.isInflow, r.amount, r.partnerIban, r.partnerName, r.reason, r.reference]);

const DSK = `<!DOCTYPE html>
<html>
<head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>Банка ДСК - Движения по сметка</title>
<style>td.amt { text-align: right }</style></head>
<body>
<table class="statement">
  <tr><td colspan="7"><b>ОТЧЕТ ПО СМЕТКА</b> ${OWN} EUR</td></tr>
  <tr><td>Титуляр:</td><td colspan="6">Тест ООД, ЕИК 831641791</td></tr>
  <tr><td>Период:</td><td colspan="6">01.09.2026 - 30.09.2026</td></tr>
  <tr><td>Старо салдо</td><td class="amt">1 000,00</td></tr>
  <tr><th>Дата</th><th>Референция</th><th>Дебит</th><th>Кредит</th><th>Наредител / Получател</th><th>Сметка</th><th>Описание</th></tr>
  <tr><td>04.09.2026</td><td>FT2609041</td><td class="amt">1 234,56</td><td class="amt"></td><td>Доставчик ЕООД</td><td>${SUPPLIER}</td><td>Плащане по ф-ра № 123</td></tr>
  <tr><td>15.09.2026</td><td>FT2609152</td><td class="amt">&nbsp;</td><td class="amt">2&nbsp;500,00</td><td>Клиент &quot;Юг&quot; АД</td><td>${CLIENT}</td><td>Ф-ра 456<br>от 01.09.2026</td></tr>
  <tr><td>Оборот за периода</td><td></td><td class="amt">1 234,56</td><td class="amt">2 500,00</td></tr>
  <tr><td>Ново салдо</td><td class="amt">2 265,44</td></tr>
</table>
</body>
</html>`;

describe('HTML reader', () => {
  it('implicit td/tr/p closes, entities, <br> lines, colspan, raw text elements', () => {
    const doc = parseHtml('<html><head><title>a<b></title><script>if (a < b) x("</td>")</script></head><body><p>one<p>two &amp; &#1040;&#x411; &euro;<table><tr><td>a<td colspan=2>b<br>c<tr><td class="amt x">1</table></body></html>');
    expect(doc.errors).toEqual([]);
    const [table] = htmlDescendants(doc.root, 'table');
    expect(htmlTableRows(table!)).toEqual([
      [{ text: 'a', classes: [] }, { text: 'b\nc', classes: [] }, { text: '', classes: [] }],
      [{ text: '1', classes: ['amt', 'x'] }],
    ]);
    expect(htmlText(htmlDescendants(doc.root, 'body')[0]!, { skipTables: true })).toBe('one\ntwo & АБ €');
  });

  it('records mismatched end tags as parse errors', () => {
    expect(parseHtml('<html><head></head><body><div><span>x</div></body></html>').errors).toEqual(['TagNotClosed: span']);
    expect(parseHtml('<html><head></head><body></font></body></html>').errors).toEqual(['TagNotOpened: font']);
  });

  it('isHtmlText: doctype, <html>, XML declaration and comments before it', () => {
    expect(isHtmlText('<!DOCTYPE html><html>')).toBe(true);
    expect(isHtmlText('﻿  <?xml version="1.0"?><!-- export --><HTML lang="bg">')).toBe(true);
    expect(isHtmlText('<?xml version="1.0"?><Document>')).toBe(false);
    expect(isHtmlText('<table><tr>')).toBe(false);
    expect(isHtmlText('<!-- a --><!-- b -->\n<html>')).toBe(true);
    expect(isHtmlText('<!-- never closed <html>')).toBe(false);
  });

  it('isHtmlText stays linear on many leading comments (no catastrophic backtracking)', () => {
    const start = performance.now();
    expect(isHtmlText('<!-- x -->'.repeat(5000) + '<Document>')).toBe(false);
    expect(isHtmlText('<!-- x -->'.repeat(5000) + '<html>')).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('Bulgarian money cells', () => {
  it.each([
    ['1 234,56', '1234.56'], ['1 234,56', '1234.56'], ['1.234,56', '1234.56'], ['1,234.56', '1234.56'], ['1 234 567.80', '1234567.8'],
    ['-12,00', '-12'], ['12,00-', '-12'], ['(12,00)', '-12'], ['+300,00', '300'], ['12,00 лв.', '12'], ['EUR 1,250.50', '1250.5'], ['0,5', '0.5'],
    ['1.234.567', '1234567'], ['', null], ['   ', null], ['няма', null], ['12,3,4.5', '1234.5'],
  ])('%s -> %s', (raw, want) => {
    expect(parseHtmlAmount(raw)).toBe(want);
  });
});

describe('HTML statements of the seven banks (04b 1.13)', () => {
  it('DSK: windows-1251 file, td.amt amounts, header block by caption, summary rows skipped', () => {
    const text = decodeText(cp1251(DSK));
    expect(text).toContain('Банка ДСК');
    const s = parseBankStatement({ text }, 'STSABGSF')!;
    expect(s).toMatchObject({ format: 'DSK HTML', model: 'DSK', iban: OWN, currency: 'EUR', from: '2026-09-01', to: '2026-09-30', openingBalance: '1000.00', closingBalance: '2265.44' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-04', false, '1234.56', SUPPLIER, 'Доставчик ЕООД', 'Плащане по ф-ра № 123', 'FT2609041'],
      ['2026-09-15', true, '2500.00', CLIENT, 'Клиент "Юг" АД', 'Ф-ра 456 от 01.09.2026', 'FT2609152'],
    ]);
    // The DSK model properties the posting rules use.
    expect(s.rows[0]!.props).toMatchObject({ MovementType: 'DEBIT', DebitAmount: '1234.56', OppositeSideName: 'Доставчик ЕООД', Reason: 'Плащане по ф-ра № 123' });
  });

  it('DSK: the probe needs td.amt cells; amounts are read from them when no amount column is captioned', () => {
    expect(parseHtmlStatement(DSK.replace(/ class="amt"/g, ''), 'STSABGSF')).toBeNull();
    const html = `<html><head></head><body><table>
      <tr><th>Дата</th><th>Референция</th><th>Сума Дт</th><th>Сума Кт</th><th>Контрагент</th><th>Основание</th></tr>
      <tr><td>02.09.2026</td><td>R1</td><td class="amt">10,00</td><td class="amt"></td><td>А</td><td>такса</td></tr>
      <tr><td>03.09.2026</td><td>R2</td><td class="amt"></td><td class="amt">20,00</td><td>Б</td><td>ф-ра 1</td></tr>
    </table></body></html>`;
    // "Сума Дт" / "Сума Кт" are no known captions: the amounts come from the td.amt cells (first debit, then credit).
    const s = parseHtmlStatement(html, 'STSABGSF')!;
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount, r.partnerName, r.reason])).toEqual([['2026-09-02', false, '10.00', 'А', 'такса'], ['2026-09-03', true, '20.00', 'Б', 'ф-ра 1']]);
    const s2 = parseHtmlStatement(html.replace('<th>Сума Дт</th><th>Сума Кт</th>', '<th>Дт</th><th>Кт</th>').replace(/ class="amt"/g, ' class="amt num"'), 'STSABGSF')!;
    expect(s2.rows.map((r) => [r.isInflow, r.amount])).toEqual([[false, '10.00'], [true, '20.00']]);
  });

  it('Allianz: English captions, separate Payer and Beneficiary, IBAN inside the name cell', () => {
    const html = `<html><head><meta charset="utf-8"><title>Allianz Bank Bulgaria</title></head><body>
      <h3>Account History</h3>
      <table>
        <tr><td>Account History</td><td>BG55BUIN95611000123456 EUR</td></tr>
        <tr><td>From date</td><td>01.09.2026</td><td>To date</td><td>30.09.2026</td></tr>
        <tr><td>Opening balance</td><td>10,000.00</td></tr>
        <tr><th>Trn. date</th><th>Val. date</th><th>Reference No</th><th>Amount</th><th>DtKt</th><th>Beneficiary</th><th>Payer</th><th>Details of payment</th><th>Additional explanation</th></tr>
        <tr><td>03.09.2026</td><td>03.09.2026</td><td>0123</td><td>1,250.50</td><td>D</td><td>Доставчик ООД<br>${SUPPLIER}</td><td>Тест ООД</td><td>Наем</td><td>м. септември</td></tr>
        <tr><td>10.09.2026</td><td>11.09.2026</td><td>0456</td><td>2,000.00</td><td>C</td><td>Тест ООД</td><td>Клиент ЕООД<br>${CLIENT}</td><td>Ф-ра 77</td><td></td></tr>
        <tr><td>Total debits</td><td></td><td></td><td>1,250.50</td></tr>
        <tr><td>Total credits</td><td></td><td></td><td>2,000.00</td></tr>
        <tr><td>Closing balance</td><td>10,749.50</td></tr>
      </table></body></html>`;
    const s = parseBankStatement({ text: html }, 'BUINBGSF')!;
    expect(s).toMatchObject({ format: 'Allianz HTML', iban: 'BG55BUIN95611000123456', currency: 'EUR', from: '2026-09-01', to: '2026-09-30', openingBalance: '10000.00', closingBalance: '10749.50' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-03', false, '1250.50', SUPPLIER, 'Доставчик ООД', 'Наем м. септември', '0123'],
      ['2026-09-10', true, '2000.00', CLIENT, 'Клиент ЕООД', 'Ф-ра 77', '0456'],
    ]);
    expect(s.rows[0]!.props).toMatchObject({ MovementType: 'D', Beneficiary: 'Доставчик ООД', PaymentDetails: 'Наем', AdditionalExplanation: 'м. септември' });
  });

  it('Fibank: fixed columns, reference/details block split on blank lines, balances from the summary rows', () => {
    const html = `<html><head><title>Fibank</title></head><body>
      <p>IBAN: ${CLIENT}</p><p>Валута: EUR</p><p>Период: 01.09.2026 - 30.09.2026</p>
      <table>
        <tr><th>Дата</th><th>Референция / Детайли</th><th>Вальор</th><th>Дебит</th><th>Кредит</th><th>Салдо</th></tr>
        <tr><td>Старо салдо</td><td></td><td></td><td></td><td></td><td>500,00</td></tr>
        <tr><td>05.09.2026</td><td>REF0905001<br><br><br>Клиент Фи ООД<br>${SUPPLIER}<br><br><br>Плащане по фактура 77</td><td>05.09.2026</td><td></td><td>1 200,00</td><td>1 700,00</td></tr>
        <tr><td>07.09.2026</td><td>REF0907002<br><br><br>Такса поддръжка</td><td>07.09.2026</td><td>3,50</td><td></td><td>1 696,50</td></tr>
        <tr><td>Ново салдо</td><td></td><td></td><td></td><td></td><td>1 696,50</td></tr>
      </table></body></html>`;
    const s = parseBankStatement({ text: html }, 'FINVBGSF')!;
    expect(s).toMatchObject({ format: 'Fibank HTML', iban: CLIENT, currency: 'EUR', from: '2026-09-01', to: '2026-09-30', openingBalance: '500.00', closingBalance: '1696.50' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-05', true, '1200.00', SUPPLIER, 'Клиент Фи ООД', 'Плащане по фактура 77', 'REF0905001'],
      ['2026-09-07', false, '3.50', '', '', 'Такса поддръжка', 'REF0907002'],
    ]);
    expect(s.rows[0]!.baseAmount).toBe('1200.00');
    // Fibank refuses a document with parse errors, and one without html/head.
    expect(parseHtmlStatement(html.replace('<p>IBAN', '</div><p>IBAN'), 'FINVBGSF')).toBeNull();
    expect(parseHtmlStatement(html.replace('<head><title>Fibank</title></head>', ''), 'FINVBGSF')).toBeNull();
  });

  it('Municipal (Общинска банка): Cyrillic Дт/Кт in the DtKt column', () => {
    const html = `<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1251"></HEAD><BODY>
      <TABLE BORDER=1>
        <TR><TD>Номер</TD><TD>BG33SOMB91301012345678</TD><TD>Валута</TD><TD>EUR</TD></TR>
        <TR><TD>Период</TD><TD>01.09.2026</TD><TD>30.09.2026</TD></TR>
        <TR><TH>Дата</TH><TH>Номер</TH><TH>Дт/Кт</TH><TH>Сума</TH><TH>IBAN</TH><TH>Контрагент</TH><TH>Описание</TH></TR>
        <TR><TD>08.09.2026</TD><TD>77</TD><TD>Кт</TD><TD>350,00</TD><TD>${CLIENT}</TD><TD>Клиент ЕООД</TD><TD>Аванс</TD></TR>
        <TR><TD>09.09.2026</TD><TD>78</TD><TD>Дт</TD><TD>1 000,00</TD><TD>${SUPPLIER}</TD><TD>Доставчик АД</TD><TD>Ф-ра 9</TD></TR>
      </TABLE></BODY></HTML>`;
    const s = parseHtmlStatement(decodeText(cp1251(html)), 'SOMBBGSF')!;
    expect(s).toMatchObject({ format: 'Municipal HTML', iban: 'BG33SOMB91301012345678', currency: 'EUR', from: '2026-09-01', to: '2026-09-30' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-08', true, '350.00', CLIENT, 'Клиент ЕООД', 'Аванс', '77'],
      ['2026-09-09', false, '1000.00', SUPPLIER, 'Доставчик АД', 'Ф-ра 9', '78'],
    ]);
    expect(s.rows.map((r) => r.props.DtKt)).toEqual(['K', 'D']);
  });

  it('OBB: "1.234,56" amounts, separate debit and credit columns, additional information', () => {
    const html = `<!doctype html><html lang="bg"><head><meta charset="utf-8"></head><body>
      <div>ОТЧЕТ ПО СМЕТКА: BG44UBBS80021012345678 (EUR)</div>
      <table>
        <thead><tr><th>Дата</th><th>Вальор</th><th>Референция</th><th>Дебит</th><th>Кредит</th><th>Контрагент</th><th>IBAN на контрагента</th><th>Основание</th><th>Допълнителна информация</th></tr></thead>
        <tbody>
          <tr><td>11.09.2026</td><td>11.09.2026</td><td>OBB1</td><td>1.234,56</td><td></td><td>Доставчик ООД</td><td>${SUPPLIER}</td><td>Плащане ф-ра 5</td><td>чрез БИСЕРА</td></tr>
          <tr><td>12.09.2026</td><td>12.09.2026</td><td>OBB2</td><td></td><td>99,90</td><td>Клиент ЕООД</td><td>${CLIENT}</td><td>Ф-ра 6</td><td></td></tr>
        </tbody>
      </table></body></html>`;
    const s = parseBankStatement({ text: html }, 'UBBSBGSF')!;
    expect(s).toMatchObject({ format: 'OBB HTML', iban: 'BG44UBBS80021012345678', currency: 'EUR', from: '2026-09-11', to: '2026-09-12' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-11', false, '1234.56', SUPPLIER, 'Доставчик ООД', 'Плащане ф-ра 5 чрез БИСЕРА', 'OBB1'],
      ['2026-09-12', true, '99.90', CLIENT, 'Клиент ЕООД', 'Ф-ра 6', 'OBB2'],
    ]);
  });

  it('Raiffeisen: signed amounts give the direction', () => {
    const html = `<html><head></head><body><table>
      <tr><td>Сметка</td><td>BG13RZBB91551001234567 EUR</td></tr>
      <tr><th>Дата</th><th>Сума</th><th>Контрагент</th><th>Сметка на контрагента</th><th>Основание</th><th>Допълнително описание</th></tr>
      <tr><td>14.09.2026</td><td>-150,00</td><td>Доставчик ООД</td><td>${SUPPLIER}</td><td>Ток</td><td>август</td></tr>
      <tr><td>15.09.2026</td><td>+300,00</td><td>Клиент ЕООД</td><td>${CLIENT}</td><td>Ф-ра 8</td><td></td></tr>
    </table></body></html>`;
    const s = parseBankStatement({ text: html }, 'RZBBBGSF')!;
    expect(s).toMatchObject({ format: 'Raiffeisen HTML', iban: 'BG13RZBB91551001234567', currency: 'EUR' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-14', false, '150.00', SUPPLIER, 'Доставчик ООД', 'Ток август', ''],
      ['2026-09-15', true, '300.00', CLIENT, 'Клиент ЕООД', 'Ф-ра 8', ''],
    ]);
    expect(s.rows[0]!.props).toMatchObject({ MovementType: 'DEBIT', Narrative: 'Ток', DescriptionAdditional: 'август' });
  });

  it('header fields come from the header block, never from a movement description', () => {
    const html = `<html><head></head><body><table>
      <tr><td>Сметка</td><td>BG13RZBB91551001234567</td></tr>
      <tr><th>Дата</th><th>Сума</th><th>Контрагент</th><th>Сметка на контрагента</th><th>Основание</th></tr>
      <tr><td>14.09.2026</td><td>-150,00</td><td>Наемодател ООД</td><td>${SUPPLIER}</td><td>Период 01.12.2025 - 31.12.2025 наем</td></tr>
      <tr><td>15.09.2026</td><td>+300,00</td><td>Клиент ЕООД</td><td>${CLIENT}</td><td>Валута USD превалутиране</td></tr>
    </table></body></html>`;
    const s = parseBankStatement({ text: html }, 'RZBBBGSF')!;
    expect(s.iban).toBe('BG13RZBB91551001234567');
    expect([s.from, s.to]).toEqual(['2026-09-14', '2026-09-15']);
    expect(s.currency).not.toBe('USD');
    expect(s.rows).toHaveLength(2);
  });

  it('Unicredit: DR/CR movement type, Reason + ReasonI02', () => {
    const html = `<html><head><title>UniCredit Bulbank</title></head><body><table>
      <tr><td>IBAN</td><td>BG66UNCR70001598765432</td><td>Валута</td><td>EUR</td></tr>
      <tr><td>Начално салдо</td><td>0,00</td><td>Крайно салдо</td><td>80,00</td></tr>
      <tr><th>Дата</th><th>Вальор</th><th>Вид</th><th>Сума</th><th>Наредител/Получател</th><th>IBAN</th><th>Основание</th><th>Основание 2</th></tr>
      <tr><td>16.09.2026</td><td>16.09.2026</td><td>CR</td><td>100,00</td><td>Клиент ЕООД</td><td>${CLIENT}</td><td>Ф-ра 10</td><td>от 01.09.2026</td></tr>
      <tr><td>17.09.2026</td><td>17.09.2026</td><td>DR</td><td>20,00</td><td></td><td></td><td>Такса</td><td></td></tr>
    </table></body></html>`;
    const s = parseBankStatement({ text: html }, 'UNCRBGSF')!;
    expect(s).toMatchObject({ format: 'Unicredit HTML', iban: 'BG66UNCR70001598765432', currency: 'EUR', openingBalance: '0.00', closingBalance: '80.00' });
    expect(rowsOf(s)).toEqual([
      ['2026-09-16', true, '100.00', CLIENT, 'Клиент ЕООД', 'Ф-ра 10 от 01.09.2026', ''],
      ['2026-09-17', false, '20.00', '', '', 'Такса', ''],
    ]);
    expect(s.rows.map((r) => r.props.MovementType)).toEqual(['КТ', 'ДТ']);
  });

  it('banks without an HTML service and documents without html/head/body are refused', () => {
    expect(parseBankStatement({ text: DSK }, 'BPBIBGSF')).toBeNull();
    expect(parseBankStatement({ text: DSK }, null)).toBeNull();
    expect(parseHtmlStatement(DSK.replace(/<head>[\s\S]*<\/head>/, ''), 'STSABGSF')).toBeNull();
    expect(parseHtmlStatement('<html><head></head><body><p>няма таблица</p></body></html>', 'STSABGSF')).toBeNull();
  });
});

describe('decodeText and <meta charset>', () => {
  it('windows-1251 by the meta tag, utf-8 by content, a wrong meta falls back to sniffing', () => {
    const page = (charset: string) => `<html><head><meta charset="${charset}"></head><body>Движение по сметка</body></html>`;
    expect(decodeText(cp1251(page('windows-1251')))).toContain('Движение по сметка');
    expect(decodeText(new TextEncoder().encode(page('utf-8')))).toContain('Движение по сметка');
    // Declared utf-8, written in windows-1251: the declaration does not decode, the cp1251 fallback does.
    expect(decodeText(cp1251(page('utf-8')))).toContain('Движение по сметка');
  });
});

describe('two-row headers (rowspan / colspan)', () => {
  it('htmlTableGrid expands rowspan and colspan; htmlTableRows keeps the columns aligned', () => {
    const doc = parseHtml(`<html><head></head><body><table>
      <tr><th rowspan="2">Дата</th><th colspan="2">Сума</th><th rowspan=2>Описание</th></tr>
      <tr><th>Дебит</th><th>Кредит</th></tr>
      <tr><td rowspan="2">01.09.2026</td><td>1</td><td></td><td>a</td></tr>
      <tr><td></td><td>2</td><td>b</td></tr>
    </table></body></html>`);
    const table = htmlDescendants(doc.root, 'table')[0]!;
    const grid = htmlTableGrid(table);
    expect(grid.map((r) => r.map((s) => s && `${s.cell.text}@${s.row},${s.col}`))).toEqual([
      ['Дата@0,0', 'Сума@0,1', 'Сума@0,1', 'Описание@0,3'],
      ['Дата@0,0', 'Дебит@1,1', 'Кредит@1,2', 'Описание@0,3'],
      ['01.09.2026@2,0', '1@2,1', '@2,2', 'a@2,3'],
      ['01.09.2026@2,0', '@3,1', '2@3,2', 'b@3,3'],
    ]);
    // A date written once for two movements belongs to both rows; colspan slots stay empty.
    expect(htmlTableRows(table).map((r) => r.map((c) => c.text))).toEqual([
      ['Дата', 'Сума', '', 'Описание'],
      ['Дата', 'Дебит', 'Кредит', 'Описание'],
      ['01.09.2026', '1', '', 'a'],
      ['01.09.2026', '', '2', 'b'],
    ]);
  });

  it('"Сума" over "Дебит | Кредит" and "Наредител / Получател" over "Име | IBAN": columns bound by the caption path, direction from the side', () => {
    const html = `<html><head></head><body>
      <p>ОТЧЕТ ПО СМЕТКА: BG44UBBS80021012345678 EUR</p>
      <table>
        <tr><th rowspan="2">Дата</th><th rowspan="2">Референция</th><th colspan="2">Салдо</th><th colspan="2">Сума</th><th colspan="2">Наредител / Получател</th><th rowspan="2">Основание</th></tr>
        <tr><th>Дебит</th><th>Кредит</th><th>Дебит</th><th>Кредит</th><th>Име</th><th>IBAN</th></tr>
        <tr><td>11.09.2026</td><td>R1</td><td>0,00</td><td>8 765,44</td><td>1 234,56</td><td></td><td>Доставчик ООД</td><td>${SUPPLIER}</td><td>Плащане ф-ра 5</td></tr>
        <tr><td>12.09.2026</td><td>R2</td><td>0,00</td><td>8 865,34</td><td></td><td>99,90</td><td>Клиент ЕООД</td><td>${CLIENT}</td><td>Ф-ра 6</td></tr>
        <tr><td>Оборот за периода</td><td></td><td></td><td></td><td>1 234,56</td><td>99,90</td></tr>
      </table></body></html>`;
    const s = parseHtmlStatement(html, 'UBBSBGSF')!;
    expect(s).toMatchObject({ format: 'OBB HTML', iban: 'BG44UBBS80021012345678' });
    // The "Салдо" Дебит/Кредит pair is a balance: the amounts come from the "Сума" pair.
    expect(rowsOf(s)).toEqual([
      ['2026-09-11', false, '1234.56', SUPPLIER, 'Доставчик ООД', 'Плащане ф-ра 5', 'R1'],
      ['2026-09-12', true, '99.90', CLIENT, 'Клиент ЕООД', 'Ф-ра 6', 'R2'],
    ]);
    expect(s.rows[0]!.props).toMatchObject({ DebitSum: '1234.56', CreditSum: '', OppositeSideName: 'Доставчик ООД', OppositeSideIBAN: SUPPLIER });
    expect(s.rows[1]!.props).toMatchObject({ DebitSum: '', CreditSum: '99.9' });
  });

  it('"Наредител" and "Получател" groups each over "Име | IBAN": an outflow takes the beneficiary, an inflow the payer', () => {
    const html = `<html><head></head><body><table>
      <tr><td>IBAN</td><td>BG55BUIN95611000123456</td><td>EUR</td></tr>
      <tr><th rowspan="2">Дата</th><th colspan="2">Сума</th><th colspan="2">Наредител</th><th colspan="2">Получател</th><th rowspan="2">Основание</th></tr>
      <tr><th>Стойност</th><th>Дт/Кт</th><th>Име</th><th>IBAN</th><th>Име</th><th>IBAN</th></tr>
      <tr><td>03.09.2026</td><td>1,250.50</td><td>D</td><td>Тест ООД</td><td>BG55BUIN95611000123456</td><td>Доставчик ООД</td><td>${SUPPLIER}</td><td>Наем</td></tr>
      <tr><td>10.09.2026</td><td>2,000.00</td><td>C</td><td>Клиент ЕООД</td><td>${CLIENT}</td><td>Тест ООД</td><td>BG55BUIN95611000123456</td><td>Ф-ра 77</td></tr>
    </table></body></html>`;
    const s = parseHtmlStatement(html, 'BUINBGSF')!;
    expect(s.iban).toBe('BG55BUIN95611000123456');
    expect(rowsOf(s)).toEqual([
      ['2026-09-03', false, '1250.50', SUPPLIER, 'Доставчик ООД', 'Наем', ''],
      ['2026-09-10', true, '2000.00', CLIENT, 'Клиент ЕООД', 'Ф-ра 77', ''],
    ]);
    expect(s.rows.map((r) => r.props.MovementType)).toEqual(['D', 'C']);
  });

  it('"Дата" over "Операция | Вальор", a rowspan date in the data, and a group caption over values is no header band', () => {
    const html = `<html><head></head><body><table>
      <tr><td>Сметка</td><td>BG13RZBB91551001234567 EUR</td></tr>
      <tr><th colspan="2">Дата</th><th rowspan="2">Сума</th><th rowspan="2">Контрагент</th><th rowspan="2">Основание</th></tr>
      <tr><th>Операция</th><th>Вальор</th></tr>
      <tr><td rowspan="2">14.09.2026</td><td>15.09.2026</td><td>-150,00</td><td>Доставчик ООД</td><td>Ток</td></tr>
      <tr><td>16.09.2026</td><td>+300,00</td><td>Клиент ЕООД</td><td>Ф-ра 8</td></tr>
    </table></body></html>`;
    const s = parseHtmlStatement(html, 'RZBBBGSF')!;
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount, r.partnerName, r.reason])).toEqual([
      ['2026-09-14', false, '150.00', 'Доставчик ООД', 'Ток'],
      ['2026-09-14', true, '300.00', 'Клиент ЕООД', 'Ф-ра 8'],
    ]);
    expect(s.rows.map((r) => r.props.ValueDate)).toEqual(['15.09.2026', '16.09.2026']);
    // "Основание" spans two data columns: the row below holds values, so the header is one row.
    const one = `<html><head></head><body><table>
      <tr><th>Дата</th><th>Сума</th><th>Контрагент</th><th colspan="2">Основание</th></tr>
      <tr><td>14.09.2026</td><td>-150,00</td><td>Доставчик ООД</td><td>Ток</td><td>08.2026</td></tr>
    </table></body></html>`;
    expect(parseHtmlStatement(one, 'RZBBBGSF')!.rows.map((r) => [r.date, r.amount, r.reason])).toEqual([['2026-09-14', '150.00', 'Ток']]);
  });
});
