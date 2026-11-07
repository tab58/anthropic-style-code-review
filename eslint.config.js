// Module-boundary guard only: import directory modules through their index.js, never their internals.
// Tests are excluded on purpose (they may test a module's internal files directly).
import tseslint from 'typescript-eslint'

const MODULES = ['review', 'workflow', 'pi-reviewer']

export default tseslint.config({ ignores: ['eval/cases/**'] }, {
  files: ['src/**/*.ts', 'eval/**/*.ts', 'local/**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: MODULES.flatMap((m) => [`**/${m}/*`, `!**/${m}/index.js`]),
            message: 'Import this module through its index.js; its other files are internal.',
          },
        ],
      },
    ],
  },
})
