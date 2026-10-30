const syntaxRules = [
  'constructor-super',
  'for-direction',
  'getter-return',
  'no-async-promise-executor',
  'no-case-declarations',
  'no-class-assign',
  'no-const-assign',
  'no-constant-binary-expression',
  'no-dupe-args',
  'no-dupe-class-members',
  'no-dupe-else-if',
  'no-dupe-keys',
  'no-duplicate-case',
  'no-ex-assign',
  'no-fallthrough',
  'no-func-assign',
  'no-import-assign',
  'no-irregular-whitespace',
  'no-loss-of-precision',
  'no-obj-calls',
  'no-promise-executor-return',
  'no-prototype-builtins',
  'no-sparse-arrays',
  'no-template-curly-in-string',
  'no-unexpected-multiline',
  'no-unreachable',
  'no-unsafe-finally',
  'no-unsafe-negation',
  'no-unsafe-optional-chaining',
  'no-useless-backreference',
  'require-yield',
  'use-isnan',
  'valid-typeof'
].reduce((rules, rule) => {
  rules[rule] = 'error';
  return rules;
}, {});

module.exports = [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'vendor/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**'
    ]
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: syntaxRules
  }
];
