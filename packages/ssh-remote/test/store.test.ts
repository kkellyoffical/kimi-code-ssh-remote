import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SshRemoteError } from '../src/errors';
import { resolveKimiHome } from '../src/profile';
import { ConnectionStore } from '../src/store';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-store-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe('ConnectionStore', () => {
  it('starts empty when no file exists', async () => {
    const store = new ConnectionStore(makeHome());
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('adds, lists, and gets profiles with the default port applied', async () => {
    const store = new ConnectionStore(makeHome());
    const added = await store.add({
      name: 'devbox',
      host: 'dev.example.com',
      user: 'alice',
      identityFile: '~/.ssh/id_ed25519',
    });
    expect(added).toEqual({
      name: 'devbox',
      host: 'dev.example.com',
      user: 'alice',
      port: 22,
      identityFile: '~/.ssh/id_ed25519',
    });
    await expect(store.get('devbox')).resolves.toEqual(added);
    await expect(store.list()).resolves.toEqual([added]);
  });

  it('persists profiles across store instances', async () => {
    const home = makeHome();
    await new ConnectionStore(home).add({ name: 'a', host: 'a.example.com', port: 2222 });
    const reopened = new ConnectionStore(home);
    await expect(reopened.get('a')).resolves.toMatchObject({ host: 'a.example.com', port: 2222 });
  });

  it('rejects a duplicate connection name', async () => {
    const store = new ConnectionStore(makeHome());
    await store.add({ name: 'devbox', host: 'one.example.com' });
    const error = await store.add({ name: 'devbox', host: 'two.example.com' }).catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).kind).toBe('config');
  });

  it('rejects invalid profiles', async () => {
    const store = new ConnectionStore(makeHome());
    await expect(store.add({ name: 'bad name!', host: 'x.example.com' })).rejects.toThrow(
      SshRemoteError,
    );
    await expect(store.add({ name: 'ok', host: 'x.example.com', port: 0 })).rejects.toThrow(
      SshRemoteError,
    );
    await expect(store.add({ name: 'ok', host: '' })).rejects.toThrow(SshRemoteError);
  });

  it('removes profiles and reports whether one existed', async () => {
    const store = new ConnectionStore(makeHome());
    await store.add({ name: 'devbox', host: 'dev.example.com' });
    await expect(store.remove('devbox')).resolves.toBe(true);
    await expect(store.remove('devbox')).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('writes the connections file with private permissions', async () => {
    const home = makeHome();
    const store = new ConnectionStore(home);
    await store.add({ name: 'devbox', host: 'dev.example.com' });
    const mode = statSync(store.filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('fails with a config error when the file is corrupt', async () => {
    const home = makeHome();
    const store = new ConnectionStore(home);
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(store.filePath, '{not json', 'utf8');
    const error = await store.list().catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).kind).toBe('config');
  });
});

describe('resolveKimiHome', () => {
  it('honors KIMI_CODE_HOME and falls back to ~/.kimi-code', () => {
    expect(resolveKimiHome({ KIMI_CODE_HOME: '/tmp/kimi-home' })).toBe('/tmp/kimi-home');
    expect(resolveKimiHome({})).toBe(join(homedir(), '.kimi-code'));
  });
});
