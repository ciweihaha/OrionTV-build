// https://docs.expo.dev/guides/using-eslint/
// Flat config for ESLint 9 + eslint-config-expo 58.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
]);
