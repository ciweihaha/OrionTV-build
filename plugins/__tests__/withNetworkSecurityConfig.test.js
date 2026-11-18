// withNetworkSecurityConfig 单元测试：只测 manifest 变换与配置内容本身
// （不跑 prebuild）。完整的 prebuild 验证：本地跑过，生成的 manifest 与
// res 文件已核对；平板实测海报见发版记录。
const {
  applyNetworkSecurityConfig,
  NETWORK_SECURITY_CONFIG_XML,
  ISRG_ROOTS,
} = require('../withNetworkSecurityConfig');

function makeManifest(appAttrs = {}) {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [
        {
          $: {
            'android:name': '.MainApplication',
            'android:label': '@string/app_name',
            ...appAttrs,
          },
        },
      ],
    },
  };
}

describe('withNetworkSecurityConfig', () => {
  it('给 application 加上 networkSecurityConfig=@xml/network_security_config', () => {
    const out = applyNetworkSecurityConfig(makeManifest());
    expect(out.manifest.application[0].$['android:networkSecurityConfig']).toBe(
      '@xml/network_security_config',
    );
  });

  it('已是目标值时幂等，不抛错', () => {
    const out = applyNetworkSecurityConfig(
      makeManifest({ 'android:networkSecurityConfig': '@xml/network_security_config' }),
    );
    expect(out.manifest.application[0].$['android:networkSecurityConfig']).toBe(
      '@xml/network_security_config',
    );
  });

  it('已被设为别的值时 fail-closed 抛错，不静默覆盖', () => {
    expect(() =>
      applyNetworkSecurityConfig(
        makeManifest({ 'android:networkSecurityConfig': '@xml/other_config' }),
      ),
    ).toThrow(/refusing to override/);
  });

  it('不碰 application 的其他属性', () => {
    const out = applyNetworkSecurityConfig(
      makeManifest({ 'android:usesCleartextTraffic': 'true', 'android:banner': '@drawable/tv_banner' }),
    );
    const attrs = out.manifest.application[0].$;
    expect(attrs['android:usesCleartextTraffic']).toBe('true');
    expect(attrs['android:banner']).toBe('@drawable/tv_banner');
    expect(attrs['android:networkSecurityConfig']).toBe('@xml/network_security_config');
  });

  it('配置信任 system + 两个 ISRG 根，不含 cleartext 与 per-domain 例外', () => {
    expect(NETWORK_SECURITY_CONFIG_XML).toContain('<certificates src="system" />');
    expect(NETWORK_SECURITY_CONFIG_XML).toContain('<certificates src="@raw/isrg_root_x1" />');
    expect(NETWORK_SECURITY_CONFIG_XML).toContain('<certificates src="@raw/isrg_root_x2" />');
    expect(NETWORK_SECURITY_CONFIG_XML).not.toContain('cleartextTrafficPermitted');
    expect(NETWORK_SECURITY_CONFIG_XML).not.toContain('domain-config');
    expect(ISRG_ROOTS).toEqual(['isrg_root_x1', 'isrg_root_x2']);
  });
});
