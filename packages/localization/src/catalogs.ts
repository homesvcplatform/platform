// UI message catalogs (ADR-025 #1): one flat JSON file per locale in `packages/localization/catalogs/`, keys in
// dotted lower case, values ICU MessageFormat. Completeness and syntax are checked here and run by CI (unit test).
import { readFileSync } from 'node:fs';
import { checkIcuMessage, type ArgumentType } from './icu.ts';
import { LOCALES, SOURCE_LOCALE, type LocaleCode } from './registry.ts';

export type MessageCatalog = Readonly<Record<string, string>>;
export type CatalogSet = Readonly<Partial<Record<LocaleCode, MessageCatalog>>>;

export type CatalogIssueCode = 'FILE_MISSING' | 'FILE_INVALID' | 'BAD_KEY' | 'NOT_STRING' | 'EMPTY' | 'SYNTAX' | 'MISSING' | 'EXTRA' | 'ARGUMENTS';

export interface CatalogIssue {
  readonly locale: string;
  readonly key: string | null;
  readonly code: CatalogIssueCode;
  readonly detail?: string;
}

const KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export const CATALOG_DIR = new URL('../catalogs/', import.meta.url);

/** Reads every registered locale's catalog file. Unreadable or malformed files are reported, not thrown. */
export function loadRepositoryCatalogs(dir: URL = CATALOG_DIR): { readonly catalogs: CatalogSet; readonly issues: readonly CatalogIssue[] } {
  const catalogs: Partial<Record<LocaleCode, MessageCatalog>> = {};
  const issues: CatalogIssue[] = [];
  for (const { code } of LOCALES) {
    let raw: string;
    try {
      raw = readFileSync(new URL(`${code}.json`, dir), 'utf8');
    } catch {
      issues.push({ locale: code, key: null, code: 'FILE_MISSING' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      issues.push({ locale: code, key: null, code: 'FILE_INVALID', detail: (error as Error).message });
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.push({ locale: code, key: null, code: 'FILE_INVALID', detail: 'expected a flat JSON object' });
      continue;
    }
    catalogs[code] = parsed as MessageCatalog;
  }
  return { catalogs, issues };
}

/**
 * Checks one catalog set against the source locale: every key present and non-empty in every locale, no extra keys,
 * valid ICU syntax, and the same argument names and types as the source message.
 */
export function checkCatalogs(catalogs: CatalogSet): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const source = catalogs[SOURCE_LOCALE] ?? {};
  const sourceArgs = new Map<string, ReadonlyMap<string, ArgumentType>>();
  for (const { code } of LOCALES) {
    const catalog = catalogs[code];
    if (!catalog) {
      issues.push({ locale: code, key: null, code: 'FILE_MISSING' });
      continue;
    }
    for (const [key, value] of Object.entries(catalog)) {
      if (!KEY.test(key)) issues.push({ locale: code, key, code: 'BAD_KEY' });
      if (typeof value !== 'string') {
        issues.push({ locale: code, key, code: 'NOT_STRING' });
        continue;
      }
      if (value.trim() === '') {
        issues.push({ locale: code, key, code: 'EMPTY' });
        continue;
      }
      const parsed = checkIcuMessage(value);
      if (!parsed.ok) {
        issues.push({ locale: code, key, code: 'SYNTAX', detail: `${parsed.error?.message ?? 'invalid'} at ${parsed.error?.offset ?? 0}` });
        continue;
      }
      if (code === SOURCE_LOCALE) sourceArgs.set(key, parsed.args);
      else if (!(key in source)) issues.push({ locale: code, key, code: 'EXTRA' });
    }
  }
  for (const { code } of LOCALES) {
    const catalog = catalogs[code];
    if (!catalog || code === SOURCE_LOCALE) continue;
    for (const key of Object.keys(source)) {
      const value = catalog[key];
      if (value === undefined) {
        issues.push({ locale: code, key, code: 'MISSING' });
        continue;
      }
      const expected = sourceArgs.get(key);
      const parsed = typeof value === 'string' && value.trim() !== '' ? checkIcuMessage(value) : undefined; // empty: reported above
      if (!expected || !parsed?.ok) continue;
      const same = expected.size === parsed.args.size && [...expected].every(([name, type]) => parsed.args.get(name) === type);
      if (!same) {
        issues.push({ locale: code, key, code: 'ARGUMENTS',
          detail: `expected {${[...expected.keys()].join(', ')}}, found {${[...parsed.args.keys()].join(', ')}}` });
      }
    }
  }
  return issues;
}
