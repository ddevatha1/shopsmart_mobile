// https://docs.expo.dev/guides/using-eslint/
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    // backend/ is its own independent project (separate package.json,
    // tsconfig, and toolchain) — not part of the Expo app's lint scope.
    ignores: ['dist/*', 'backend/*'],
  },
  {
    // react-hooks/immutability (part of the newer React-Compiler-oriented
    // eslint-plugin-react-hooks rules) doesn't yet understand Reanimated's
    // `sharedValue.value = ...` mutation pattern — that mutation is the
    // library's documented, intentional API (UI-thread animation values,
    // not React state), not a bug. Disabled project-wide since this app
    // uses Reanimated throughout; still relying on TypeScript + the rest
    // of the hooks rules to catch real mistakes.
    rules: {
      'react-hooks/immutability': 'off',
    },
  },
];
