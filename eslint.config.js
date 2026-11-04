import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,

  // ブラウザで動くアプリ本体 (ES モジュール)
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser }
    }
  },

  // 実行時設定 (HTML から <script> で読み込まれる classic script)
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser } }
  },

  // ビルド設定・テスト・スクリプト (Node)
  {
    files: ['vite.config.js', 'fix-paths.js', 'eslint.config.js', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, window: 'writable' }
    }
  },

  {
    rules: {
      // 先頭が _ の引数/変数は「意図的に未使用」として許可する
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  }
];
