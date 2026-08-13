// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

/**
 * Architecture rules from CLAUDE.md, enforced mechanically.
 * A rule that is only written down gets broken. A rule that fails CI does not.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/build/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    rules: {
      // ── CLAUDE.md §3.1 — money is never a float ──────────────────
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Math.random is not acceptable for codes, ids or money. Use crypto.randomInt.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat has no place near money. Use Money.fromMajor from @provia/core/money.',
        },
        {
          selector: "BinaryExpression[operator='==='][left.name='service']",
          message:
            'Do not branch on service id in spine code (CLAUDE.md §2). ' +
            'Push the difference into the service module instead.',
        },
      ],

      // ── CLAUDE.md §5 — module boundaries ─────────────────────────
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages',
              from: './apps',
              message: 'packages/* must never import from apps/* (CLAUDE.md §5).',
            },
          ],
        },
      ],

      // ── general strictness ───────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },

  // ── Service modules may not import each other (CLAUDE.md §5) ────
  {
    files: ['packages/core/src/services/*.ts'],
    ignores: ['packages/core/src/services/registry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*', '!../money', '!../*'],
              message:
                'A service module may not import another service module (CLAUDE.md §5). ' +
                'Shared behaviour belongs in the spine.',
            },
          ],
        },
      ],
    },
  },
);
