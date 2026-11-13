// Expo config plugin: apply OrionTV's AndroidManifest customizations
// incrementally on top of the manifest Expo generates.
//
// Background (review H-1): the build used to wholesale-overwrite the
// generated manifest with xml/AndroidManifest.xml (package.json
// `copy-config`, run by `prebuild`). That discarded everything Expo and
// the SDK plugins inject:
//   - expo-video's ExpoVideoPlaybackService + FOREGROUND_SERVICE /
//     FOREGROUND_SERVICE_MEDIA_PLAYBACK permissions + supportsPictureInPicture
//     (background playback broken; Android 14+ may throw SecurityException
//     on startForeground without the permission)
//   - expo-secure-store's backup rules (once its plugin is registered)
//   - any future plugin injection
// This plugin replaces the overwrite: it mutates only the bits Expo
// doesn't already handle, so plugin injections survive.
//
// What Expo/plugins already cover (verified by running prebuild 2026-11-12):
//   - INTERNET / ACCESS_NETWORK_STATE permissions (app.json)
//   - touchscreen/faketouch/leanback features + LEANBACK_LAUNCHER + banner
//     (@react-native-tvos/config-tv)
//   - queries intent for https links (expo-linking)
//   - deep-link oriontv scheme (app.json intentFilters + scheme)
//   - expo-video playback WITHOUT background service / PiP: app.json sets
//     supportsBackgroundPlayback + supportsPictureInPicture to false, so
//     no ExpoVideoPlaybackService, foreground-service permissions, or PiP
//     activity config are injected; playback pauses on background (see
//     the AppState listeners in app/play.tsx and components/LivePlayer.tsx).
//   - expo-updates meta-data (Expo)
// What this plugin adds (Expo doesn't handle it):
//   - android:usesCleartextTraffic="true": app.json's usesCleartextTraffic
//     is ignored by the installed @expo/config-plugins (verified: no
//     handling in the package, generated manifest lacks the attribute).
//     IPTV streams are plain HTTP, so cleartext must be on; this plugin
//     is the only enforcement. Keep the app.json field too — it documents
//     the intent and a future Expo may honor it.
//   - REQUEST_INSTALL_PACKAGES lives in app.json's permissions array,
//     which Expo does honor (no plugin action needed).
//
// Dropped from the old xml manifest (verified unused, review L-1):
//   RECORD_AUDIO, SYSTEM_ALERT_WINDOW, READ/WRITE_EXTERNAL_STORAGE,
//   VIBRATE, MODIFY_AUDIO_SETTINGS, DOWNLOAD_WITHOUT_NOTIFICATION,
//   com.oriontv deep-link scheme (no code references it),
//   DevSettingsActivity (debug-only; Expo adds it in dev builds).
//   WAKE_LOCK is dropped from app.json too (expo-keep-awake uses window
//   flags, no WakeLock anywhere in the code).
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

function applyOrionManifest(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  // Fail-closed: if the attribute is already set to something else, don't
  // silently override — surface it instead of shipping a broken manifest.
  const existing = app.$['android:usesCleartextTraffic'];
  if (existing !== undefined && existing !== 'true') {
    throw new Error(
      `withOrionManifest: android:usesCleartextTraffic is already '${existing}', refusing to override`,
    );
  }
  app.$['android:usesCleartextTraffic'] = 'true';
  return manifest;
}

module.exports = function withOrionManifest(config) {
  return withAndroidManifest(config, config => {
    config.modResults = applyOrionManifest(config.modResults);
    return config;
  });
};
// Exported for unit tests.
module.exports.applyOrionManifest = applyOrionManifest;
