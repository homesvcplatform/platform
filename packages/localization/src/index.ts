// @hsp/localization: locale registry, ICU catalogs and the locale enablement gate (Gate 4, ADR-025 #1–#4).
export {
  fallbackChain, getLocale, isRegisteredLocale, LOCALES, localizedName, resolveLocale, SOURCE_LOCALE,
} from './registry.ts';
export type { LocaleCode, LocaleDefinition } from './registry.ts';
export { checkIcuMessage } from './icu.ts';
export type { ArgumentType, IcuResult } from './icu.ts';
export { CATALOG_DIR, checkCatalogs, loadRepositoryCatalogs } from './catalogs.ts';
export type { CatalogIssue, CatalogIssueCode, CatalogSet, MessageCatalog } from './catalogs.ts';
export { evaluateLocaleEnablement, PRODUCTION_REQUIREMENTS } from './enablement.ts';
export type { EnablementDecision, EnablementEvidence, EnablementRequirement } from './enablement.ts';
