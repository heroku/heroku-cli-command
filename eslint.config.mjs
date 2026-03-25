import herokuEslintConfig from '@heroku-cli/test-utils/eslint-config'

export default [
  ...herokuEslintConfig,
  {
    ignores: [
      './dist',
      './lib',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  {
    files: [
      '**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          modules: true,
        },
        ecmaVersion: 6,
        sourceType: 'module',
      },
    },
    rules: {
      'camelcase': 'off',
      'jsdoc/require-returns-check': 'off',
      'mocha/max-top-level-suites': 'warn',
      'n/no-deprecated-api': 'warn',
      'unicorn/consistent-function-scoping': 'warn',
      'unicorn/no-array-for-each': 'warn',
      'unicorn/no-array-push-push': 'warn',
      'unicorn/no-static-only-class': 'warn',
      'unicorn/prefer-top-level-await': 'warn'
    },
  },
]
