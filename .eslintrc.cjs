module.exports = {
  parser: '@typescript-eslint/parser', // Specifies the ESLint parser
  plugins: ['@typescript-eslint'],
  extends: [
    'plugin:@typescript-eslint/recommended', // Uses the recommended rules from the @typescript-eslint/eslint-plugin
    'plugin:@typescript-eslint/recommended-type-checked',
  ],
  parserOptions: {
    project: './tsconfig.json',
    ecmaVersion: 2018, // Allows for the parsing of modern ECMAScript features
    sourceType: 'module', // Allows for the use of imports
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    // Keep the existing type-aware debt visible without making the first
    // working lint run fail on thousands of pre-existing violations.
    '@typescript-eslint/no-floating-promises': 'warn',
    '@typescript-eslint/no-misused-promises': 'warn',
    '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    '@typescript-eslint/require-await': 'warn',
    '@typescript-eslint/restrict-template-expressions': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-non-null-assertion': 'off',
    'prefer-const': 'warn',
  },
  overrides: [
    {
      // `engine/` is the simulation, and it has to produce the same run twice.
      //
      // Two separate bans, for two separate reasons. The identifiers are replay divergences: a
      // bare clock or an unseeded draw reached from simulation code cannot be reproduced, and the
      // failure does not show up as a red test -- it shows up months later as a run that will not
      // reproduce (docs/10 §4.2). The imports are host coupling: the whole point of the module is
      // that it runs unchanged in a Convex action, in a browser tab, and in a Node replay
      // harness, which stops being true the moment one file reaches for a `ctx` (docs/11 §4.1).
      //
      // `convex/values` stays allowed on purpose. It is used as a type builder and never parses
      // anything at runtime, so it costs nothing until we swap it out.
      //
      // When `prototype/` merges into the engine (docs/11 §9 F1), it lands under this rule and
      // `MemoryWorld`'s `clock = Date.now` / `random = Math.random` constructor defaults have to
      // go. That is the intended way for this to be enforced, rather than a second rule there.
      files: ['engine/**/*.ts'],
      excludedFiles: ['engine/**/*.test.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
            message:
              'Simulation code may not read a wall clock. Time arrives as the `now` argument; see engine/runtime.ts.',
          },
          {
            selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
            message:
              'Simulation code may not draw from Math.random. Use `game.rng` (engine/util/rng.ts), whose state lives in the world document.',
          },
          {
            selector:
              "CallExpression[callee.object.name='performance'][callee.property.name='now']",
            message:
              'Simulation code may not read a wall clock. Time arrives as the `now` argument; see engine/runtime.ts.',
          },
          {
            selector:
              "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
            message: 'Use `game.rng.uuid()`, which is replayable.',
          },
        ],
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'convex/server',
                message:
                  'The engine has no runtime host. Anything needing `ctx` belongs in a driver under convex/ (or server/ after docs/11 §5).',
              },
            ],
            patterns: [
              {
                group: ['**/_generated/**'],
                message:
                  'The engine has no runtime host. Anything needing the generated Convex API belongs in a driver.',
              },
              {
                group: [
                  './convex/**',
                  '../convex/**',
                  '../../convex/**',
                  './src/**',
                  '../src/**',
                  '../../src/**',
                  './server/**',
                  '../server/**',
                  '../../server/**',
                  './prototype/**',
                  '../prototype/**',
                  '../../prototype/**',
                ],
                message:
                  'The engine may not import its hosts. Dependencies point inward: convex/, src/ and server/ import engine/, never the other way round.',
              },
            ],
          },
        ],
      },
    },
  ],
};
