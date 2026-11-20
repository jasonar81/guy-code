// @vitest-environment node
/**
 * A2A settings and network checks (electron/a2a/config.ts): defaults are
 * safe (off, not bound to 0.0.0.0), the CIDR matcher fails closed, and the
 * bind address is picked from inside the allow-list.
 */
import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  ipInCidrs,
  normaliseRemoteAddress,
  parseCidr,
  readA2AConfig,
  resolveAdvertiseHost,
  resolveBindAddress,
  DEFAULT_PORT,
} from '../../electron/a2a/config';

describe('readA2AConfig', () => {
  it('defaults: off, port 7427, auto bind, 10.0.0.0/8', () => {
    const c = readA2AConfig(() => null);
    expect(c.enabled).toBe(false);
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.bind).toBe('');
    expect(c.allowCidrs).toEqual(['10.0.0.0/8']);
    expect(c.insecureHttp).toBe(false);
    expect(c.paused).toBe(false);
  });
  it('parses settings and drops invalid CIDRs and ports', () => {
    const s: Record<string, string> = {
      'a2a.enabled': '1',
      'a2a.port': '99999',
      'a2a.allowCidrs': '10.30.0.0/16, garbage, 192.168.1.0/33 ,172.16.0.0/12',
    };
    const c = readA2AConfig((k) => s[k] ?? null);
    expect(c.enabled).toBe(true);
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.allowCidrs).toEqual(['10.30.0.0/16', '172.16.0.0/12']);
  });
});

describe('ipInCidrs', () => {
  it('matches inside the range and not outside', () => {
    expect(ipInCidrs('10.30.1.23', ['10.0.0.0/8'])).toBe(true);
    expect(ipInCidrs('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    expect(ipInCidrs('192.168.5.9', ['192.168.4.0/23'])).toBe(true);
    expect(ipInCidrs('192.168.6.1', ['192.168.4.0/23'])).toBe(false);
  });
  it('handles /0, /32 and bare addresses', () => {
    expect(ipInCidrs('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
    expect(ipInCidrs('127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(ipInCidrs('127.0.0.2', ['127.0.0.1'])).toBe(false);
  });
  it('folds IPv4-mapped IPv6 (dual-stack sockets)', () => {
    expect(normaliseRemoteAddress('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(ipInCidrs('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });
  it('IPv6 ranges', () => {
    expect(ipInCidrs('fd00::1', ['fd00::/8'])).toBe(true);
    expect(ipInCidrs('::1', ['::1/128'])).toBe(true);
    expect(ipInCidrs('fe80::1', ['fd00::/8'])).toBe(false);
    expect(ipInCidrs('10.0.0.1', ['fd00::/8'])).toBe(false); // family mismatch never matches
  });
  it('fails closed on junk', () => {
    expect(ipInCidrs('', ['0.0.0.0/0'])).toBe(false);
    expect(ipInCidrs('not-an-ip', ['0.0.0.0/0'])).toBe(false);
    expect(ipInCidrs('10.0.0.1', [])).toBe(false);
    expect(parseCidr('10.0.0.0/40')).toBeNull();
  });
});

describe('resolveBindAddress', () => {
  const iface = (address: string, internal = false): NetworkInterfaceInfo =>
    ({ address, family: 'IPv4', internal, netmask: '255.0.0.0', mac: '', cidr: null }) as NetworkInterfaceInfo;
  const ifaces = { lo: [iface('127.0.0.1', true)], wifi: [iface('192.168.1.20')], vpn: [iface('10.30.1.23')] };

  it('an explicit bind wins', () => {
    expect(resolveBindAddress({ bind: '0.0.0.0', allowCidrs: ['10.0.0.0/8'] }, ifaces)).toBe('0.0.0.0');
  });
  it('auto picks the interface inside the allow-list (the VPN), never a wildcard', () => {
    expect(resolveBindAddress({ bind: '', allowCidrs: ['10.0.0.0/8'] }, ifaces)).toBe('10.30.1.23');
  });
  it('falls back to loopback, not 0.0.0.0, when nothing matches', () => {
    expect(resolveBindAddress({ bind: '', allowCidrs: ['172.16.0.0/12'] }, ifaces)).toBe('127.0.0.1');
  });
  it('a wildcard bind advertises a dialable address', () => {
    expect(resolveAdvertiseHost('10.30.1.23', { allowCidrs: [] })).toBe('10.30.1.23');
    const adv = resolveAdvertiseHost('0.0.0.0', { allowCidrs: ['0.0.0.0/0'] });
    expect(adv).not.toBe('0.0.0.0');
    expect(adv).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
