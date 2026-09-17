import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SshRemoteError } from '../src/errors';
import { createSshConnectionManager } from '../src/manager';

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

function makeManager(runner: FakeProcessRunner, port = 49160, sleep?: (ms: number) => Promise<void>) {
  let nextPort = port;
  return createSshConnectionManager({
    homeDir: makeHome(),
    runner,
    tunnel: {
      pickFreePort: async () => nextPort++,
      probeLocalPort: async () => true,
      sleep: sleep ?? (async () => {}),
      reconnectBaseDelayMs: 1,
    },
    bootstrap: { sleep: async () => {}, pollIntervalMs: 1 },
  });
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
});
