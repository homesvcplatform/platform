// Locale registry (founder decisions §9.2, ADR-025 #1, #3): which locales exist, the key their content uses in the
// `names` JSON columns, and the fallback chain. Which locales a city offers is data (`geo.cities.supported_locales`).

export const LOCALES = [
  { code: 'en-IN', contentKey: 'en', script: 'Latn', fallback: null, englishName: 'English', nativeName: 'English' },
  { code: 'te-IN', contentKey: 'te', script: 'Telu', fallback: 'en-IN', englishName: 'Telugu', nativeName: 'తెలుగు' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];
export type LocaleDefinition = (typeof LOCALES)[number];

/** UI catalogs are written in this locale first; every other catalog must match its keys and arguments. */
export const SOURCE_LOCALE: LocaleCode = 'en-IN';

export function isRegisteredLocale(code: unknown): code is LocaleCode {
  return typeof code === 'string' && LOCALES.some((l) => l.code === code);
}

export function getLocale(code: LocaleCode): LocaleDefinition {
  const found = LOCALES.find((l) => l.code === code);
  if (!found) throw new Error(`unregistered locale ${code}`);
  return found;
}

/** The locale itself, then its fallbacks (te-IN → en-IN). */
export function fallbackChain(code: LocaleCode): LocaleDefinition[] {
  const chain: LocaleDefinition[] = [];
  let next: LocaleCode | null = code;
  while (next !== null && !chain.some((l) => l.code === next)) {
    const def = getLocale(next);
    chain.push(def);
    next = def.fallback;
  }
  return chain;
}

/**
 * The locale to answer in: the requested one when the city offers it, otherwise the city's primary locale (its first
 * supported locale, X-05), otherwise the source locale.
 */
export function resolveLocale(requested: string | undefined, citySupported: readonly string[] = []): LocaleCode {
  const offered = citySupported.filter(isRegisteredLocale);
  if (requested !== undefined && isRegisteredLocale(requested) && (offered.length === 0 || offered.includes(requested))) return requested;
  return offered[0] ?? SOURCE_LOCALE;
}

/**
 * Picks a display name from a `names` JSON object ({ en: ..., te: ... }) along the fallback chain. `fellBack` is true when
 * the requested locale had no name (callers count it, founder decisions §9.2).
 */
export function localizedName(names: unknown, locale: LocaleCode): { readonly text: string; readonly fellBack: boolean } {
  const map = names !== null && typeof names === 'object' ? (names as Record<string, unknown>) : {};
  for (const [i, def] of fallbackChain(locale).entries()) {
    const value = map[def.contentKey];
    if (typeof value === 'string' && value.trim() !== '') return { text: value, fellBack: i > 0 };
  }
  const any = Object.values(map).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { text: any ?? '', fellBack: true };
}
