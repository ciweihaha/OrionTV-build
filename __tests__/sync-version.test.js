const { versionCodeFor, parseVersion } = require('../scripts/sync-version');

describe('versionCodeFor', () => {
  it('derives 10608 from 1.6.8', () => {
    expect(versionCodeFor('1.6.8')).toBe(10608);
  });

  it('handles major bumps and two-digit components', () => {
    expect(versionCodeFor('2.0.0')).toBe(20000);
    expect(versionCodeFor('1.10.3')).toBe(11003);
  });

  it('ignores prerelease/build suffixes', () => {
    expect(versionCodeFor('1.6.9-beta.1')).toBe(10609);
    expect(versionCodeFor('1.6.9+build.5')).toBe(10609);
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
    expect(parseVersion('1.6.8')).toEqual({ major: 1, minor: 6, patch: 8 });
  });
});
