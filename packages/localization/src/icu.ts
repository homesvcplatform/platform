// ICU MessageFormat syntax check for the repository catalogs (ADR-025 #2). Supports the subset the catalogs may use:
// text, `{arg}`, `{arg, number|date|time[, style]}`, `{arg, plural|selectordinal, [offset:n] ...}` and
// `{arg, select, ...}` (both with a mandatory `other`), `#` inside plural branches, and apostrophe quoting.
// It validates repository files only; it never formats or parses user input.

export type ArgumentType = 'simple' | 'number' | 'date' | 'time' | 'plural' | 'selectordinal' | 'select';

export interface IcuResult {
  readonly ok: boolean;
  readonly error?: { readonly message: string; readonly offset: number };
  /** Argument name → type (the first type seen). */
  readonly args: ReadonlyMap<string, ArgumentType>;
}

const PLURAL_KEYWORDS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const FORMAT_TYPES = new Set(['number', 'date', 'time']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$|^[0-9]+$/;

class IcuSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

export function checkIcuMessage(message: string): IcuResult {
  const args = new Map<string, ArgumentType>();
  let i = 0;
  const fail = (msg: string): never => {
    throw new IcuSyntaxError(msg, i);
  };
  const ws = () => {
    while (i < message.length && /\s/.test(message[i] ?? '')) i += 1;
  };
  const token = (pattern: RegExp): string => {
    const m = pattern.exec(message.slice(i));
    if (!m || m.index !== 0) return '';
    i += m[0].length;
    return m[0];
  };

  // Text until an unquoted `{` or `}` (or end). Apostrophes: `''` is a literal quote; `'` before a special character
  // starts a quoted run that ends at the next single `'`.
  const text = (inPlural: boolean) => {
    while (i < message.length) {
      const ch = message[i];
      if (ch === '{' || ch === '}') return;
      if (ch === "'") {
        const next = message[i + 1];
        if (next === "'") {
          i += 2;
          continue;
        }
        if (next === '{' || next === '}' || (inPlural && next === '#')) {
          i += 1;
          while (i < message.length) {
            if (message[i] === "'") {
              if (message[i + 1] === "'") {
                i += 2;
                continue;
              }
              break;
            }
            i += 1;
          }
          if (i >= message.length) fail('unterminated quoted text');
          i += 1;
          continue;
        }
      }
      i += 1;
    }
  };

  const record = (name: string, type: ArgumentType) => {
    if (!args.has(name)) args.set(name, type);
    else if (args.get(name) !== type) fail(`argument "${name}" used with two types`);
  };

  const branches = (kind: 'plural' | 'selectordinal' | 'select') => {
    const seen = new Set<string>();
    ws();
    if (kind !== 'select' && token(/offset:/) !== '') {
      ws();
      if (token(/[0-9]+/) === '') fail('offset needs a number');
    }
    for (;;) {
      ws();
      if (message[i] === '}') break;
      const selector = kind === 'select' ? token(/[A-Za-z0-9_-]+/) : token(/=[0-9]+|[a-z]+/);
      if (selector === '') fail(`expected a ${kind} selector`);
      if (kind !== 'select' && !selector.startsWith('=') && !PLURAL_KEYWORDS.has(selector)) fail(`unknown plural keyword "${selector}"`);
      if (seen.has(selector)) fail(`duplicate selector "${selector}"`);
      seen.add(selector);
      ws();
      if (message[i] !== '{') fail(`selector "${selector}" needs a {message}`);
      i += 1;
      body(kind !== 'select');
      if (message[i] !== '}') fail('unterminated branch');
      i += 1;
    }
    if (!seen.has('other')) fail(`${kind} needs an "other" branch`);
  };

  const argument = () => {
    i += 1; // '{'
    ws();
    const name = token(/[A-Za-z0-9_]+/);
    if (!NAME.test(name)) fail('expected an argument name');
    ws();
    if (message[i] === '}') {
      i += 1;
      record(name, 'simple');
      return;
    }
    if (message[i] !== ',') fail('expected "," or "}"');
    i += 1;
    ws();
    const type = token(/[a-z]+/);
    ws();
    if (FORMAT_TYPES.has(type)) {
      record(name, type as ArgumentType);
      if (message[i] === ',') {
        i += 1;
        const style = token(/[^{}]+/).trim();
        if (style === '') fail('empty style');
      }
      if (message[i] !== '}') fail(`unterminated ${type} argument`);
      i += 1;
      return;
    }
    if (type === 'plural' || type === 'selectordinal' || type === 'select') {
      record(name, type);
      if (message[i] !== ',') fail(`${type} needs branches`);
      i += 1;
      branches(type);
      i += 1; // '}'
      return;
    }
    fail(`unsupported argument type "${type}"`);
  };

  const body = (inPlural: boolean) => {
    for (;;) {
      text(inPlural);
      if (i >= message.length || message[i] === '}') return;
      argument();
    }
  };

  try {
    body(false);
    if (i < message.length) fail('unbalanced "}"');
    return { ok: true, args };
  } catch (error) {
    if (error instanceof IcuSyntaxError) return { ok: false, error: { message: error.message, offset: error.offset }, args };
    throw error;
  }
}
