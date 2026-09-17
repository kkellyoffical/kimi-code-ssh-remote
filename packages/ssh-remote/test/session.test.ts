import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SshConnectionProfile } from '../src/profile';
import { openSshRemoteSession } from '../src/session';

import { FakeProcessRunner } from './fake-runner';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const PROFILE: SshConnectionProfile = {
  name: 'devbox',
  host: 'dev.example.com',
  user: 'alice',
  port: 22,
};

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-session-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function scriptRemote(runner: FakeProcessRunner): void {
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

describe('openSshRemoteSession', () => {
  it('connects, bootstraps, and tunnels to the remote web server', async () => {
    const runner = new FakeProcessRunner();
    scriptRemote(runner);
    const session = await openSshRemoteSession({
      profile: PROFILE,
      homeDir: makeHome(),
      runner,
      localPort: 49999,
      tunnel: { probeLocalPort: async () => true },
    });
    expect(session.localOrigin).toBe('http://127.0.0.1:49999');
    expect(session.localPort).toBe(49999);
    expect(session.remotePort).toBe(58627);
    expect(session.token).toBe('tok-1');
    expect(session.platform).toBe('linux-x64');
    expect(session.status().state).toBe('connected');

    await session.close();
    expect(runner.spawns[0]!.killed).toBe(true);
    const exitRun = runner.runs.find(
      (run) => run.argv.includes('-O') && run.argv.includes('exit'),
    );
    expect(exitRun).toBeDefined();
  });

  it('tears down the control connection when bootstrap fails', async () => {
    const runner = new FakeProcessRunner();
    runner.onRun(/uname -s && uname -m/, () => ({
      code: 0,
      stdout: 'FreeBSD\namd64\n',
      stderr: '',
    }));
    await expect(
      openSshRemoteSession({
        profile: PROFILE,
        homeDir: makeHome(),
        runner,
        localPort: 49998,
        tunnel: { probeLocalPort: async () => true },
      }),
    ).rejects.toThrow(/unsupported remote platform/);
    const exitRun = runner.runs.find(
      (run) => run.argv.includes('-O') && run.argv.includes('exit'),
    );
    expect(exitRun).toBeDefined();
    expect(runner.spawns).toHaveLength(0);
  });
});
