// Expo config plugin: build one APK per ABI plus the universal APK.
//
// Background: the universal APK ships native libraries for every ABI
// (arm64-v8a + armeabi-v7a + x86 + x86_64: Hermes, Reanimated, Media3,
// expo-image/Coil, …). Every real Android TV — including this project's
// Honor X1 (Honghu 818, ARM) — is arm64-v8a or armeabi-v7a, so a
// per-ABI APK drops most of the native payload for the device that
// actually installs it (baseline universal APK: 114,996,620 bytes,
// v1.7.0 release asset).
//
//   splits.abi.include: arm64-v8a + armeabi-v7a only. x86/x86_64 exist
//   only on emulators; the universal APK below still covers them.
//   universalApk true: `assembleRelease` still produces the usual
//   app-release.apk at the usual path, so the release workflow
//   (build-apk.yml) keeps working unchanged — it uploads the universal
//   APK. The test workflow (build-test-12.yml) additionally uploads
//   the per-ABI APKs so their sizes are visible in CI.
//   No per-ABI versionCode override: these APKs are sideloaded, not
//   served by Play multi-APK delivery, and all variants share the
//   versionCode from app.json (10700), so a per-ABI build upgrades
//   cleanly over a universal one and vice versa (same signature).
//
// Fail-closed: if the Expo template changes and the anchor below no
// longer matches, prebuild throws instead of silently shipping a
// universal-only build. Re-running on already-patched contents is a
// no-op (the marker comment identifies this plugin's block).
const { withAppBuildGradle } = require('@expo/config-plugins');

const SPLITS_BLOCK = `    splits {
        abi {
            // Per-ABI APKs, injected by plugins/withApkSplits.js.
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a'
            universalApk true
        }
    }
`;

// Unique to the app module's build.gradle: the buildTypes block lives
// directly inside `android { }`, so inserting before it puts the splits
// block inside `android { }` too.
const BUILD_TYPES_ANCHOR = '    buildTypes {';

const MARKER = "injected by plugins/withApkSplits.js";

function applyApkSplits(contents) {
  if (contents.includes(MARKER)) {
    return contents;
  }
  if (contents.includes('    splits {')) {
    throw new Error(
      '[withApkSplits] app/build.gradle already contains a splits block ' +
        'from another source — refusing to add a second one.'
    );
  }
  if (!contents.includes(BUILD_TYPES_ANCHOR)) {
    throw new Error(
      '[withApkSplits] could not find the buildTypes block in app/build.gradle; ' +
        'the Expo template may have changed — refusing to guess.'
    );
  }
  return contents.replace(BUILD_TYPES_ANCHOR, `${SPLITS_BLOCK}${BUILD_TYPES_ANCHOR}`);
}

function withApkSplits(config) {
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = applyApkSplits(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withApkSplits;
// Exported for unit tests.
module.exports.applyApkSplits = applyApkSplits;
