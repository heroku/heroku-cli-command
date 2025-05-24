module.exports = {
  env: {
    mocha: true,
  },
  extends: [
    'oclif',
    'oclif-typescript',
  ],
  overrides: [
    {
      files: ['test/**/*.ts', 'test/**/*.js'],
      rules: {
        'prefer-arrow-callback': 'off',
        'unicorn/consistent-destructuring': 'warn',
      },
    },
    {
      files: ['examples/**/*.ts', 'examples/**/*.js'],
      rules: {
        'unicorn/prefer-module': 'off',
        'unicorn/prefer-top-level-await': 'off',
      },
    },
  ],
  plugins: ['import'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    camelcase: 'off',
    'import/namespace': 'warn',
    indent: ['error', 2, {MemberExpression: 1}],
    'no-useless-constructor': 'warn',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/import-style': 'warn',
    'unicorn/no-array-for-each': 'off',
    'unicorn/no-array-push-push': 'warn',
    'unicorn/no-static-only-class': 'off',
    'unicorn/numeric-separators-style': 'off',
    'unicorn/prefer-array-some': 'warn',
    'unicorn/prefer-node-protocol': 'warn',
    'unicorn/prefer-string-replace-all': 'off',
  },
}
