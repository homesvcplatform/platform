// ESLint flat config (Gate 1). Boundary rules are enforced by dependency-cruiser; ESLint adds
// import hygiene that catches mistakes at edit time, plus a few security-relevant bans.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import catalogCodes from './tools/architecture/catalog-codes.json' with { type: 'json' };

const boundaryPatterns = [
  { group: ['@hsp/*/src/*', '@hsp/*/src/**'], message: 'Import packages via their public entry only (B1).' },
  { group: ['**/src/application/**', '**/src/domain/**', '**/src/infrastructure/**'],
    message: 'Module internals are private (B1). Use the module public entry.' },
];

// SR-06: field decryption happens only in the disclosure / reveal paths. The raw field-crypto factory may be imported
// only by the modules listed in the override below (identity: phone reveal for OTP delivery; customers: the address
// snapshot opened for the jobs disclosure service at L2, Gate 5).
const fieldCryptoRestriction = [
  { name: '@hsp/security', importNames: ['createFieldCrypto'], message: 'Field decryption is restricted to disclosure / reveal services (SR-06).' },
];

const baseSyntaxRules = [
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'Math.random is not allowed; use crypto.randomInt/randomUUID (security codes, IDs).' },
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is banned (XSS).' },
];

// Gate 4 (ADR-025 #11): category and service-type codes are catalog data, never string literals in app code.
const codePattern = `/^(${[...catalogCodes.categories, ...catalogCodes.serviceTypes].join('|')})$/`;
const catalogCodeRules = [
  { selector: `Literal[value=${codePattern}]`, message: 'Catalog category / service-type codes are data: read them from the catalog, never hard-code them (ADR-020, ADR-025 #11).' },
  { selector: `TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=${codePattern}]`, message: 'Catalog category / service-type codes are data: read them from the catalog, never hard-code them (ADR-020, ADR-025 #11).' },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'docs/**', 'infra/**', '.dependency-cruiser.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-restricted-imports': ['error', { patterns: boundaryPatterns, paths: fieldCryptoRestriction }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', ...baseSyntaxRules],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/modules/identity/src/**/*.ts', 'packages/modules/customers/src/**/*.ts', '**/__tests__/**', '**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: boundaryPatterns }] },
  },
  {
    files: ['apps/**/*.{ts,tsx,js,mjs}', 'packages/modules/**/*.{ts,tsx}', 'packages/ui-web/**/*.{ts,tsx}', 'packages/ui-native/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...baseSyntaxRules, ...catalogCodeRules] },
  },
  {
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: { '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }] },
  },
);
