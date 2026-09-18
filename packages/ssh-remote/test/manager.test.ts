import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SshRemoteError, isNeedsPasswordError } from '../src/errors';
import { knownHostsTarget, parseHostKeyScan } from '../src/hostkeys';
import { createSshConnectionManager } from '../src/manager';
import { SecretsStore } from '../src/secrets';

import { FakeProcessRunner } from './fake-runner';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-mgr-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function scriptHealthyRemote(runner: FakeProcessRunner): void {
  runner.onRun(/uname -s && uname -m/, () => ({
    code: 0,
    stdout: 'Linux\nx86_64\n',
    stderr: '',
  }));
  runner.onRun(/command -v kimi/, () => ({
    code: 0,
    stdout: '/home/alice/.kimi-code\n/usr/bin/kimi\n',
    stderr: '',
  }));
  runner.onRun(/curl -sf/, () => ({ code: 0, stdout: '', stderr: '' }));
  runner.onRun(/server\.token/, () => ({ code: 0, stdout: 'tok-1\n', stderr: '' }));
}

function makeManager(
  runner: FakeProcessRunner,
  port = 49160,
  sleep?: (ms: number) => Promise<void>,
  tunnelOverrides: Record<string, unknown> = {},
  homeDir?: string,
  reconnectWaitTimeoutMs?: number,
) {
  let nextPort = port;
  return createSshConnectionManager({
    homeDir: homeDir ?? makeHome(),
    runner,
    reconnectWaitTimeoutMs,
    tunnel: {
      pickFreePort: async () => nextPort++,
      probeLocalPort: async () => true,
      sleep: sleep ?? (async () => {}),
      reconnectBaseDelayMs: 1,
      ...tunnelOverrides,
    },
    bootstrap: { sleep: async () => {}, pollIntervalMs: 1 },
  });
}

const AUTH_FAILURE = {
  code: 255,
  stdout: '',
  stderr: 'alice@dev.example.com: Permission denied (publickey,password).',
};

function scriptPasswordRemote(runner: FakeProcessRunner): void {
  scriptHealthyRemote(runner);
  runner.onRun(/ true$/, (argv) =>
    argv.includes('BatchMode=yes') ? AUTH_FAILURE : { code: 0, stdout: '', stderr: '' },
  );
}

const exitRuns = (runner: FakeProcessRunner) =>
  runner.runs.filter((run) => run.argv.includes('-O') && run.argv.includes('exit'));

