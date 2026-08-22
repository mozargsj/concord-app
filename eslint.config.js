import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      ...reactHooks.configs['recommended-latest'].plugins
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs['recommended-latest'].rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // TS itself catches undefined identifiers; no-undef can't see ambient
      // lib.dom.d.ts types (e.g. `as MediaStreamConstraints`) and false-positives.
      'no-undef': 'off'
    }
  },
  {
    files: [
      'packages/server/**/*.ts',
      'packages/shared/**/*.ts',
      'packages/client/src/main/**/*.ts',
      'packages/client/src/preload/**/*.ts'
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['packages/client/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    ignores: ['**/dist/**', '**/out/**', '**/build/**', '**/node_modules/**']
  },
  prettierConfig
];
