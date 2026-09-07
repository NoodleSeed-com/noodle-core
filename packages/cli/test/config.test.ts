import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendServer,
  clearConfig,
  configPath,
  maskToken,
  readConfig,
  readServers,
  resolveAuthToken,
  resolveServiceUrl,
  serversPath,
  writeConfig,
} from '../src/index.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-cfg-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('config (Slice B)', () => {
  it('round-trips config; file is 0600, dir is 0700', () => {
    writeConfig({ serviceUrl: 'https://svc', authToken: 'tok-secret' }, home);
    expect(readConfig(home)).toEqual({ serviceUrl: 'https://svc', authToken: 'tok-secret' });
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.noodle')).mode & 0o777).toBe(0o700);
  });

  it('readConfig returns {} when absent or corrupt (never throws)', () => {
    expect(readConfig(home)).toEqual({});
    writeConfig({ serviceUrl: 'https://svc' }, home);
    writeFileSync(configPath(home), '{ not json');
    expect(readConfig(home)).toEqual({});
  });

  it('clearConfig drops the token, keeps the service URL; removes the file when empty', () => {
    writeConfig({ serviceUrl: 'https://svc', authToken: 'tok' }, home);
    clearConfig(home);
    expect(readConfig(home)).toEqual({ serviceUrl: 'https://svc' });

    writeConfig({ authToken: 'tok' }, home);
    clearConfig(home);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it('maskToken never reveals the full token', () => {
    expect(maskToken(undefined)).toBe('(none)');
    expect(maskToken('short')).toBe('********');
    expect(maskToken('abcdefghij')).toBe('abcd…ij');
    expect(maskToken('verylongtoken12345')).not.toContain('longtoken');
  });

  it('resolution precedence: flag > env > config > undefined', () => {
    const cfg = { serviceUrl: 'https://from-config', authToken: 'cfg-tok' };
    expect(resolveServiceUrl('https://flag', { NOODLE_SERVICE_URL: 'https://env' }, cfg)).toBe(
      'https://flag',
    );
    expect(resolveServiceUrl(undefined, { NOODLE_SERVICE_URL: 'https://env' }, cfg)).toBe(
      'https://env',
    );
    expect(resolveServiceUrl(undefined, {}, cfg)).toBe('https://from-config');
    expect(resolveServiceUrl(undefined, {}, {})).toBeUndefined();

    expect(resolveAuthToken('flag', { NOODLE_AUTH_TOKEN: 'env' }, cfg)).toBe('flag');
    expect(resolveAuthToken(undefined, { NOODLE_AUTH_TOKEN: 'env' }, cfg)).toBe('env');
    expect(resolveAuthToken(undefined, {}, cfg)).toBe('cfg-tok');
    expect(resolveAuthToken(undefined, {}, {})).toBeUndefined();
  });

  it('servers cache: append + read in order; file is 0600', () => {
    appendServer({ deploymentId: 'a-1', url: 'https://svc/o/acme/a/mcp', createdAt: 't1' }, home);
    appendServer({ deploymentId: 'b-2', url: 'https://svc/o/acme/b/mcp', createdAt: 't2' }, home);
    const list = readServers(home);
    expect(list.map((s) => s.deploymentId)).toEqual(['a-1', 'b-2']);
    expect(statSync(serversPath(home)).mode & 0o777).toBe(0o600);
    expect(readServers(mkdtempSync(join(tmpdir(), 'empty-')))).toEqual([]);
  });
});
