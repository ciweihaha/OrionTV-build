// Expo config plugin: build one APK per native ABI (+ a universal APK).
//
// Background: the release APK ships native .so files (Hermes, React Native
// core, Reanimated, expo-video/Media3, …) for every ABI the NDK build
// produces, so each download carries code its device can never run. ABI
// splits make `assembleRelease` emit one APK per ABI, each containing only
// that ABI's .so files, plus — because universalApk stays on — one
// universal APK with all ABIs.
//
// universalApk stays true on purpose: the in-app updater downloads a
// single fixed URL (orionTV.<version>.apk, see constants/UpdateConfig.ts)
// with no reliable way to detect the device ABI from JS, so that URL must
// keep pointing at an APK that installs everywhere. The per-ABI APKs are
// for manual installs from the Release page. If the updater ever becomes
// ABI-aware, flip universalApk to false and the universal APK goes away.
//
// Fail-closed: if the Expo template changes and the anchor below no longer
// matches exactly once, prebuild throws instead of shipping an unsplit APK.
//
// Note: no per-split versionCode override — splits only matter for Play
// Store uploads, and releases here are distributed as direct APK downloads.
const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = 'ABI splits injected by plugins/withAbiSplits.js';

const SPLITS_BLOCK = `    // ${MARKER}: one APK per ABI so each download ships
    // only the native libraries its device can run. universalApk stays on
    // for the in-app updater's single fixed download URL (see header).
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a'
            universalApk true
        }
    }
`;

const DEFAULT_CONFIG_ANCHOR = '\n    defaultConfig {';

function applyAbiSplits(contents) {
  if (contents.includes(MARKER)) {
    return contents;
  }
  const occurrences = contents.split(DEFAULT_CONFIG_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      '[withAbiSplits] expected exactly one `defaultConfig {` block in app/build.gradle, found ' +
        occurrences +
        '; the Expo template may have changed — refusing to guess.'
    );
  }
  return contents.replace(DEFAULT_CONFIG_ANCHOR, '\n' + SPLITS_BLOCK + '    defaultConfig {');
}

function withAbiSplits(config) {
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = applyAbiSplits(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withAbiSplits;
// Exported for unit tests.
module.exports.applyAbiSplits = applyAbiSplits;
