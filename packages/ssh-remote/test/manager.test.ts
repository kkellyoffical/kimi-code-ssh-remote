import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SshRemoteError, isNeedsPasswordError } from '../src/errors';
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
) {
  let nextPort = port;
  return createSshConnectionManager({
    homeDir: homeDir ?? makeHome(),
    runner,
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
});
