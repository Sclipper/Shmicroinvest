import { dec } from '../money.ts';

/**
 * Condition language of the bank-statement posting rules (spec 03a 9.3,
 * 04b 1.6). A condition is a token list (FormulaDependencies in Delta):
 * properties of the bank model, string and number literals and operators.
 *
 *   DebitAmount > 0 и също (Reason съдържа "каса" или Reason съдържа "ATM")
 *
 * Priorities: `или` 20, `и също` 20 (same level, left to right), comparisons
 * 30-32, the unary `е клиент/доставчик` 998 (binds tightest).
 * Strings compare lower-cased; an empty property value is " " (Delta wraps
 * strings in |...| so an empty value becomes "| |").
 */

export type ConditionTokenType = 'property' | 'operation' | 'string' | 'number';
export interface ConditionToken {
  type: ConditionTokenType;
  value: string;
}

export const CONDITION_OPERATORS = ['или', 'и също', '=', 'започва с', 'не съдържа', 'съдържа', 'е клиент/доставчик', '>', '<', '(', ')'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

const COMPARISONS = new Set(['=', 'започва с', 'не съдържа', 'съдържа', '>', '<']);
const LOGICAL = new Set(['или', 'и също']);

export class ConditionError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

/** Expression tree. */
export type ConditionNode =
  | { kind: 'logical'; op: 'или' | 'и също'; left: ConditionNode; right: ConditionNode }
  | { kind: 'compare'; op: string; left: ConditionOperand; right: ConditionOperand }
  | { kind: 'partner'; operand: ConditionOperand };
export type ConditionOperand = { kind: 'property'; name: string } | { kind: 'string'; value: string } | { kind: 'number'; value: string };

/** Parses the text form into tokens. `properties` restricts property names when given. */
export function tokenizeCondition(text: string, properties?: string[]): ConditionToken[] {
  const out: ConditionToken[] = [];
  const ops = [...CONDITION_OPERATORS].sort((a, b) => b.length - a.length);
  const props = properties ? new Map(properties.map((p) => [p.toLowerCase(), p])) : null;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === '“' || c === '„' || c === "'") {
      const close = c === '„' || c === '“' ? /["“”]/ : c === "'" ? /'/ : /"/;
      let j = i + 1;
      while (j < text.length && !close.test(text[j]!)) j++;
      if (j >= text.length) throw new ConditionError('Незатворен низ в условието.', i);
      out.push({ type: 'string', value: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const rest = text.slice(i);
    const lower = rest.toLowerCase();
    const op = ops.find((o) => lower.startsWith(o) && (/[()=<>]/.test(o) || !/[\p{L}\d_]/u.test(rest[o.length] ?? ' ')));
    if (op) {
      out.push({ type: 'operation', value: op });
      i += op.length;
      continue;
    }
    const n = /^-?\d+([.,]\d+)?/.exec(rest);
    if (n) {
      out.push({ type: 'number', value: n[0].replace(',', '.') });
      i += n[0].length;
      continue;
    }
    const id = /^[\p{L}_][\p{L}\d_.]*/u.exec(rest);
    if (id) {
      const name = id[0];
      if (props && !props.has(name.toLowerCase())) throw new ConditionError(`Непознато поле „${name}“.`, i);
      out.push({ type: 'property', value: props?.get(name.toLowerCase()) ?? name });
      i += name.length;
      continue;
    }
    throw new ConditionError(`Невалиден символ „${c}“ в условието.`, i);
  }
  return out;
}

/** Text form of a token list (inverse of tokenizeCondition). */
export function conditionToText(tokens: ConditionToken[]): string {
  return tokens
    .map((t) => (t.type === 'string' ? `"${t.value}"` : t.value))
    .join(' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')');
}

/** Builds the expression tree; throws ConditionError on a malformed list. */
export function parseCondition(tokens: ConditionToken[]): ConditionNode {
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (t: ConditionToken | undefined, v?: string) => !!t && t.type === 'operation' && (v === undefined || t.value === v);

  const operand = (): ConditionOperand => {
    const t = tokens[p];
    if (!t) throw new ConditionError('Непълно условие: очаква се поле или стойност.', p);
    if (t.type === 'operation') throw new ConditionError(`Очаква се поле или стойност вместо „${t.value}“.`, p);
    p++;
    if (t.type === 'property') return { kind: 'property', name: t.value };
    if (t.type === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(t.value)) throw new ConditionError(`Невалидно число „${t.value}“.`, p - 1);
      return { kind: 'number', value: t.value };
    }
    return { kind: 'string', value: t.value };
  };

  const primary = (): ConditionNode => {
    if (isOp(peek(), '(')) {
      p++;
      const e = expr();
      if (!isOp(peek(), ')')) throw new ConditionError('Липсва затваряща скоба.', p);
      p++;
      return e;
    }
    const left = operand();
    const t = peek();
    if (isOp(t, 'е клиент/доставчик')) {
      p++;
      if (left.kind !== 'property') throw new ConditionError('„е клиент/доставчик“ се прилага само към поле.', p - 1);
      return { kind: 'partner', operand: left };
    }
    if (!t || t.type !== 'operation' || !COMPARISONS.has(t.value)) throw new ConditionError('Очаква се оператор за сравнение.', p);
    p++;
    const right = operand();
    return { kind: 'compare', op: t.value, left, right };
  };

  const expr = (): ConditionNode => {
    let left = primary();
    while (peek() && isOp(peek()) && LOGICAL.has(peek()!.value)) {
      const op = peek()!.value as 'или' | 'и също';
      p++;
      const right = primary();
      left = { kind: 'logical', op, left, right };
    }
    return left;
  };

  if (!tokens.length) throw new ConditionError('Празно условие.', 0);
  const tree = expr();
  if (p < tokens.length) throw new ConditionError(`Неочакван елемент „${tokens[p]!.value}“.`, p);
  return tree;
}

/** Validation used by the template editor: null when valid, else the engine's message. */
export function validateCondition(tokens: ConditionToken[], properties?: string[]): string | null {
  try {
    if (properties) {
      const known = new Set(properties.map((x) => x.toLowerCase()));
      const bad = tokens.find((t) => t.type === 'property' && !known.has(t.value.toLowerCase()));
      if (bad) return `Непознато поле „${bad.value}“.`;
    }
    parseCondition(tokens);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export interface ConditionContext {
  /** Property value of the statement row (string or number); undefined = missing. */
  get: (name: string) => string | number | null | undefined;
  /** "е клиент/доставчик": the value resolves to a known partner (by IBAN or name). */
  isPartner?: (value: string) => boolean;
}

const norm = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  return s.trim() === '' ? ' ' : s.trim().toLowerCase();
};

function numeric(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return dec(t);
}

function value(o: ConditionOperand, ctx: ConditionContext) {
  if (o.kind === 'property') return ctx.get(o.name);
  return o.value;
}

/** Literal lists ("a,b,c", the NAP IBAN key lists) match any item. */
const items = (s: string) => (s.includes(',') ? s.split(',').map((x) => norm(x)).filter((x) => x !== ' ') : [s]);

export function evaluateCondition(node: ConditionNode, ctx: ConditionContext): boolean {
  switch (node.kind) {
    case 'logical':
      return node.op === 'или' ? evaluateCondition(node.left, ctx) || evaluateCondition(node.right, ctx) : evaluateCondition(node.left, ctx) && evaluateCondition(node.right, ctx);
    case 'partner': {
      const v = value(node.operand, ctx);
      return !!v && String(v).trim() !== '' && !!ctx.isPartner?.(String(v).trim());
    }
    case 'compare': {
      const lv = value(node.left, ctx);
      const rv = value(node.right, ctx);
      if (node.op === '>' || node.op === '<' || (node.op === '=' && (node.left.kind === 'number' || node.right.kind === 'number'))) {
        const ln = numeric(lv);
        const rn = numeric(rv);
        if (ln === null || rn === null) return node.op === '=' ? norm(lv) === norm(rv) : false;
        return node.op === '>' ? ln.greaterThan(rn) : node.op === '<' ? ln.lessThan(rn) : ln.eq(rn);
      }
      const l = norm(lv);
      const r = norm(rv);
      const list = node.right.kind === 'string' ? items(r) : [r];
      switch (node.op) {
        case '=':
          return list.some((x) => l === x);
        case 'съдържа':
          return list.some((x) => l.includes(x));
        case 'не съдържа':
          return !list.some((x) => l.includes(x));
        case 'започва с':
          return list.some((x) => l.startsWith(x));
      }
      return false;
    }
  }
}

/** Convenience: tokens -> boolean predicate (throws on invalid formulas). */
export function compileCondition(tokens: ConditionToken[]): (ctx: ConditionContext) => boolean {
  const tree = parseCondition(tokens);
  return (ctx) => evaluateCondition(tree, ctx);
}
