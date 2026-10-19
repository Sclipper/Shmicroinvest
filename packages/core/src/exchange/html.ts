/**
 * A small, tolerant HTML reader for bank statement exports (spec 04b 1.13).
 * Delta reads these files with HtmlAgilityPack; this builds the same kind of
 * tree: tags are lower-cased, `td`/`th`/`tr`/`p`/`li` close implicitly, void
 * elements have no children and mismatched end tags are recorded as parse
 * errors (Fibank's probe refuses a file with parse errors).
 */

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
}
export type HtmlNode = HtmlElement | string;

export interface HtmlDocument {
  /** Synthetic `#document` node; `html` is one of its children when the file has the tag. */
  root: HtmlElement;
  /** TagNotOpened / TagNotClosed errors, as HtmlAgilityPack's ParseErrors. */
  errors: string[];
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'isindex']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
/** Elements whose end tag may be omitted (no parse error when closed implicitly). */
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption']);
const BLOCK = new Set(['div', 'p', 'tr', 'table', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'thead', 'tbody', 'tfoot', 'caption', 'pre', 'blockquote', 'section', 'article', 'header', 'footer', 'center', 'form', 'dl', 'dt', 'dd']);

const NAMED: Record<string, string> = {
  nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€', copy: '©', reg: '®', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', hellip: '…', deg: '°', middot: '·', shy: '', times: '×', numero: '№', bull: '•',
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of src.matchAll(re)) attrs[m[1]!.toLowerCase()] ??= decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

export function parseHtml(text: string): HtmlDocument {
  const root: HtmlElement = { tag: '#document', attrs: {}, children: [], parent: null };
  const errors: string[] = [];
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  const open = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) if (stack[i]!.tag === tag) return i;
    return -1;
  };
  /** Closes the elements above index i (exclusive); `implied` closes are not errors for OPTIONAL_END tags. */
  const popTo = (i: number) => {
    while (stack.length > i) {
      const el = stack.pop()!;
      if (!OPTIONAL_END.has(el.tag)) errors.push(`TagNotClosed: ${el.tag}`);
    }
  };
  /** Closes the innermost `tags` element when it is open below a `boundary` element. */
  const closeWithin = (tags: string[], boundary: string[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const t = stack[i]!.tag;
      if (boundary.includes(t)) return;
      if (tags.includes(t)) return popTo(i);
    }
  };
  const tagRe = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let pos = 0;
  const addText = (t: string) => {
    if (t) top().children.push(t);
  };
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    addText(text.slice(pos, m.index));
    pos = tagRe.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      if (tag === 'br') {
        top().children.push({ tag: 'br', attrs: {}, children: [], parent: top() });
        continue;
      }
      const i = open(tag);
      if (i < 0) {
        if (!VOID.has(tag)) errors.push(`TagNotOpened: ${tag}`);
        continue;
      }
      popTo(i + 1);
      stack.pop();
      continue;
    }
    if (!m[2]) continue; // comment, doctype, processing instruction
    const tag = m[2].toLowerCase();
    const rawAttrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    if (tag === 'td' || tag === 'th') closeWithin(['td', 'th'], ['tr', 'table']);
    else if (tag === 'tr') closeWithin(['tr'], ['table']);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') closeWithin(['thead', 'tbody', 'tfoot'], ['table']);
    else if (tag === 'li') closeWithin(['li'], ['ul', 'ol']);
    else if (tag === 'option') closeWithin(['option'], ['select']);
    else if (tag === 'p' && top().tag === 'p') popTo(stack.length - 1);
    const el: HtmlElement = { tag, attrs: parseAttrs(rawAttrs.replace(/\/\s*$/, '')), children: [], parent: top() };
    top().children.push(el);
    if (VOID.has(tag) || selfClosing) continue;
    if (RAW.has(tag)) {
      const end = new RegExp(`</\\s*${tag}\\s*>`, 'ig');
      end.lastIndex = pos;
      const e = end.exec(text);
      el.children.push(text.slice(pos, e ? e.index : text.length));
      pos = e ? end.lastIndex : text.length;
      tagRe.lastIndex = pos;
      continue;
    }
    stack.push(el);
  }
  addText(text.slice(pos));
  popTo(1);
  return { root, errors };
}

export const isHtmlElement = (n: HtmlNode | undefined): n is HtmlElement => typeof n === 'object' && n !== null;

/** Direct child element by tag. */
export function htmlChild(el: HtmlElement | undefined, tag: string): HtmlElement | undefined {
  return el?.children.find((c): c is HtmlElement => isHtmlElement(c) && c.tag === tag);
}

