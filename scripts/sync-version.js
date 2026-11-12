// Version bookkeeping for OrionTV (review M1).
//
// Single source of truth: package.json `version`. app.json carries the same
// version (Expo takes the APK's versionName from it) plus
// expo.android.versionCode, and both must stay in sync — they drifted once
// already (app.json stuck at 1.6.1 while package.json moved to 1.6.8, and
// versionCode was never set, so every APK reported versionCode 1).
//
//   node scripts/sync-version.js check   fail (exit 1) if app.json disagrees
//                                        with package.json (CI gate)
//   node scripts/sync-version.js sync    rewrite app.json from package.json
//                                        (release workflow safety net; the
//                                        change stays in the runner, uncommitted)
//
// versionCode rule: major * 10000 + minor * 100 + patch (1.6.8 -> 10608).
// Monotonic for semver; leaves room for 99 minor/patch bumps per major.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const APP_JSON = path.join(ROOT, 'app.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`Invalid semver version: ${JSON.stringify(version)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function versionCodeFor(version) {
  const { major, minor, patch } = parseVersion(version);
  return major * 10000 + minor * 100 + patch;
}

function expectedAppJson(pkg) {
  return {
    version: pkg.version,
    versionCode: versionCodeFor(pkg.version),
  };
}

function check() {
  const pkg = readJson(PACKAGE_JSON);
  const app = readJson(APP_JSON);
  const expected = expectedAppJson(pkg);
  const problems = [];
  if (app.expo.version !== expected.version) {
    problems.push(
      `app.json version is ${JSON.stringify(app.expo.version)}, package.json says ${JSON.stringify(expected.version)}`
    );
  }
  if (app.expo.android.versionCode !== expected.versionCode) {
    problems.push(
      `app.json android.versionCode is ${JSON.stringify(app.expo.android.versionCode)}, expected ${expected.versionCode} (from ${expected.version})`
    );
  }
  if (problems.length > 0) {
    throw new Error(
      'Version drift detected:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nRun `node scripts/sync-version.js sync` and commit the result.'
    );
  }
  console.log(
    `versions in sync: ${expected.version} (versionCode ${expected.versionCode})`
  );
}

function sync() {
  const pkg = readJson(PACKAGE_JSON);
  const app = readJson(APP_JSON);
  const expected = expectedAppJson(pkg);
  app.expo.version = expected.version;
  app.expo.android.versionCode = expected.versionCode;
  fs.writeFileSync(APP_JSON, `${JSON.stringify(app, null, 2)}\n`);
  console.log(
    `app.json synced to ${expected.version} (versionCode ${expected.versionCode})`
  );
}

function main(argv) {
  const mode = argv[2];
  if (mode === 'check') {
    check();
  } else if (mode === 'sync') {
    sync();
  } else {
    console.error('Usage: node scripts/sync-version.js <check|sync>');
    process.exit(2);
  }
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { versionCodeFor, parseVersion, expectedAppJson };
