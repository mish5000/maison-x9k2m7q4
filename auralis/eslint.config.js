import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Beyond the usual correctness rules, two project-specific restrictions are
 * enforced here because they encode security invariants that are easy to
 * violate by accident:
 *
 *  - outbound HTTP may only be built inside `packages/core/src/net`
 *  - `eval` and dynamic Function construction are never permitted
 *
 * The matching hook in `.claude/hooks/network-guard.sh` catches the same
 * mistake earlier, at edit time.
 */

const NETWORK_RESTRICTIONS = [
  {
    selector: "CallExpression[callee.name='fetch']",
    message:
      'Use the safe fetch from @auralis/core (createSafeFetch) — raw fetch bypasses SSRF protection.',
  },
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
    message: 'Use the safe fetch from @auralis/core (createSafeFetch).',
  },
  {
    selector: "ImportDeclaration[source.value='axios']",
    message: 'Auralis does not use axios; all egress goes through createSafeFetch.',
  },
  {
    selector: "ImportDeclaration[source.value='node-fetch']",
    message: 'Auralis does not use node-fetch; all egress goes through createSafeFetch.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-restricted-syntax': ['error', ...NETWORK_RESTRICTIONS],
    },
  },

  {
    // The egress layer is the one place permitted to build raw requests.
    files: ['packages/core/src/net/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The browser client talks only to this application's own API, through
      // a single module; the SSRF rule does not apply to it.
      'no-restricted-syntax': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['**/tests/**/*.ts', '**/e2e/**/*.ts', '**/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
);