/** Descendant elements by tag in document order (`//tag`). */
export function htmlDescendants(el: HtmlElement, tag: string): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (e: HtmlElement) => {
    for (const c of e.children) {
      if (!isHtmlElement(c)) continue;
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

export const hasClass = (el: HtmlElement, cls: string) => (el.attrs.class ?? '').split(/\s+/).includes(cls);

/**
 * Visible text: entities decoded, white space collapsed, `<br>` and block
 * elements become line breaks (two `<br>` in a row leave an empty line),
 * non-breaking spaces become spaces, every line trimmed.
 */
export function htmlText(el: HtmlElement, opts: { skipTables?: boolean } = {}): string {
  let out = '';
  const nl = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const walk = (e: HtmlElement) => {
    for (const c of e.children) {
      if (typeof c === 'string') {
        out += decodeHtmlEntities(c.replace(/[ \t\r\n\f]+/g, ' '));
        continue;
      }
      if (c.tag === 'br') {
        out += '\n';
        continue;
      }
      if (c.tag === 'script' || c.tag === 'style' || c.tag === 'head' || c.tag === 'title') continue;
      if (opts.skipTables && c.tag === 'table') {
        nl();
        continue;
      }
      if (c.tag === 'td' || c.tag === 'th') out += ' ';
      const block = BLOCK.has(c.tag);
      if (block) nl();
      walk(c);
      if (block) nl();
    }
  };
  walk(el);
  return out.replace(/\u00a0/g, ' ').split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/^\n+|\n+$/g, '');
}

export interface HtmlCell {
  text: string;
  /** The cell's `class` tokens (DSK marks amounts with `amt`). */
  classes: string[];
}

/** One slot of a table grid: the source cell and the position and size of its top-left corner. */
export interface HtmlGridSlot {
  cell: HtmlCell;
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  /** The `th` tag (header cells). */
  th: boolean;
}

const span = (v: string | undefined) => Math.max(1, Math.min(Math.floor(Number(v)) || 1, 50));

/**
 * The table as a grid with `colspan` and `rowspan` expanded (the HTML table
 * model): every slot a cell covers points to that cell, so the columns of the
 * rows below a spanning cell stay aligned. Rows go through thead/tbody/tfoot
 * (and a wrapping form), not into nested tables; a row is as long as its last
 * covered slot, ragged rows leave `undefined` holes.
 */
export function htmlTableGrid(table: HtmlElement): (HtmlGridSlot | undefined)[][] {
  const trs: HtmlElement[] = [];
  const walk = (e: HtmlElement) => {
    for (const c of e.children) {
      if (!isHtmlElement(c)) continue;
      if (c.tag === 'tr') trs.push(c);
      else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot' || c.tag === 'form') walk(c);
    }
  };
  walk(table);
  const grid: (HtmlGridSlot | undefined)[][] = trs.map(() => []);
  trs.forEach((tr, r) => {
    let col = 0;
    for (const td of tr.children) {
      if (!isHtmlElement(td) || (td.tag !== 'td' && td.tag !== 'th')) continue;
      while (grid[r]![col]) col++;
      // rowspan="0" spans to the end of the table section; clipped to the table here.
      const rs = td.attrs.rowspan === '0' ? trs.length - r : Math.min(span(td.attrs.rowspan), trs.length - r);
      const slot: HtmlGridSlot = { cell: { text: htmlText(td), classes: (td.attrs.class ?? '').split(/\s+/).filter(Boolean) }, row: r, col, rowspan: rs, colspan: span(td.attrs.colspan), th: td.tag === 'th' };
      for (let i = 0; i < rs; i++) for (let j = 0; j < slot.colspan; j++) grid[r + i]![col + j] ??= slot;
      col += slot.colspan;
    }
  });
  return grid;
}

/**
 * Rows of a table, aligned by the grid: a `colspan` cell is followed by empty
 * cells; the slots a `rowspan` cell covers in the rows below repeat its text
 * (a date written once for two movements belongs to both).
 */
export function htmlTableRows(table: HtmlElement): HtmlCell[][] {
  return htmlGridRows(htmlTableGrid(table));
}

/** {@link htmlTableRows} of a grid already built. */
export function htmlGridRows(grid: (HtmlGridSlot | undefined)[][]): HtmlCell[][] {
  return grid.map((row, r) =>
    Array.from(row, (s, c) => {
      if (!s || s.col !== c) return { text: '', classes: [] };
      return s.row === r ? s.cell : { text: s.cell.text, classes: s.cell.classes };
    }),
  );
}
