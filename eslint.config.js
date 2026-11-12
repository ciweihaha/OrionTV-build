// https://docs.expo.dev/guides/using-eslint/
// Flat config for ESLint 9 + eslint-config-expo 58.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Node 脚本（scripts/ 与 Expo config plugin）：需要完整的 Node 全局量
    //（__dirname 等）。expo 默认配置只给 metro.config.js 开 Node 环境，
    //其它 .js 文件只有 require/module/process/console。
    files: ['scripts/**/*.js', 'plugins/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // JS 测试文件：jest 全局量（describe/it/expect）。TS 测试不受影响
    //（typescript-eslint 会关掉 no-undef，改由 tsc 检查）。
    files: ['**/*.test.js'],
    languageOptions: {
      globals: globals.jest,
    },
  },
  {
    // React Compiler 规则（eslint-plugin-react-hooks v6）：本项目未启用
    // babel-plugin-react-compiler，构建并不跑编译器。这些规则按“编译器能
    // 优化”的假设检查现有代码，全仓 60+ 处报错多为 TV 端有意的写法——
    // Animated 样式要在 render 里读 ref、effect 里同步 setState、
    // expo-video 的 player.playbackRate 就是设计成直接赋值的。
    // 逐处改的风险大于收益，改掉也只是为了迎合一个没启用的编译器；
    // 等真正启用编译器时再逐项打开。exhaustive-deps 仍保留。
    rules: {
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
]);
