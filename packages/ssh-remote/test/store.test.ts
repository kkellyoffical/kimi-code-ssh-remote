import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SshRemoteError } from '../src/errors';
import { resolveKimiHome } from '../src/profile';
import { SecretsStore } from '../src/secrets';
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

  it('rejects hosts and users starting with a dash (ssh option injection)', async () => {
    const store = new ConnectionStore(makeHome());
    await expect(store.add({ name: 'evil', host: '-oProxyCommand=evil' })).rejects.toThrow(
      SshRemoteError,
    );
    await expect(
      store.add({ name: 'evil2', host: 'dev.example.com', user: '-oProxyCommand=evil' }),
    ).rejects.toThrow(SshRemoteError);
    await expect(
      store.add({ name: 'ok', host: 'dev.example.com', user: 'alice' }),
    ).resolves.toMatchObject({ host: 'dev.example.com', user: 'alice' });
  });

  it('serializes concurrent writes', async () => {
    const store = new ConnectionStore(makeHome());
    await Promise.all([
      store.add({ name: 'a', host: 'a.example.com' }),
      store.add({ name: 'b', host: 'b.example.com' }),
      store.add({ name: 'c', host: 'c.example.com' }),
      store.add({ name: 'd', host: 'd.example.com' }),
    ]);
    const names = (await store.list()).map((profile) => profile.name).toSorted();
    expect(names).toEqual(['a', 'b', 'c', 'd']);
    await store.add({ name: 'x', host: 'x.example.com' });
    await Promise.all([store.add({ name: 'y', host: 'y.example.com' }), store.remove('x')]);
    await expect(store.list()).resolves.toHaveLength(5);
    await expect(store.get('x')).resolves.toBeUndefined();
    await expect(store.get('y')).resolves.toBeDefined();
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

describe('SecretsStore', () => {
  it('starts empty when no file exists', async () => {
    const store = new SecretsStore(makeHome());
    await expect(store.hasPassword('devbox')).resolves.toBe(false);
    await expect(store.getPassword('devbox')).resolves.toBeUndefined();
    await expect(store.removePassword('devbox')).resolves.toBe(false);
  });

  it('sets, gets, checks, and removes passwords', async () => {
    const store = new SecretsStore(makeHome());
    await store.setPassword('devbox', 's3cret');
    await expect(store.hasPassword('devbox')).resolves.toBe(true);
    await expect(store.getPassword('devbox')).resolves.toBe('s3cret');
    await store.setPassword('devbox', 'n3w-s3cret');
    await expect(store.getPassword('devbox')).resolves.toBe('n3w-s3cret');
    await expect(store.removePassword('devbox')).resolves.toBe(true);
    await expect(store.hasPassword('devbox')).resolves.toBe(false);
    await expect(store.removePassword('devbox')).resolves.toBe(false);
  });

  it('persists passwords across store instances', async () => {
    const home = makeHome();
    await new SecretsStore(home).setPassword('devbox', 's3cret');
    await expect(new SecretsStore(home).getPassword('devbox')).resolves.toBe('s3cret');
  });

  it('keeps passwords of other connections when removing one', async () => {
    const store = new SecretsStore(makeHome());
    await store.setPassword('one', 'pw-one');
    await store.setPassword('two', 'pw-two');
    await store.removePassword('one');
    await expect(store.getPassword('two')).resolves.toBe('pw-two');
  });

  it('writes the secrets file with private permissions', async () => {
    const home = makeHome();
    const store = new SecretsStore(home);
    await store.setPassword('devbox', 's3cret');
    const mode = statSync(store.filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects empty names and passwords', async () => {
    const store = new SecretsStore(makeHome());
    await expect(store.setPassword('', 's3cret')).rejects.toThrow(SshRemoteError);
    await expect(store.setPassword('devbox', '')).rejects.toThrow(SshRemoteError);
  });

  it('fails with a config error when the file is corrupt', async () => {
    const home = makeHome();
    const store = new SecretsStore(home);
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(store.filePath, '{not json', 'utf8');
    const error: unknown = await store.getPassword('devbox').catch((error) => error);
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
