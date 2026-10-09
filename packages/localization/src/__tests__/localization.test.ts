// Gate 4: locale registry, ICU syntax, catalog completeness (run by CI over the repository catalogs) and the locale
// enablement gate (ADR-025 #1–#4).
import { describe, expect, it } from 'vitest';
import {
  checkCatalogs, checkIcuMessage, evaluateLocaleEnablement, fallbackChain, loadRepositoryCatalogs, localizedName, resolveLocale,
} from '../index.ts';

describe('repository catalogs (CI translation check)', () => {
  it('every registered locale has a complete, valid catalog with the source arguments', () => {
    const { catalogs, issues } = loadRepositoryCatalogs();
    expect(issues).toEqual([]);
    expect(checkCatalogs(catalogs)).toEqual([]);
    expect(Object.keys(catalogs['te-IN'] ?? {}).length).toBeGreaterThan(0);
  });
});

describe('catalog check', () => {
  const en = { 'a.b': 'Hello {name}', 'a.c': '{n, plural, one {# item} other {# items}}' };

  it('reports missing, extra, empty, bad-key, syntax and argument problems', () => {
    const issues = checkCatalogs({
      'en-IN': { ...en, 'Bad Key': 'x', 'a.e': 'ok' },
      'te-IN': { 'a.b': 'నమస్తే {nam}', 'a.d': 'extra', 'a.c': '', 'a.e': '{broken' },
    });
    const codes = issues.map((i) => `${i.locale}:${i.key}:${i.code}`).sort();
    expect(codes).toEqual([
      'en-IN:Bad Key:BAD_KEY',
      'te-IN:Bad Key:MISSING',
      'te-IN:a.b:ARGUMENTS',
      'te-IN:a.c:EMPTY',
      'te-IN:a.d:EXTRA',
      'te-IN:a.e:SYNTAX',
    ]);
  });

  it('a missing locale file blocks', () => {
    expect(checkCatalogs({ 'en-IN': en })).toEqual([{ locale: 'te-IN', key: null, code: 'FILE_MISSING' }]);
  });

  it('a malformed file is reported, not thrown', () => {
    const dir = new URL('./fixtures/broken-catalogs/', import.meta.url);
    const { issues } = loadRepositoryCatalogs(dir);
    expect(issues.map((i) => `${i.locale}:${i.code}`).sort()).toEqual(['en-IN:FILE_INVALID', 'te-IN:FILE_MISSING']);
  });
});

describe('ICU syntax', () => {
  it.each([
    'plain text',
    'Hello {name}!',
    'Paid {amount, number, ::currency/INR}',
    'On {when, date, medium} at {when, date, short}',
    '{count, plural, offset:1 =0 {nobody} one {# person} other {# people}}',
    '{g, select, female {she} male {he} other {they}}',
    "It''s '{literal}' text",
    '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}',
    '{a, plural, one {{b} and #} other {{c, select, x {X} other {Y}}}}',
  ])('accepts %s', (m) => expect(checkIcuMessage(m).ok).toBe(true));

  it.each([
    ['unbalanced {', 'Hello {name'],
    ['unbalanced }', 'Hello }'],
    ['no other branch', '{n, plural, one {x}}'],
    ['unknown plural keyword', '{n, plural, lots {x} other {y}}'],
    ['duplicate selector', '{g, select, a {x} a {y} other {z}}'],
    ['unsupported type', '{n, spellout}'],
    ['empty name', '{ }'],
    ['unterminated quote', "a '{ b"],
    ['two types for one argument', '{n} {n, number}'],
  ])('rejects %s', (_label, m) => expect(checkIcuMessage(m).ok).toBe(false));

  it('collects argument names and types', () => {
    expect([...checkIcuMessage('{a} {b, number} {c, plural, other {{d}}}').args]).toEqual([
      ['a', 'simple'], ['b', 'number'], ['c', 'plural'], ['d', 'simple'],
    ]);
  });
});

describe('registry', () => {
  it('te-IN falls back to en-IN', () => {
    expect(fallbackChain('te-IN').map((l) => l.code)).toEqual(['te-IN', 'en-IN']);
  });

  it('resolves the requested locale only when the city offers it, else the city primary locale (X-05)', () => {
    expect(resolveLocale('en-IN', ['te-IN', 'en-IN'])).toBe('en-IN');
    expect(resolveLocale('hi-IN', ['te-IN', 'en-IN'])).toBe('te-IN');
    expect(resolveLocale(undefined, ['te-IN', 'en-IN'])).toBe('te-IN');
    expect(resolveLocale('en-IN', ['te-IN'])).toBe('te-IN');
    expect(resolveLocale('te-IN')).toBe('te-IN');
    expect(resolveLocale(undefined)).toBe('en-IN');
  });

  it('picks a name along the fallback chain and says when it fell back', () => {
    expect(localizedName({ en: 'Geyser', te: 'గీజర్' }, 'te-IN')).toEqual({ text: 'గీజర్', fellBack: false });
    expect(localizedName({ en: 'Replace MCB' }, 'te-IN')).toEqual({ text: 'Replace MCB', fellBack: true });
    expect(localizedName({ en: 'Geyser' }, 'en-IN')).toEqual({ text: 'Geyser', fellBack: false });
    expect(localizedName(null, 'en-IN')).toEqual({ text: '', fellBack: true });
  });
});

describe('locale enablement gate', () => {
  it('local / test: allowed when the UI catalog is complete; production requirements are still listed', () => {
    const d = evaluateLocaleEnablement({ locale: 'te-IN', appEnv: 'test', catalogIssues: [] });
    expect(d.allowed).toBe(true);
    expect(d.requiredBeforeProduction).toEqual(['IVR_PROMPTS', 'NOTIFICATION_TEMPLATES', 'NATIVE_SPEAKER_REVIEW']);
  });

  it('a missing translation blocks enablement', () => {
    const d = evaluateLocaleEnablement({ locale: 'te-IN', appEnv: 'test', catalogIssues: [{ locale: 'te-IN', key: 'geo.serviceable', code: 'MISSING' }] });
    expect(d.allowed).toBe(false);
    expect(d.blockers.map((b) => b.requirement)).toEqual(['UI_CATALOG']);
  });

  it('another locale\'s catalog issue does not block this one', () => {
    expect(evaluateLocaleEnablement({ locale: 'en-IN', appEnv: 'test', catalogIssues: [{ locale: 'te-IN', key: 'x.y', code: 'MISSING' }] }).allowed).toBe(true);
  });

  it('an unregistered locale is refused', () => {
    expect(evaluateLocaleEnablement({ locale: 'hi-IN', appEnv: 'test', catalogIssues: [] }).blockers.map((b) => b.requirement)).toEqual(['LOCALE_REGISTERED']);
  });

  it('outside local / test it fails closed until IVR, template and native-review evidence exist', () => {
    for (const appEnv of ['dev', 'staging', 'prod']) {
      const d = evaluateLocaleEnablement({ locale: 'te-IN', appEnv, catalogIssues: [] });
      expect(d.allowed).toBe(false);
      expect(d.blockers.map((b) => b.requirement)).toEqual(['IVR_PROMPTS', 'NOTIFICATION_TEMPLATES', 'NATIVE_SPEAKER_REVIEW']);
    }
    expect(evaluateLocaleEnablement({ locale: 'te-IN', appEnv: 'prod', catalogIssues: [],
      evidence: { ivrPrompts: true, notificationTemplates: true, nativeSpeakerReview: true } }).allowed).toBe(true);
  });
});
