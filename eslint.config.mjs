import herokuEslintConfig from '@heroku-cli/test-utils/eslint-config'

export default [
  ...herokuEslintConfig,
  {
    ignores: [
      './dist',
      './lib',
      '**/*.js',
      '**/*.mjs',
      // Not part of the compiled project (tsconfig excludes deprecated and does
      // not include examples), so the type-aware parser cannot resolve them.
      'examples/**',
      'src/deprecated/**',
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
    // The upgrade to eslint-config-oclif v7 made several directives in the
    // existing code redundant. Leave them in place (and don't let `--fix`
    // strip them) until the deferred cleanup below is tackled.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'camelcase': 'off',
      'jsdoc/require-returns-check': 'off',
      'mocha/max-top-level-suites': 'warn',
      'n/no-deprecated-api': 'warn',
      'unicorn/consistent-function-scoping': 'warn',
      'unicorn/no-array-push-push': 'warn',
      'unicorn/no-static-only-class': 'warn',
      'unicorn/prefer-top-level-await': 'warn',
      // Rules newly surfaced by the eslint-config-oclif v6 -> v7 upgrade that
      // currently fail across the existing code base. They are turned OFF (not
      // 'warn') on purpose: `eslint --fix` rewrites warn-level violations too,
      // and several of these fixers are semantic (e.g. unicorn/prefer-https
      // rewrites http:// test fixtures), so leaving them enabled corrupts code.
      // Re-enable these one at a time in a dedicated lint-cleanup pass.
      '@eslint-community/eslint-comments/require-description': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-loop-func': 'off',
      '@typescript-eslint/no-restricted-types': 'off',
      '@typescript-eslint/no-shadow': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/strict-void-return': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      'import-x/no-anonymous-default-export': 'off',
      'import-x/no-cycle': 'off',
      'n/prefer-global/buffer': 'off',
      'n/prefer-global/url': 'off',
      'preserve-caught-error': 'off',
      'require-unicode-regexp': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/consistent-class-member-order': 'off',
      'unicorn/import-style': 'off',
      'unicorn/max-nested-calls': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/no-break-in-nested-loop': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      'unicorn/no-unsafe-string-replacement': 'off',
      'unicorn/prefer-https': 'off',
      'unicorn/prefer-private-class-fields': 'off',
      'unicorn/prefer-then-catch': 'off',
    },
  },
]
