/**
 * Chart of accounts helpers (spec 01a sections 4-6).
 */

export interface TreeNode {
  id: number;
  parentId: number | null;
  number: string;
  isEuro?: boolean;
}

export interface NestedSetPosition {
  left: number;
  right: number;
  level: number;
}

/**
 * Rebuild Left/Right/Level the way `spRebuildAccountsTree` does: a DFS from the
 * `Number = '0'` root of each chart, always visiting the child with the
 * GREATEST number string next, so siblings get intervals in descending number
 * order. Each chart (IsEuro value) is numbered independently from 1.
 * Accounts unreachable from the root keep no entry in the result.
 */
export function rebuildNestedSet(nodes: TreeNode[]): Map<number, NestedSetPosition> {
  const result = new Map<number, NestedSetPosition>();
  const charts = new Map<boolean, TreeNode[]>();
  for (const n of nodes) {
    const key = Boolean(n.isEuro);
    const list = charts.get(key) ?? [];
    list.push(n);
    charts.set(key, list);
  }
  for (const list of charts.values()) {
    const children = new Map<number, TreeNode[]>();
    for (const n of list) {
      if (n.parentId === null) continue;
      const arr = children.get(n.parentId) ?? [];
      arr.push(n);
      children.set(n.parentId, arr);
    }
    const root = list.find((n) => n.parentId === null && n.number === '0');
    if (!root) continue;
    let counter = 1;
    // Iterative DFS; children sorted descending by number (string compare, as SQL does).
    const visit = (node: TreeNode, level: number) => {
      const stack: { node: TreeNode; level: number; open: boolean }[] = [{ node, level, open: false }];
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        if (!top.open) {
          top.open = true;
          result.set(top.node.id, { left: counter++, right: 0, level: top.level });
          const kids = (children.get(top.node.id) ?? []).slice().sort((a, b) => cmp(a.number, b.number));
          // Push ascending so the greatest number is on top of the stack.
          for (const k of kids) stack.push({ node: k, level: top.level + 1, open: false });
        } else {
          result.get(top.node.id)!.right = counter++;
          stack.pop();
        }
      }
    };
    visit(root, 1);
  }
  return result;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Smallest positive integer n not used as a suffix among the parent's children;
 * returns parent + separator + n (spec 01a 4.2, ChartOfAccountsService.GetNextSubAccountNumber).
 */
export function nextSubAccountNumber(parentNumber: string, childNumbers: string[], separator = '/'): string {
  const prefix = parentNumber + separator;
  const used = new Set<number>();
  for (const c of childNumbers) {
    if (!c.startsWith(prefix)) continue;
    const suffix = c.slice(prefix.length);
    if (/^\d+$/.test(suffix)) used.add(Number(suffix));
  }
  let n = 1;
  while (used.has(n)) n++;
  return prefix + n;
}

/** Typed number with "." and " " normalised to the separator (03a 1.5). */
export const normalizeAccountNumber = (n: string, separator = '/') => n.trim().replace(/[.\s]+/g, separator);

/**
 * Number shape under a parent (03a 1.5, strInvalidAccountNumber). The commercial
 * chart keeps the national-chart levels: classes (1 digit) under the root,
 * groups (2 digits) under a class, synthetic accounts (3 digits) under a group,
 * then analytic sub-accounts "parent/n".
 */
export function isValidAccountNumber(parentNumber: string, number: string, separator = '/'): boolean {
  if (parentNumber === '0') return /^\d$/.test(number);
  if (/^\d{1,2}$/.test(parentNumber)) return /^\d+$/.test(number) && number.length === parentNumber.length + 1 && number.startsWith(parentNumber);
  const prefix = parentNumber + separator;
  return number.startsWith(prefix) && /^\d+$/.test(number.slice(prefix.length)) && Number(number.slice(prefix.length)) > 0;
}

/** Default number of a new account under a parent: next free digit above synthetic level, else "parent/n". */
export function nextAccountNumber(parentNumber: string, childNumbers: string[], separator = '/'): string {
  if (parentNumber === '0' || /^\d{1,2}$/.test(parentNumber)) {
    const base = parentNumber === '0' ? '' : parentNumber;
    for (let d = parentNumber === '0' ? 1 : 0; d <= 9; d++) if (!childNumbers.includes(base + d)) return base + d;
    return base + '9';
  }
  return nextSubAccountNumber(parentNumber, childNumbers, separator);
}

/** Leaf test used by the app: Right - Left <= 1. */
export function isLeaf(pos: { left: number; right: number }): boolean {
  return pos.right - pos.left <= 1;
}

/** Account nature: IsActive tri-state. */
export type AccountNature = 'active' | 'passive' | 'activePassive';
export function natureFromIsActive(isActive: boolean | null): AccountNature {
  return isActive === true ? 'active' : isActive === false ? 'passive' : 'activePassive';
}
export function isActiveFromNature(n: AccountNature): boolean | null {
  return n === 'active' ? true : n === 'passive' ? false : null;
}

/**
 * "Сметка за приключване" applies to active and passive accounts only: the
 * account editor disables the picker for active-passive accounts
 * (CanModifyConcludeAccount = !IsActivePassiveChecked, 01a 4.1, 07 3.5).
 */
export function canHaveConcludeAccount(isActive: boolean | null): boolean {
  return isActive !== null;
}

/** Conclude account stored for an account: cleared for active-passive accounts and when it points at the account itself. */
export function effectiveConcludeAccountId(accountId: number | null, isActive: boolean | null, concludeAccountId: number | null): number | null {
  if (!canHaveConcludeAccount(isActive) || concludeAccountId == null) return null;
  return concludeAccountId === accountId ? null : concludeAccountId;
}
