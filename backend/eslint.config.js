// @ts-check
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'off',
    },
  },
);
