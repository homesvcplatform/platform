// Locale enablement gate (founder decisions §9.2, ADR-025 #4). A locale may be enabled for a city only when its UI
// catalog is complete and valid. Production enablement also needs IVR prompt coverage for enabled flows, approved
// notification templates and a native-speaker review: those evidence sources belong to later channels and are not
// built in Gate 4, so outside `local` / `test` the gate refuses (fail closed) until they exist.
import type { CatalogIssue } from './catalogs.ts';
import { isRegisteredLocale } from './registry.ts';

export type EnablementRequirement = 'LOCALE_REGISTERED' | 'UI_CATALOG' | 'IVR_PROMPTS' | 'NOTIFICATION_TEMPLATES' | 'NATIVE_SPEAKER_REVIEW';

/** Required before a locale is enabled in production; recorded here, satisfied by later gates' evidence. */
export const PRODUCTION_REQUIREMENTS: readonly EnablementRequirement[] = ['IVR_PROMPTS', 'NOTIFICATION_TEMPLATES', 'NATIVE_SPEAKER_REVIEW'];

/** Evidence from later channels. Gate 4 has no source for it, so it is normally absent. */
export interface EnablementEvidence {
  readonly ivrPrompts?: boolean;
  readonly notificationTemplates?: boolean;
  readonly nativeSpeakerReview?: boolean;
}

export interface EnablementDecision {
  readonly locale: string;
  readonly allowed: boolean;
  readonly blockers: readonly { readonly requirement: EnablementRequirement; readonly detail: string }[];
  readonly requiredBeforeProduction: readonly EnablementRequirement[];
}

const DEVELOPMENT_ENVS = new Set(['local', 'test']);

export function evaluateLocaleEnablement(input: {
  readonly locale: string;
  readonly appEnv: string;
  /** Issues from `checkCatalogs` over the repository catalogs. */
  readonly catalogIssues: readonly CatalogIssue[];
  readonly evidence?: EnablementEvidence;
}): EnablementDecision {
  const blockers: { requirement: EnablementRequirement; detail: string }[] = [];
  if (!isRegisteredLocale(input.locale)) {
    blockers.push({ requirement: 'LOCALE_REGISTERED', detail: 'locale is not in the registry' });
  } else {
    const own = input.catalogIssues.filter((i) => i.locale === input.locale);
    if (own.length > 0) {
      blockers.push({ requirement: 'UI_CATALOG', detail: `${own.length} catalog issue(s): ${own.slice(0, 5).map((i) => `${i.code}${i.key ? ` ${i.key}` : ''}`).join(', ')}` });
    }
  }
  if (!DEVELOPMENT_ENVS.has(input.appEnv)) {
    const e = input.evidence ?? {};
    if (e.ivrPrompts !== true) blockers.push({ requirement: 'IVR_PROMPTS', detail: 'IVR prompt coverage for enabled flows is not recorded' });
    if (e.notificationTemplates !== true) blockers.push({ requirement: 'NOTIFICATION_TEMPLATES', detail: 'approved notification templates are not recorded' });
    if (e.nativeSpeakerReview !== true) blockers.push({ requirement: 'NATIVE_SPEAKER_REVIEW', detail: 'native-speaker review is not recorded' });
  }
  return { locale: input.locale, allowed: blockers.length === 0, blockers, requiredBeforeProduction: PRODUCTION_REQUIREMENTS };
}
