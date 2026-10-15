module.exports = {
  root: true,
  env: { node: true, browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: 'detect' },
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  rules: {
    // Destructuring placeholders with a leading underscore are intentional
    // "discard this field" patterns (e.g. stripping id / role from update patches).
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
  },
  ignorePatterns: ['dist', 'build', 'node_modules', 'coverage', '.artifacts', '.data', '.workspaces'],
  overrides: [
    {
      // Backend / node-only files
      files: ['apps/api/**/*.ts', 'workers/**/*.mjs', 'packages/shared-types/**/*.ts'],
      env: { node: true },
    },
    {
      // Frontend + shared libs
      files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
      env: { browser: true },
    },
  ],
};