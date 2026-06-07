import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// Flat config for the whole workspace (apps + packages). Lints source only; config files and
// build output are left alone.
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  // React rules only where React is used. v7's newer compiler-style rules flag intentional
  // idioms here, so we keep just the two classic hooks rules + the fast-refresh export check.
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/react/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Tests + test helpers touch Node/Vitest globals, and mocks legitimately use `any`.
  {
    files: [
      'apps/*/src/**/*.test.{ts,tsx}',
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/test/**',
      'packages/*/src/test-readings.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
