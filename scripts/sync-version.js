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
//
// Prerelease versions (1.7.0-beta.1) have NO distinct versionCode under this
// rule: consecutive patches are adjacent integers (1.6.8 -> 10608, 1.6.9 ->
// 10609), so there is no integer strictly between the previous stable and the
// matching stable. versionCodeFor() therefore throws on prerelease input
// instead of silently returning the stable's code (which used to make
// 1.7.0-beta.1 and 1.7.0 both 10700 — Android treats them as the same build
// and the stable release cannot upgrade over the beta). Build metadata
// (+build.5) is still ignored: semver says it does not affect precedence,
// so 1.6.9+build.5 is the same version as 1.6.9 and shares its code.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const APP_JSON = path.join(ROOT, 'app.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) {
    throw new Error(`Invalid semver version: ${JSON.stringify(version)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null,
  };
}

function versionCodeFor(version) {
  const { major, minor, patch, prerelease } = parseVersion(version);
  if (prerelease) {
    throw new Error(
      `Prerelease version ${JSON.stringify(version)} has no distinct versionCode ` +
        `under the major*10000+minor*100+patch rule (see header comment); ` +
        `use a stable version`
    );
  }
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
  // android 键缺失时报“版本漂移”而非 TypeError：直接访问 .android.versionCode
  // 会抛晦涩的 Cannot read properties of undefined
  const actualVersionCode = app.expo.android?.versionCode;
  if (actualVersionCode !== expected.versionCode) {
    problems.push(
      `app.json android.versionCode is ${JSON.stringify(actualVersionCode)}, expected ${expected.versionCode} (from ${expected.version})`
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
  // android 键缺失时补建（否则直接赋值抛 TypeError）
  if (!app.expo.android) app.expo.android = {};
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
