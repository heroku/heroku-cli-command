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
      // Rules surfaced by the eslint-config-oclif v6 -> v7 upgrade that we have
      // deliberately left OFF after re-enabling the rest of the newly-surfaced
      // set one rule at a time. They are 'off' (not 'warn') on purpose: `eslint
      // --fix` rewrites warn-level violations too, so a 'warn' here still lets a
      // semantic fixer corrupt code. Each is kept off for one of these reasons:
      //
      //   Behavior-changing fixers (auto-fix would alter runtime semantics):
      //     prefer-nullish-coalescing (|| vs ?? differ on '' / 0 / false),
      //     require-unicode-regexp (adding the u flag changes matching),
      //     unicorn/prefer-then-catch (.then(f,g) and .then(f).catch(g) catch
      //       different errors), unicorn/prefer-https (rewrites the http:// test
      //       fixtures that must stay http:// — this was the original burn).
      //
      //   Type-unsafety family: the five no-unsafe-* rules flag genuine `any`
      //     flow from untyped API payloads; silencing them needs real typing
      //     work and is its own dedicated pass, not a mechanical cleanup.
      //
      //   Structural / API / high-churn, no behavior benefit:
      //     import-x/no-cycle (real module cycles; breaking them is a refactor),
      //     consistent-type-assertions ('never' mode conflicts with the mock
      //       Config / HTTP<T> structural casts in tests), n/prefer-global/buffer,
      //     unicorn/consistent-class-member-order,
      //     unicorn/prefer-private-class-fields (_x -> #x changes visibility and
      //       breaks the reflective _-member access used in tests).
      //
      //   Identifier-rename clusters (ripple across call sites / public API):
      //     no-shadow, unicorn/consistent-boolean-name,
      //     unicorn/no-non-function-verb-prefix.
      //
      //   Intentional patterns: no-empty-function (empty stubs/noops in tests),
      //     no-restricted-types (needs type replacements, low value).
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-restricted-types': 'off',
      '@typescript-eslint/no-shadow': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'import-x/no-cycle': 'off',
      'n/prefer-global/buffer': 'off',
      'require-unicode-regexp': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/consistent-class-member-order': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      'unicorn/prefer-https': 'off',
      'unicorn/prefer-private-class-fields': 'off',
      'unicorn/prefer-then-catch': 'off',
    },
  },
]
