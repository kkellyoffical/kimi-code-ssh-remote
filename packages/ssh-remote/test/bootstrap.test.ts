import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bootstrapRemote } from '../src/bootstrap';
import { SshRemoteError } from '../src/errors';
import type { SshConnectionProfile } from '../src/profile';
import { SshClient } from '../src/ssh';

import { FakeProcessRunner, remoteCommand } from './fake-runner';

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

function makeClient(runner: FakeProcessRunner): SshClient {
  const controlDir = mkdtempSync(join(tmpdir(), 'ssh-remote-boot-'));
  cleanups.push(() => {
    rmSync(controlDir, { recursive: true, force: true });
  });
  return new SshClient({ profile: PROFILE, runner, controlDir });
}

const noSleep = async (): Promise<void> => {};

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
  runner.onRun(/server\.token/, () => ({ code: 0, stdout: 'tok-abc\n', stderr: '' }));
}

describe('bootstrapRemote', () => {
  it('reuses an already-installed and already-running remote server', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    const result = await bootstrapRemote({ client: makeClient(runner), sleep: noSleep });
    expect(result).toEqual({
      platform: 'linux-x64',
      kimiPath: '/usr/bin/kimi',
      remoteHome: '/home/alice/.kimi-code',
      remotePort: 58627,
      token: 'tok-abc',
      serverStarted: false,
    });
    expect(runner.runs.some((run) => remoteCommand(run).includes('nohup'))).toBe(false);
    expect(runner.runs.some((run) => run.argv[0] === 'scp')).toBe(false);
  });

  it('installs the matching binary and starts the server when missing', async () => {
    const runner = new FakeProcessRunner();
    let healthy = false;
    runner.onRun(/uname -s && uname -m/, () => ({
      code: 0,
      stdout: 'Darwin\narm64\n',
      stderr: '',
    }));
    runner.onRun(/command -v kimi/, () => ({
      code: 0,
      stdout: '/Users/bob/.kimi-code\n',
      stderr: '',
    }));
    runner.onRun(/curl -sf/, () => ({
      code: healthy ? 0 : 1,
      stdout: '',
      stderr: '',
    }));
    runner.onRun(/nohup/, () => {
      healthy = true;
      return { code: 0, stdout: '4321\n', stderr: '' };
    });
    runner.onRun(/server\.token/, () => ({ code: 0, stdout: 'tok-xyz\n', stderr: '' }));

    const result = await bootstrapRemote({
      client: makeClient(runner),
      remotePort: 60001,
      resolveLocalBinary: (platform) =>
        platform === 'darwin-arm64' ? '/local/dist/kimi-darwin-arm64' : undefined,
      sleep: noSleep,
      pollIntervalMs: 1,
      readyTimeoutMs: 50,
    });

    const scpRun = runner.runs.find((run) => run.argv[0] === 'scp');
    expect(scpRun).toBeDefined();
    expect(scpRun!.argv).toContain('/local/dist/kimi-darwin-arm64');
    expect(scpRun!.argv.at(-1)).toMatch(
      /^alice@dev\.example\.com:'\/Users\/bob\/\.kimi-code\/bin\/\.kimi-upload-[0-9a-f]+'$/,
    );
    const installRun = runner.runs.find((run) => remoteCommand(run).includes('chmod 755'));
    expect(installRun).toBeDefined();
    expect(remoteCommand(installRun!)).toContain("'/Users/bob/.kimi-code/bin/kimi'");
    const startRun = runner.runs.find((run) => remoteCommand(run).includes('nohup'));
    expect(startRun).toBeDefined();
    expect(remoteCommand(startRun!)).toContain('web --host 127.0.0.1 --port 60001 --no-open');

    expect(result.platform).toBe('darwin-arm64');
    expect(result.kimiPath).toBe('/Users/bob/.kimi-code/bin/kimi');
    expect(result.serverStarted).toBe(true);
    expect(result.token).toBe('tok-xyz');
    expect(result.remotePort).toBe(60001);
  });

  it('fails with remote-missing-binary when no local binary matches the platform', async () => {
    const runner = new FakeProcessRunner();
    runner.onRun(/uname -s && uname -m/, () => ({
      code: 0,
      stdout: 'Linux\naarch64\n',
      stderr: '',
    }));
    runner.onRun(/command -v kimi/, () => ({
      code: 0,
      stdout: '/home/alice/.kimi-code\n',
      stderr: '',
    }));
    const error = await bootstrapRemote({
      client: makeClient(runner),
      resolveLocalBinary: () => undefined,
      sleep: noSleep,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).kind).toBe('remote-missing-binary');
  });

  it('rejects unsupported remote platforms', async () => {
    const runner = new FakeProcessRunner();
    runner.onRun(/uname -s && uname -m/, () => ({
      code: 0,
      stdout: 'FreeBSD\namd64\n',
      stderr: '',
    }));
    await expect(
      bootstrapRemote({ client: makeClient(runner), sleep: noSleep }),
    ).rejects.toThrow(/unsupported remote platform/);
  });

  it('waits for the token file to appear', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    let tokenReads = 0;
    runner.onRun(/server\.token/, () => {
      tokenReads += 1;
      return tokenReads < 3
        ? { code: 1, stdout: '', stderr: '' }
        : { code: 0, stdout: 'tok-late\n', stderr: '' };
    });
    const sleeps: number[] = [];
    const result = await bootstrapRemote({
      client: makeClient(runner),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollIntervalMs: 7,
      tokenTimeoutMs: 1_000,
    });
    expect(result.token).toBe('tok-late');
    expect(tokenReads).toBe(3);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 7)).toBe(true);
  });

  it('generates syntactically valid remote shell commands', async () => {
    const runner = new FakeProcessRunner();
    let healthy = false;
    runner.onRun(/uname -s && uname -m/, () => ({
      code: 0,
      stdout: 'Linux\narm64\n',
      stderr: '',
    }));
    runner.onRun(/command -v kimi/, () => ({
      code: 0,
      stdout: '/home/alice dir/.kimi-code\n',
      stderr: '',
    }));
    runner.onRun(/curl -sf/, () => ({ code: healthy ? 0 : 1, stdout: '', stderr: '' }));
    runner.onRun(/nohup/, () => {
      healthy = true;
      return { code: 0, stdout: '999\n', stderr: '' };
    });
    runner.onRun(/server\.token/, () => ({ code: 0, stdout: 'tok\n', stderr: '' }));
    await bootstrapRemote({
      client: makeClient(runner),
      resolveLocalBinary: () => '/local/kimi-linux-arm64',
      sleep: noSleep,
      pollIntervalMs: 1,
    });
    const remoteCommands = runner.runs
      .filter((run) => run.argv[0] === 'ssh')
      .map((run) => remoteCommand(run));
    expect(remoteCommands.length).toBeGreaterThan(3);
    for (const command of remoteCommands) {
      expect(() => execFileSync('bash', ['-n', '-c', command]), command).not.toThrow();
    }
  });

  it('removes the partial upload when installation fails', async () => {
    const runner = new FakeProcessRunner();
    runner.onRun(/uname -s && uname -m/, () => ({
      code: 0,
      stdout: 'Linux\nx86_64\n',
      stderr: '',
    }));
    runner.onRun(/command -v kimi/, () => ({
      code: 0,
      stdout: '/home/alice/.kimi-code\n',
      stderr: '',
    }));
    runner.onRun(/^scp /, () => ({ code: 1, stdout: '', stderr: 'connection lost' }));
    await expect(
      bootstrapRemote({
        client: makeClient(runner),
        resolveLocalBinary: () => '/local/kimi-linux-x64',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/cannot upload/);
    const cleanup = runner.runs.find((run) => /rm -f .*\.kimi-upload-/.test(remoteCommand(run)));
    expect(cleanup).toBeDefined();
  });

  it('falls back to token-based readiness when the remote has no curl or wget', async () => {
    const runner = new FakeProcessRunner();
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
    runner.onRun(/curl -sf/, () => ({ code: 111, stdout: '', stderr: '' }));
    runner.onRun(/nohup/, () => ({ code: 0, stdout: '77\n', stderr: '' }));
    runner.onRun(/server\.token/, () => ({ code: 0, stdout: 'tok-nocurl\n', stderr: '' }));
    const logs: string[] = [];
    const result = await bootstrapRemote({
      client: makeClient(runner),
      sleep: noSleep,
      pollIntervalMs: 1,
      readyTimeoutMs: 5,
      logger: (line) => {
        logs.push(line);
      },
    });
    expect(result.serverStarted).toBe(true);
    expect(result.token).toBe('tok-nocurl');
    expect(logs.some((line) => line.includes('no curl or wget'))).toBe(true);
  });

  it('times out when the token never appears', async () => {
    const runner = new FakeProcessRunner();
    scriptHealthyRemote(runner);
    runner.onRun(/server\.token/, () => ({ code: 1, stdout: '', stderr: '' }));
    await expect(
      bootstrapRemote({
        client: makeClient(runner),
        sleep: noSleep,
        pollIntervalMs: 1,
        tokenTimeoutMs: 10,
      }),
    ).rejects.toThrow(/timed out.*server token/);
  });
});
