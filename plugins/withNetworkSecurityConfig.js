// Expo config plugin: trust Let's Encrypt roots on old Android.
//
// Background: poster images for most CMS sources live on small CDNs
// (p.lzp261118.com, image.jinyingimage.com, image.huyajs.com, ...)
// whose TLS certificates are issued by Let's Encrypt. Let's Encrypt
// chains to ISRG Root X1, which only entered the Android system trust
// store in 7.1.1 — Android 7.0 (the Huawei MediaPad M3 test tablet,
// API 24) does not trust it, so expo-image/Coil fails the TLS handshake
// and every non-Baidu poster stays black (Baidu's gimg0 uses GlobalSign,
// which Android 7.0 does trust — that's why only Baidu posters loaded).
// Verified 2026-11-18 on the tablet: movie posters (Let's Encrypt) all
// dark after 60 s+, TV/anime Baidu posters load in ~12 s; the same image
// URLs return 200 through the tablet's proxy path, and TLS 1.2 works for
// both hosts — the only difference is the issuing CA.
//
// Fix: bundle the two public ISRG roots (X1 RSA, X2 ECDSA) as raw
// resources and add them to the network security config alongside the
// system anchors. This is exactly what newer Android already trusts, so
// it does not weaken security — it only backports the same public roots
// to old devices. It applies to every HTTPS connection the app makes
// (expo-image/Coil and React Native fetch both use the platform trust
// manager), so any future Let's Encrypt API/poster host works too.
//
// The certs live in plugins/certs/ (downloaded from letsencrypt.org;
// X1 SHA-256 fingerprint 96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:
// CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6, valid to 2035; X2
// 69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:
// F1:50:7E:34:45:3C:CB:14:70, valid to 2040). The plugin copies them into
// res/raw/ at prebuild time; no download happens during the build.
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config>
    <trust-anchors>
      <certificates src="system" />
      <certificates src="@raw/isrg_root_x1" />
      <certificates src="@raw/isrg_root_x2" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

const ISRG_ROOTS = ['isrg_root_x1', 'isrg_root_x2'];

function applyNetworkSecurityConfig(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  // Fail-closed: if the attribute is already set to something else, don't
  // silently override — surface it instead of shipping a broken manifest.
  const existing = app.$['android:networkSecurityConfig'];
  if (existing !== undefined && existing !== '@xml/network_security_config') {
    throw new Error(
      `withNetworkSecurityConfig: refusing to override existing android:networkSecurityConfig="${existing}"`,
    );
  }
  app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
  return manifest;
}

const withNetworkSecurityConfig = (config) => {
  config = withAndroidManifest(config, (config) => {
    config.modResults = applyNetworkSecurityConfig(config.modResults);
    return config;
  });
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;
      const xmlDir = path.join(projectRoot, 'app', 'src', 'main', 'res', 'xml');
      const rawDir = path.join(projectRoot, 'app', 'src', 'main', 'res', 'raw');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(rawDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG_XML,
      );
      for (const name of ISRG_ROOTS) {
        fs.copyFileSync(
          path.join(__dirname, 'certs', `${name}.pem`),
          path.join(rawDir, `${name}.pem`),
        );
      }
      return config;
    },
  ]);
  return config;
};

module.exports = withNetworkSecurityConfig;
module.exports.applyNetworkSecurityConfig = applyNetworkSecurityConfig;
module.exports.NETWORK_SECURITY_CONFIG_XML = NETWORK_SECURITY_CONFIG_XML;
module.exports.ISRG_ROOTS = ISRG_ROOTS;
