// Expo config plugin: give the generated android/app/build.gradle a real
// release signingConfig.
//
// Background (review H1): Expo's generated build.gradle hardcodes
// `signingConfig signingConfigs.debug` for the release buildType, so every
// Release APK was signed with the public Android debug key. This plugin
// injects a `release` signingConfig that reads the keystore from Gradle
// properties (ORIONTV_RELEASE_*), and points the release buildType at it
// whenever those properties are present.
//
// How the properties get there: the release workflow restores the keystore
// from GitHub Secrets and passes the four properties to Gradle via
// ORG_GRADLE_PROJECT_* environment variables on the build step (see
// docs/release-signing.md). Plain gradle.properties entries work too —
// findProperty reads any project property source. Local builds without the
// properties keep the debug signing via the ternary below, so
// `expo prebuild` still works offline; CI fails the build outright if the
// secrets are missing, so a release can never silently fall back to the
// debug key.
//
// Fail-closed: if the Expo template changes and the anchors below no longer
// match, prebuild throws instead of shipping a debug-signed APK.
const { withAppBuildGradle } = require('@expo/config-plugins');

const RELEASE_SIGNING_CONFIG = `        release {
            // Release keystore, injected by plugins/withReleaseSigning.js.
            // Values come from Gradle properties (CI passes them via
            // ORG_GRADLE_PROJECT_* env; gradle.properties works too).
            storeFile file(findProperty('ORIONTV_RELEASE_STORE_FILE') ?: 'release.keystore')
            storePassword findProperty('ORIONTV_RELEASE_STORE_PASSWORD')
            keyAlias findProperty('ORIONTV_RELEASE_KEY_ALIAS')
            keyPassword findProperty('ORIONTV_RELEASE_KEY_PASSWORD')
        }
`;

// The debug signingConfig block ends the signingConfigs section; the release
// entry goes right after it, before the closing brace.
const DEBUG_BLOCK_ANCHOR = `            keyPassword 'android'
        }
    }`;

// Unique to the release buildType (the debug buildType has no such comment).
const RELEASE_BUILD_TYPE_ANCHOR = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

const RELEASE_BUILD_TYPE_REPLACEMENT = `            // Release signing (plugins/withReleaseSigning.js): use the release
            // keystore when ORIONTV_RELEASE_STORE_FILE is set as a Gradle
            // property (CI passes it via env); otherwise fall back to the
            // debug key. CI fails the build when the signing secrets are missing.
            signingConfig project.hasProperty('ORIONTV_RELEASE_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`;

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    const contents = modConfig.modResults.contents;
    if (contents.includes('ORIONTV_RELEASE_STORE_FILE')) {
      return modConfig;
    }

    if (!contents.includes(DEBUG_BLOCK_ANCHOR)) {
      throw new Error(
        '[withReleaseSigning] could not find the debug signingConfigs block in app/build.gradle; ' +
          'the Expo template may have changed — refusing to guess.'
      );
    }
    let next = contents.replace(
      DEBUG_BLOCK_ANCHOR,
      `            keyPassword 'android'
        }
${RELEASE_SIGNING_CONFIG}    }`
    );

    if (!next.includes(RELEASE_BUILD_TYPE_ANCHOR)) {
      throw new Error(
        '[withReleaseSigning] could not find the release buildType signing line in app/build.gradle; ' +
          'the Expo template may have changed — refusing to guess.'
      );
    }
    next = next.replace(RELEASE_BUILD_TYPE_ANCHOR, RELEASE_BUILD_TYPE_REPLACEMENT);

    modConfig.modResults.contents = next;
    return modConfig;
  });
}

module.exports = withReleaseSigning;
