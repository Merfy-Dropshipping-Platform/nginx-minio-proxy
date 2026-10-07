// @ts-check
import js from '@eslint/js';

// Правила кода этапа (storefront-shell/RULES.md, раздел 3) — линтером: вложенность не глубже двух уровней, без
// вложенных тернарников, без console, функция — до 30 строк. Комментарии-отключения не действуют: noInlineConfig.
// njs — не Node: в njs/ из глобальных есть только ngx и njs.
export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'max-depth': ['error', 2],
      'no-nested-ternary': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['njs/**/*.js'],
    languageOptions: { globals: { ngx: 'readonly', njs: 'readonly' } },
    rules: { 'max-lines-per-function': ['error', { max: 30, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['test/**/*.js', 'test/**/*.mjs', 'probe/**/*.mjs', 'vitest.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
];
