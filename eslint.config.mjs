import eslintImport from 'eslint-plugin-import';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.cursor/**',
      '.git/**',
      '*.json',
      '*.md',
      'logs/**',
      'eslint.config.js',
      'eslint.config.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: '.',
      },
      globals: {
        node: true,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: eslintImport,
      prettier: eslintPluginPrettier,
    },
    rules: {
      'prettier/prettier': 'error',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'import/order': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'linebreak-style': ['error', 'unix'],
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts', 'vitest.config.ts', 'vitest.setup.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
];
