import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, crc32, unzipStore, zipStore } from '../src/index.ts';

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe('xlsx export (05 11.1)', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('zip round trip', () => {
    const files = [{ name: 'a.txt', data: new TextEncoder().encode('Здравей') }, { name: 'dir/b.xml', data: new Uint8Array([1, 2, 3]) }];
    const zip = zipStore(files);
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const back = unzipStore(zip);
    expect(text(back.get('a.txt'))).toBe('Здравей');
    expect([...back.get('dir/b.xml')!]).toEqual([1, 2, 3]);
  });

  it('column names', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('writes a workbook with strings, amounts, bold rows, widths and merges', () => {
    const wb = buildXlsx([
      { name: 'Оборотна ведомост', rows: [['Оборотна ведомост на <Тест> & Co'], [], ['501', 'Каса', 1234.5, null, { v: 7, format: 'integer' }]], widths: [8, 20, 11], merges: ['A1:H1'], boldRows: [0] },
      { name: 'Оборотна ведомост', rows: [['x']] },
      { name: 'a/b:c', rows: [] },
    ]);
    const files = unzipStore(wb);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']));
    const workbook = text(files.get('xl/workbook.xml'));
    expect(workbook).toContain('name="Оборотна ведомост"');
    expect(workbook).toContain('name="Оборотна ведомост 2"');
    expect(workbook).toContain('name="a b c"');
    const s1 = text(files.get('xl/worksheets/sheet1.xml'));
    expect(s1).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Оборотна ведомост на &lt;Тест&gt; &amp; Co</t></is></c>');
    expect(s1).toContain('<c r="C3" s="2"><v>1234.5</v></c>');
    expect(s1).toContain('<c r="E3" s="4"><v>7</v></c>');
    expect(s1).not.toContain('r="D3"');
    expect(s1).toContain('<mergeCell ref="A1:H1"/>');
    expect(s1).toContain('<col min="2" max="2" width="20" customWidth="1"/>');
  });
});
