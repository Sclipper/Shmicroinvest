/**
 * Small, dependency-free XML reader/writer for the exchange formats
 * (TransferData, camt.053, bank XML statements). It supports elements,
 * attributes, namespaces, text, CDATA, comments, processing instructions and
 * the predefined / numeric entities. DTDs are skipped (never expanded).
 */

export interface XmlElement {
  /** Qualified name as written (may carry a prefix). */
  name: string;
  /** Local name without prefix. */
  local: string;
  /** Resolved namespace URI ('' when none). */
  ns: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside the element. */
  text: string;
  line: number;
  col: number;
}

export class XmlSyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`${message} on line ${line} position ${col}`);
    this.line = line;
    this.col = col;
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string, line: number, col: number): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);?/g, (m, body: string) => {
    if (!m.endsWith(';')) throw new XmlSyntaxError(`Invalid entity reference '${m}'`, line, col);
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    const v = ENTITIES[body];
    if (v === undefined) throw new XmlSyntaxError(`Reference to undeclared entity '${body}'`, line, col);
    return v;
  });
}

/** Parses an XML document and returns its root element. Throws XmlSyntaxError. */
export function parseXml(input: string): XmlElement {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const pos = () => ({ line, col: i - lineStart + 1 });
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
      i++;
    }
  };
  const fail = (msg: string): never => {
    const p = pos();
    throw new XmlSyntaxError(msg, p.line, p.col);
  };
  const skipUntil = (end: string) => {
    const j = src.indexOf(end, i);
    if (j < 0) fail(`Unexpected end of file, expected '${end}'`);
    advance(j - i + end.length);
  };

  const stack: { el: XmlElement; nsMap: Map<string, string> }[] = [];
  let root: XmlElement | null = null;
  const rootNs = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);

  while (i < src.length) {
    const ch = src[i];
    if (ch === '<') {
      if (src.startsWith('<?', i)) {
        skipUntil('?>');
      } else if (src.startsWith('<!--', i)) {
        skipUntil('-->');
      } else if (src.startsWith('<![CDATA[', i)) {
        if (!stack.length) fail('CDATA outside the root element');
        const start = i + 9;
        const j = src.indexOf(']]>', start);
        if (j < 0) fail('Unterminated CDATA section');
        stack[stack.length - 1]!.el.text += src.slice(start, j);
        advance(j + 3 - i);
      } else if (src.startsWith('<!', i)) {
        // DOCTYPE (possibly with an internal subset) - skipped.
        let depth = 0;
        while (i < src.length) {
          const c = src[i];
          if (c === '[') depth++;
          else if (c === ']') depth--;
          else if (c === '>' && depth <= 0) break;
          advance(1);
        }
        advance(1);
      } else if (src[i + 1] === '/') {
        const p = pos();
        const j = src.indexOf('>', i);
        if (j < 0) fail('Unterminated end tag');
        const name = src.slice(i + 2, j).trim();
        const top = stack.pop();
        if (!top) throw new XmlSyntaxError(`Unexpected end tag '${name}'`, p.line, p.col);
        if (top.el.name !== name) throw new XmlSyntaxError(`The '${top.el.name}' start tag on line ${top.el.line} position ${top.el.col} does not match the end tag of '${name}'`, p.line, p.col);
        advance(j + 1 - i);
      } else {
        const p = pos();
        advance(1);
        const nameMatch = /^[^\s/>]+/.exec(src.slice(i, i + 256));
        if (!nameMatch) fail('Name cannot begin with this character');
        const name = nameMatch![0];
        advance(name.length);
        const rawAttrs: [string, string][] = [];
        let selfClosing = false;
        for (;;) {
          while (/\s/.test(src[i] ?? '')) advance(1);
          if (i >= src.length) fail('Unexpected end of file in start tag');
          if (src.startsWith('/>', i)) {
            selfClosing = true;
            advance(2);
            break;
          }
          if (src[i] === '>') {
            advance(1);
            break;
          }
          const ap = pos();
          const am = /^([^\s=/>]+)\s*=\s*(["'])/.exec(src.slice(i, i + 512));
          if (!am) fail(`Invalid attribute syntax in element '${name}'`);
          const aname = am![1]!;
          const quote = am![2]!;
          advance(am![0].length);
          const end = src.indexOf(quote, i);
          if (end < 0) fail('Unterminated attribute value');
          const raw = src.slice(i, end);
          if (raw.includes('<')) fail(`'<' is not allowed in attribute value of '${aname}'`);
          advance(end + 1 - i);
          if (rawAttrs.some(([n]) => n === aname)) throw new XmlSyntaxError(`'${aname}' is a duplicate attribute name`, ap.line, ap.col);
          rawAttrs.push([aname, decodeEntities(raw.replace(/[\r\n\t]/g, ' '), ap.line, ap.col)]);
        }
        const parentNs = stack.length ? stack[stack.length - 1]!.nsMap : rootNs;
        let nsMap = parentNs;
        const attrs: Record<string, string> = {};
        for (const [n, v] of rawAttrs) {
          if (n === 'xmlns' || n.startsWith('xmlns:')) {
            if (nsMap === parentNs) nsMap = new Map(parentNs);
            nsMap.set(n === 'xmlns' ? '' : n.slice(6), v);
          }
        }
        for (const [n, v] of rawAttrs) {
          if (n === 'xmlns' || n.startsWith('xmlns:')) continue;
          attrs[n] = v;
        }
        const colon = name.indexOf(':');
        const prefix = colon > 0 ? name.slice(0, colon) : '';
        const local = colon > 0 ? name.slice(colon + 1) : name;
        const ns = nsMap.get(prefix) ?? '';
        if (prefix && !nsMap.has(prefix)) throw new XmlSyntaxError(`'${prefix}' is an undeclared prefix`, p.line, p.col);
        const el: XmlElement = { name, local, ns, attrs, children: [], text: '', line: p.line, col: p.col };
        if (stack.length) stack[stack.length - 1]!.el.children.push(el);
        else if (root) throw new XmlSyntaxError('There are multiple root elements', p.line, p.col);
        else root = el;
        if (!selfClosing) stack.push({ el, nsMap });
      }
    } else {
      const j = src.indexOf('<', i);
      const end = j < 0 ? src.length : j;
      const p = pos();
      const text = src.slice(i, end);
      if (stack.length) stack[stack.length - 1]!.el.text += decodeEntities(text, p.line, p.col);
      else if (text.trim()) throw new XmlSyntaxError('Data at the root level is invalid', p.line, p.col);
      advance(end - i);
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1]!.el;
    throw new XmlSyntaxError(`Unexpected end of file. The following elements are not closed: ${top.name}`, line, i - lineStart + 1);
  }
  if (!root) throw new XmlSyntaxError('Root element is missing', 1, 1);
  return root;
}

/** First child with the given local name. */
export function child(el: XmlElement | undefined, local: string): XmlElement | undefined {
  return el?.children.find((c) => c.local === local);
}

/** All children with the given local name. */
export function children(el: XmlElement | undefined, local: string): XmlElement[] {
  return el ? el.children.filter((c) => c.local === local) : [];
}

/** Text of a descendant path, e.g. path(el, 'Amt') or path(el, 'NtryDtls', 'TxDtls', 'RmtInf', 'Ustrd'). */
export function pathText(el: XmlElement | undefined, ...names: string[]): string | undefined {
  let cur = el;
  for (const n of names) cur = child(cur, n);
  return cur?.text.trim();
}

/** All descendants (depth-first) with the given local name. */
export function descendants(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Minimal writer: element tree -> indented XML text. */
export interface XmlNode {
  name: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  children?: XmlNode[];
  text?: string;
}

export function writeXml(root: XmlNode, opts: { declaration?: boolean; indent?: string } = {}): string {
  const indent = opts.indent ?? '  ';
  const out: string[] = [];
  if (opts.declaration !== false) out.push('<?xml version="1.0" encoding="utf-8"?>');
  const write = (n: XmlNode, depth: number) => {
    const pad = indent.repeat(depth);
    const attrs = Object.entries(n.attrs ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
      .join('');
    const kids = n.children ?? [];
    if (!kids.length && !n.text) out.push(`${pad}<${n.name}${attrs} />`);
    else if (!kids.length) out.push(`${pad}<${n.name}${attrs}>${escapeXml(n.text!)}</${n.name}>`);
    else {
      out.push(`${pad}<${n.name}${attrs}>`);
      for (const k of kids) write(k, depth + 1);
      out.push(`${pad}</${n.name}>`);
    }
  };
  write(root, 0);
  return out.join('\r\n') + '\r\n';
}
