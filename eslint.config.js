const { FlatCompat } = require('@eslint/eslintrc');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const reactPlugin = require('eslint-plugin-react');
const headersPlugin = require('eslint-plugin-headers');

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

module.exports = [
  {
    ignores: ['**/*.d.ts', 'src/test/**/*.ts', 'demos/**/*', '**/*.js', 'testWorkspace/**'],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  ...compat.extends('plugin:react/recommended', 'plugin:@typescript-eslint/recommended'),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2018,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      headers: headersPlugin,
    },
    settings: {
      react: {
        pragma: 'h',
        version: '16.3',
      },
    },
    rules: {
      // Temporary until CDP is moved out, which is where most violations are:
      '@typescript-eslint/ban-types': 'off',

      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'prefer-const': ['error', { destructuring: 'all' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Current repository headers use a legacy style that would require mass edits to older files.
      'headers/header-format': 'off',
      'react/no-unescaped-entities': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
