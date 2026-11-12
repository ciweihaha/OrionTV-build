const { versionCodeFor, parseVersion } = require('../scripts/sync-version');

describe('versionCodeFor', () => {
  it('derives 10608 from 1.6.8', () => {
    expect(versionCodeFor('1.6.8')).toBe(10608);
  });

  it('handles major bumps and two-digit components', () => {
    expect(versionCodeFor('2.0.0')).toBe(20000);
    expect(versionCodeFor('1.10.3')).toBe(11003);
  });

  it('ignores build metadata suffixes (semver: no precedence effect)', () => {
    expect(versionCodeFor('1.6.9+build.5')).toBe(10609);
  });

  it('refuses prerelease versions (no distinct code under the rule)', () => {
    // 旧行为静默返回稳定版的 code：1.7.0-beta.1 与 1.7.0 都是 10700，
    // Android 视同一次构建，正式版无法覆盖升级 beta
    expect(() => versionCodeFor('1.6.9-beta.1')).toThrow(/Prerelease version/);
    expect(() => versionCodeFor('1.7.0-rc.1+build.2')).toThrow(/Prerelease version/);
  });

  it('is monotonic across patch and minor bumps', () => {
    expect(versionCodeFor('1.6.9')).toBeGreaterThan(versionCodeFor('1.6.8'));
    expect(versionCodeFor('1.7.0')).toBeGreaterThan(versionCodeFor('1.6.99'));
    expect(versionCodeFor('2.0.0')).toBeGreaterThan(versionCodeFor('1.99.99'));
  });

  it('rejects non-semver input', () => {
    expect(() => versionCodeFor('1.6')).toThrow(/Invalid semver/);
    expect(() => versionCodeFor('v1.6.8')).toThrow(/Invalid semver/);
    expect(() => versionCodeFor('')).toThrow(/Invalid semver/);
  });
});

describe('parseVersion', () => {
  it('splits a plain semver version', () => {
    expect(parseVersion('1.6.8')).toEqual({ major: 1, minor: 6, patch: 8, prerelease: null, build: null });
  });

  it('captures prerelease and build parts separately', () => {
    expect(parseVersion('1.7.0-beta.1+build.2')).toEqual({
      major: 1, minor: 7, patch: 0, prerelease: 'beta.1', build: 'build.2',
    });
  });
});
