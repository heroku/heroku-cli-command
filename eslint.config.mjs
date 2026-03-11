import oclif from 'eslint-config-oclif'

export default [
  ...oclif,
  {
    ignores: [
      './lib',
      '**/*.js',
      'workflows-repo/**',
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
      '@stylistic/function-paren-newline': 'warn',
      '@stylistic/indent': 'warn',
      '@stylistic/lines-between-class-members': 'warn',
      '@stylistic/object-curly-spacing': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      camelcase: 'off',
      'import/namespace': 'warn',
      'mocha/max-top-level-suites': 'warn',
      'mocha/no-mocha-arrows': 'warn',
      'n/no-deprecated-api': 'warn',
      'n/shebang': 'warn',
      'node/no-missing-import': 'off',
      'perfectionist/sort-classes': 'warn',
      'perfectionist/sort-imports': 'warn',
      'perfectionist/sort-intersection-types': 'warn',
      'perfectionist/sort-named-imports': 'warn',
      'perfectionist/sort-objects': 'warn',
      'prefer-arrow-callback': 'warn',
      'unicorn/consistent-destructuring': 'warn',
      'unicorn/consistent-function-scoping': 'warn',
      'unicorn/import-style': 'warn',
      'unicorn/no-array-for-each': 'off',
      'unicorn/no-array-push-push': 'warn',
      'unicorn/no-static-only-class': 'warn',
      'unicorn/no-useless-undefined': 'warn',
      'unicorn/numeric-separators-style': 'warn',
      'unicorn/prefer-node-protocol': 'warn',
      'unicorn/prefer-number-properties': 'warn',
      'unicorn/prefer-string-replace-all': 'warn',
      'unicorn/prefer-top-level-await': 'warn',
    },
  },
]
