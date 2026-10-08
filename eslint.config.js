// ESLint flat config (Gate 1). Boundary rules are enforced by dependency-cruiser; ESLint adds
// import hygiene that catches mistakes at edit time, plus a few security-relevant bans.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'docs/**', 'infra/**', '.dependency-cruiser.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@hsp/*/src/*', '@hsp/*/src/**'], message: 'Import packages via their public entry only (B1).' },
          { group: ['**/src/application/**', '**/src/domain/**', '**/src/infrastructure/**'],
            message: 'Module internals are private (B1). Use the module public entry.' },
        ],
      }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'Math.random is not allowed; use crypto.randomInt/randomUUID (security codes, IDs).' },
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is banned (XSS).' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: { '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }] },
  },
);