describe('SshConnectionManager', () => {
  it('registers, lists, and removes connections with runtime status', async () => {
    const runner = new FakeProcessRunner();
    const manager = makeManager(runner);
    await expect(manager.list()).resolves.toEqual([]);
    const added = await manager.add({
      name: 'devbox',
      host: 'dev.example.com',
      user: 'alice',
      port: 2222,
    });
    expect(added).toMatchObject({
      name: 'devbox',
      host: 'dev.example.com',
      port: 2222,
      status: { state: 'off' },
    });
    await expect(manager.list()).resolves.toHaveLength(1);
    expect(manager.status('devbox')).toEqual({ state: 'off' });
    expect(manager.status('unknown')).toEqual({ state: 'off' });
    await manager.remove('devbox');
    await expect(manager.list()).resolves.toEqual([]);
    await expect(manager.remove('devbox')).rejects.toThrow(SshRemoteError);
  });

  it('connects and returns a handle with localOrigin and remoteToken', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const handle = await manager.connect('devbox');
    expect(handle).toEqual({
      localOrigin: 'http://127.0.0.1:49160',
      remoteToken: 'tok-1',
    });
    expect(manager.status('devbox')).toEqual({
      state: 'on',
      localOrigin: 'http://127.0.0.1:49160',
      error: undefined,
    });
    const [info] = await manager.list();
    expect(info?.status.state).toBe('on');
    const second = await manager.connect('devbox');
    expect(second).toBe(handle);
    expect(runner.spawns).toHaveLength(1);
    await manager.close();
  });

  it('shares one in-flight connect between concurrent callers', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const [a, b] = await Promise.all([manager.connect('devbox'), manager.connect('devbox')]);
    expect(a).toEqual(b);
    expect(runner.spawns).toHaveLength(1);
    await manager.close();
  });

  it('reports error state and tears down the master when connect fails', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = {
      code: 255,
      stdout: '',
      stderr: 'alice@dev.example.com: Permission denied (publickey).',
    };
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await expect(manager.connect('devbox')).rejects.toThrow(/Permission denied/);
    const status = manager.status('devbox');
    expect(status.state).toBe('error');
    expect(status.error).toContain('Permission denied');
    expect(exitRuns(runner)).toHaveLength(1);
    await manager.close();
  });

  it('disconnects the tunnel and master, and stays off', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    await manager.disconnect('devbox');
    expect(runner.spawns[0]?.killed).toBe(true);
    expect(exitRuns(runner)).toHaveLength(1);
    expect(manager.status('devbox')).toEqual({ state: 'off' });
    await manager.disconnect('devbox');
    expect(exitRuns(runner)).toHaveLength(1);
    await manager.close();
  });

  it('tracks a dropped tunnel through reconnecting back to on', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    let releaseBackoff: (() => void) | undefined;
    const gatedSleep = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        releaseBackoff = resolve;
      });
    };
    const manager = makeManager(runner, 49160, gatedSleep);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    runner.spawns[0]?.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(manager.status('devbox').state).toBe('connecting');
    });
    releaseBackoff?.();
    await vi.waitFor(() => {
      expect(manager.status('devbox').state).toBe('on');
    });
    expect(runner.spawns).toHaveLength(2);
    await manager.close();
  });

  it('waits for an in-progress tunnel reconnect and reuses the handle', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    let releaseBackoff: (() => void) | undefined;
    const gatedSleep = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        releaseBackoff = resolve;
      });
    };
    const manager = makeManager(runner, 49160, gatedSleep);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const handle = await manager.connect('devbox');
    runner.spawns[0]?.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(manager.status('devbox')).toMatchObject({ state: 'connecting', reconnecting: true });
    });
    const bootstrapRuns = () =>
      runner.runs.filter((run) => (run.argv.at(-1) ?? '').includes('uname -s')).length;
    const runsBefore = bootstrapRuns();
    const first = manager.connect('devbox');
    const second = manager.connect('devbox');
    const settled = await Promise.race([
      first.then(() => 'settled'),
      new Promise((resolve) => setTimeout(resolve, 20)).then(() => 'waiting'),
    ]);
    expect(settled).toBe('waiting');
    expect(bootstrapRuns()).toBe(runsBefore);
    expect(runner.spawns).toHaveLength(1);
    releaseBackoff?.();
    await expect(first).resolves.toBe(handle);
    await expect(second).resolves.toBe(handle);
    expect(manager.status('devbox').state).toBe('on');
    expect(manager.status('devbox').reconnecting).toBeUndefined();
    expect(runner.spawns).toHaveLength(2);
    await manager.close();
  });

  it('times out waiting for reconnect, stops the old tunnel, and establishes a fresh one', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const backoffResolvers: Array<() => void> = [];
    const gatedSleep = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        backoffResolvers.push(resolve);
      });
    };
    const manager = makeManager(runner, 49160, gatedSleep, {}, undefined, 10);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    runner.spawns[0]?.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(manager.status('devbox').state).toBe('connecting');
    });
    const handle = await manager.connect('devbox');
    expect(handle.localOrigin).toBe('http://127.0.0.1:49161');
    expect(manager.status('devbox').state).toBe('on');
    expect(runner.spawns).toHaveLength(2);
    expect(exitRuns(runner)).toHaveLength(1);
    for (const release of backoffResolvers) release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.spawns).toHaveLength(2);
    await manager.close();
  });

  it('falls back to a fresh establish and reports error when the tunnel reconnect fails', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    let probing = true;
    let releaseBackoff: (() => void) | undefined;
    const gatedSleep = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        releaseBackoff = resolve;
      });
    };
    const manager = makeManager(runner, 49160, gatedSleep, {
      probeLocalPort: async () => probing,
      readyTimeoutMs: 0,
      maxReconnectAttempts: 1,
    });
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    probing = false;
    runner.spawns[0]?.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(manager.status('devbox').state).toBe('connecting');
    });
    const pending = manager.connect('devbox');
    releaseBackoff?.();
    await expect(pending).rejects.toThrow(SshRemoteError);
    const status = manager.status('devbox');
    expect(status.state).toBe('error');
    expect(status.error).toBeDefined();
    expect(status.reconnecting).toBeUndefined();
    probing = true;
    const handle = await manager.connect('devbox');
    expect(handle.localOrigin).toBeDefined();
    expect(manager.status('devbox').state).toBe('on');
    await manager.close();
  });

  it('tests a connection read-only: handshake plus remote probe, no changes', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const result = await manager.test('devbox');
    expect(result).toEqual({
      ok: true,
      platform: 'linux-x64',
      kimiPath: '/usr/bin/kimi',
      serverRunning: true,
    });
    const remoteCommands = runner.runs.map((run) => run.argv.at(-1) ?? '');
    expect(remoteCommands.some((cmd) => cmd.includes('nohup'))).toBe(false);
    expect(remoteCommands.some((cmd) => cmd.includes('server.token'))).toBe(false);
    expect(runner.runs.some((run) => run.argv[0] === 'scp')).toBe(false);
    expect(exitRuns(runner)).toHaveLength(1);
    expect(manager.status('devbox')).toEqual({ state: 'off' });
  });

  it('returns a failed test result instead of throwing on ssh errors', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = {
      code: 255,
      stdout: '',
      stderr: 'ssh: Could not resolve hostname dev.example.com',
    };
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const result = await manager.test('devbox');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not resolve hostname');
  });

  it('keeps the shared master alive when testing an active connection', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    const result = await manager.test('devbox');
    expect(result.ok).toBe(true);
    expect(exitRuns(runner)).toHaveLength(0);
    expect(manager.status('devbox').state).toBe('on');
    await manager.close();
  });

  it('close() releases every tunnel and master, and is idempotent', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'one', host: 'one.example.com', user: 'alice' });
    await manager.add({ name: 'two', host: 'two.example.com', user: 'alice' });
    await manager.connect('one');
    await manager.connect('two');
    expect(runner.spawns).toHaveLength(2);
    await manager.close();
    expect(runner.spawns.every((spawn) => spawn.killed)).toBe(true);
    expect(exitRuns(runner)).toHaveLength(2);
    expect(manager.status('one')).toEqual({ state: 'off' });
    expect(manager.status('two')).toEqual({ state: 'off' });
    await manager.close();
    await expect(manager.connect('one')).rejects.toThrow(/closed/);
  });

  it('clears localOrigin when the tunnel fails permanently', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    let probing = true;
    const manager = makeManager(runner, 49160, undefined, {
      probeLocalPort: async () => probing,
      readyTimeoutMs: 0,
      maxReconnectAttempts: 1,
    });
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    expect(manager.status('devbox').localOrigin).toBeDefined();
    probing = false;
    runner.spawns[0]?.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(manager.status('devbox').state).toBe('error');
    });
    expect(manager.status('devbox').localOrigin).toBeUndefined();
    expect(manager.status('devbox').error).toBeDefined();
    await manager.close();
  });

  it('removing an active connection disconnects it first', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    await manager.remove('devbox');
    expect(runner.spawns[0]?.killed).toBe(true);
    expect(exitRuns(runner)).toHaveLength(1);
    await expect(manager.list()).resolves.toEqual([]);
    await manager.close();
  });

  it('connects with a provided password via askpass and keeps it out of argv', async () => {
    const runner = new FakeProcessRunner();
    scriptPasswordRemote(runner);
    const home = makeHome();
    const manager = makeManager(runner, 49160, undefined, {}, home);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const handle = await manager.connect('devbox', { password: 's3cret', savePassword: true });
    expect(handle.localOrigin).toBe('http://127.0.0.1:49160');
    const handshakes = runner.runs.filter((run) => run.argv.at(-1) === 'true');
    expect(handshakes.length).toBeGreaterThanOrEqual(2);
    expect(handshakes[0]?.argv).toContain('BatchMode=yes');
    const retry = handshakes.find((run) => !run.argv.includes('BatchMode=yes'));
    expect(retry?.env?.['SSH_ASKPASS_REQUIRE']).toBe('force');
    expect(retry?.env?.['KIMI_SSH_PASSWORD']).toBe('s3cret');
    for (const run of runner.runs) {
      expect(run.argv.join(' ')).not.toContain('s3cret');
    }
    await expect(new SecretsStore(home).getPassword('devbox')).resolves.toBe('s3cret');
    const [info] = await manager.list();
    expect(info?.hasPassword).toBe(true);
    await manager.close();
  });

  it('does not persist the password without savePassword', async () => {
    const runner = new FakeProcessRunner();
    scriptPasswordRemote(runner);
    const home = makeHome();
    const manager = makeManager(runner, 49160, undefined, {}, home);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox', { password: 's3cret' });
    await expect(new SecretsStore(home).hasPassword('devbox')).resolves.toBe(false);
    const [info] = await manager.list();
    expect(info?.hasPassword).toBe(false);
    await manager.close();
  });

  it('uses a stored password when connecting without one', async () => {
    const runner = new FakeProcessRunner();
    scriptPasswordRemote(runner);
    const home = makeHome();
    await new SecretsStore(home).setPassword('devbox', 'st0red');
    const manager = makeManager(runner, 49160, undefined, {}, home);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox');
    const retry = runner.runs.find((run) => !run.argv.includes('BatchMode=yes'));
    expect(retry?.env?.['KIMI_SSH_PASSWORD']).toBe('st0red');
    await manager.close();
  });

  it('marks the connection as needing a password when auth fails without one', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = AUTH_FAILURE;
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const error: unknown = await manager.connect('devbox').catch((error) => error);
    expect(isNeedsPasswordError(error)).toBe(true);
    const status = manager.status('devbox');
    expect(status.state).toBe('error');
    expect(status.needsPassword).toBe(true);
    await manager.close();
  });

  it('clears needsPassword after a later connect succeeds with a password', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = AUTH_FAILURE;
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await expect(manager.connect('devbox')).rejects.toThrow(SshRemoteError);
    expect(manager.status('devbox').needsPassword).toBe(true);
    scriptPasswordRemote(runner);
    await manager.connect('devbox', { password: 's3cret' });
    expect(manager.status('devbox').needsPassword).toBeUndefined();
    expect(manager.status('devbox').state).toBe('on');
    await manager.close();
  });

  it('reports needsPassword in a failed test result without throwing', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = AUTH_FAILURE;
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const result = await manager.test('devbox');
    expect(result.ok).toBe(false);
    expect(result.needsPassword).toBe(true);
    expect(result.error).not.toContain('s3cret');
  });

  it('tests with a provided password and persists it when savePassword is set', async () => {
    const runner = new FakeProcessRunner();
    scriptPasswordRemote(runner);
    const home = makeHome();
    const manager = makeManager(runner, 49160, undefined, {}, home);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const result = await manager.test('devbox', { password: 's3cret', savePassword: true });
    expect(result.ok).toBe(true);
    await expect(new SecretsStore(home).getPassword('devbox')).resolves.toBe('s3cret');
    for (const run of runner.runs) {
      expect(run.argv.join(' ')).not.toContain('s3cret');
    }
    await manager.close();
  });

  it('removes the stored password when the connection is removed', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const home = makeHome();
    const secrets = new SecretsStore(home);
    const manager = makeManager(runner, 49160, undefined, {}, home);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await secrets.setPassword('devbox', 's3cret');
    await manager.remove('devbox');
    await expect(secrets.hasPassword('devbox')).resolves.toBe(false);
    await manager.close();
  });

  it('treats an empty password as no password and never persists it', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const home = makeHome();
    const manager = makeManager(runner, 49160, undefined, {}, home);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.connect('devbox', { password: '', savePassword: true });
    await expect(new SecretsStore(home).hasPassword('devbox')).resolves.toBe(false);
    const result = await manager.test('devbox', { password: '', savePassword: true });
    expect(result.ok).toBe(true);
    await expect(new SecretsStore(home).hasPassword('devbox')).resolves.toBe(false);
    await manager.close();
  });

  it('setPassword persists a password for an existing connection', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await manager.setPassword('devbox', 's3cret');
    const [info] = await manager.list();
    expect(info?.hasPassword).toBe(true);
    await manager.setPassword('devbox', 'n3w-s3cret');
    await manager.clearPassword('devbox');
    const [cleared] = await manager.list();
    expect(cleared?.hasPassword).toBe(false);
    await manager.clearPassword('devbox');
    await manager.close();
  });

  it('setPassword rejects unknown connections and empty passwords', async () => {
    const runner = new FakeProcessRunner();
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const missing: unknown = await manager.setPassword('ghost', 's3cret').catch((error) => error);
    expect(missing).toBeInstanceOf(SshRemoteError);
    expect((missing as SshRemoteError).kind).toBe('config');
    expect((missing as SshRemoteError).message).toContain('not found');
    await expect(manager.setPassword('devbox', '')).rejects.toThrow(SshRemoteError);
    const [info] = await manager.list();
    expect(info?.hasPassword).toBe(false);
    await manager.close();
  });

  it('scanHostKey runs ssh-keyscan on the profile host and port and returns fingerprints', async () => {
    const runner = new FakeProcessRunner();
    const blob = Buffer.from('fake-ed25519-key-blob').toString('base64');
    const expectedFingerprint = `SHA256:${createHash('sha256')
      .update(Buffer.from(blob, 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`;
    runner.onRun(/ssh-keyscan/, () => ({
      code: 0,
      stdout: [
        '# dev.example.com:2222 SSH-2.0-OpenSSH_9.9',
        `dev.example.com ssh-ed25519 ${blob}`,
        '',
      ].join('\n'),
      stderr: '',
    }));
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice', port: 2222 });
    const keys = await manager.scanHostKey('devbox');
    expect(keys).toEqual({
      host: 'dev.example.com',
      port: 2222,
      keys: [{ keyType: 'ssh-ed25519', fingerprint: expectedFingerprint }],
    });
    expect(runner.lastRun().argv).toEqual([
      'ssh-keyscan',
      '-T',
      '10',
      '-p',
      '2222',
      'dev.example.com',
    ]);
    await manager.close();
  });

  it('scanHostKey rejects unknown connections and unscannable hosts', async () => {
    const runner = new FakeProcessRunner();
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    await expect(manager.scanHostKey('ghost')).rejects.toThrow(SshRemoteError);
    runner.defaultResult = { code: 1, stdout: '', stderr: 'no route to host' };
    const error: unknown = await manager.scanHostKey('devbox').catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).kind).toBe('host-unreachable');
    await manager.close();
  });

  it('forgetHostKey removes the stored key with ssh-keygen -R', async () => {
    const runner = new FakeProcessRunner();
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice', port: 2222 });
    await manager.add({ name: 'plain', host: 'plain.example.com' });
    await manager.forgetHostKey('devbox');
    expect(runner.lastRun().argv).toEqual(['ssh-keygen', '-R', '[dev.example.com]:2222']);
    await manager.forgetHostKey('plain');
    expect(runner.lastRun().argv).toEqual(['ssh-keygen', '-R', 'plain.example.com']);
    await manager.close();
  });

  it('forgetHostKey surfaces ssh-keygen failures', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = { code: 255, stdout: '', stderr: 'known_hosts: No such file' };
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const error: unknown = await manager.forgetHostKey('devbox').catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).message).toContain('dev.example.com');
    await manager.close();
  });

  it('exposes host key details from test() and status() when the host key changed', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = {
      code: 255,
      stdout: '',
      stderr: [
        'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!',
        'The fingerprint for the ED25519 key sent by the remote host is',
        'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.',
        'Offending ED25519 key in /home/alice/.ssh/known_hosts:17',
        'Host key verification failed.',
      ].join('\n'),
    };
    const manager = makeManager(runner);
    await manager.add({ name: 'devbox', host: 'dev.example.com', user: 'alice' });
    const result = await manager.test('devbox');
    expect(result.ok).toBe(false);
    expect(result.hostKey).toMatchObject({
      host: 'dev.example.com',
      port: 22,
      fingerprint: 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.',
      keyType: 'ssh-ed25519',
      knownHostsFile: '/home/alice/.ssh/known_hosts',
      knownHostsLine: 17,
    });
    expect(result.error).toContain('ssh-keygen -R dev.example.com');
    await manager.connect('devbox').catch(() => {});
    const status = manager.status('devbox');
    expect(status.state).toBe('error');
    expect(status.hostKey?.fingerprint).toBe('SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.');
    await manager.close();
  });
});

describe('parseHostKeyScan', () => {
  it('skips comments and blank lines and parses key type and fingerprint', () => {
    const blob = Buffer.from('key-blob').toString('base64');
    const keys = parseHostKeyScan(
      `# banner\n\nexample.com,203.0.113.10 ssh-ed25519 ${blob}\ngarbage\n`,
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyType).toBe('ssh-ed25519');
    expect(keys[0]?.fingerprint.startsWith('SHA256:')).toBe(true);
  });
});

describe('knownHostsTarget', () => {
  it('brackets non-default ports only', () => {
    expect(knownHostsTarget('example.com', 22)).toBe('example.com');
    expect(knownHostsTarget('example.com', 2222)).toBe('[example.com]:2222');
  });
});
