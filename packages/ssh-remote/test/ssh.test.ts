import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SshRemoteError } from '../src/errors';
import type { SshConnectionProfile } from '../src/profile';
import { SshClient, classifySshError, shQuote } from '../src/ssh';

import { FakeProcessRunner } from './fake-runner';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeControlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-ctl-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const PROFILE: SshConnectionProfile = {
  name: 'devbox',
  host: 'dev.example.com',
  user: 'alice',
  port: 2222,
  identityFile: '/home/alice/.ssh/id_ed25519',
};

function makeClient(
  runner: FakeProcessRunner,
  profile: SshConnectionProfile = PROFILE,
): SshClient {
  return new SshClient({ profile, runner, controlDir: makeControlDir() });
}

describe('SshClient', () => {
  it('connects through a ControlMaster socket with batch mode', async () => {
    const runner = new FakeProcessRunner();
    const client = makeClient(runner);
    await client.connect();
    const { argv } = runner.lastRun();
    expect(argv[0]).toBe('ssh');
    const joined = argv.join(' ');
    expect(joined).toContain('ControlMaster=auto');
    expect(joined).toContain(`ControlPath=${client.controlPath}`);
    expect(joined).toContain('ControlPersist=');
    expect(joined).toContain('BatchMode=yes');
    expect(joined).toContain('ConnectTimeout=');
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
    expect(argv).toContain('-i');
    expect(argv[argv.indexOf('-i') + 1]).toBe('/home/alice/.ssh/id_ed25519');
    expect(argv.at(-2)).toBe('alice@dev.example.com');
    expect(argv.at(-1)).toBe('true');
    expect(joined).not.toContain('-F');
  });

  it('omits user and identity file when the profile has none', async () => {
    const runner = new FakeProcessRunner();
    const client = makeClient(runner, { name: 'plain', host: 'plain.example.com', port: 22 });
    await client.connect();
    const { argv } = runner.lastRun();
    expect(argv).not.toContain('-i');
    expect(argv.at(-2)).toBe('plain.example.com');
  });

  it('classifies a permission-denied failure as an auth error', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = {
      code: 255,
      stdout: '',
      stderr: 'alice@dev.example.com: Permission denied (publickey).',
    };
    const client = makeClient(runner);
    const error = await client.connect().catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).kind).toBe('auth');
  });

  it('checks and tears down the master connection', async () => {
    const runner = new FakeProcessRunner();
    const client = makeClient(runner);
    await expect(client.status()).resolves.toBe('connected');
    expect(runner.lastRun().argv).toContain('check');
    runner.defaultResult = { code: 255, stdout: '', stderr: 'No such file or directory' };
    await expect(client.status()).resolves.toBe('disconnected');
    await client.disconnect();
    expect(runner.lastRun().argv).toContain('exit');
    expect(runner.lastRun().argv.join(' ')).toContain(`ControlPath=${client.controlPath}`);
  });

  it('runs remote commands after the destination', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = { code: 0, stdout: 'ok\n', stderr: '' };
    const client = makeClient(runner);
    await expect(client.execOrThrow('uname -a')).resolves.toBe('ok\n');
    const { argv } = runner.lastRun();
    expect(argv.at(-2)).toBe('alice@dev.example.com');
    expect(argv.at(-1)).toBe('uname -a');
  });

  it('uploads with scp on the configured port', async () => {
    const runner = new FakeProcessRunner();
    const client = makeClient(runner);
    await client.upload('/tmp/kimi-linux-x64', '/home/alice/.kimi-code/bin/.kimi-upload-abc');
    const { argv } = runner.lastRun();
    expect(argv[0]).toBe('scp');
    expect(argv).toContain('-P');
    expect(argv[argv.indexOf('-P') + 1]).toBe('2222');
    expect(argv.join(' ')).toContain('ControlPath=');
    expect(argv.at(-2)).toBe('/tmp/kimi-linux-x64');
    expect(argv.at(-1)).toBe(
      "alice@dev.example.com:'/home/alice/.kimi-code/bin/.kimi-upload-abc'",
    );
  });

  it('derives the control socket from the connection target', () => {
    const runner = new FakeProcessRunner();
    const controlDir = makeControlDir();
    const a = new SshClient({ profile: PROFILE, runner, controlDir });
    const b = new SshClient({ profile: PROFILE, runner, controlDir });
    const moved = new SshClient({
      profile: { ...PROFILE, host: 'other.example.com' },
      runner,
      controlDir,
    });
    expect(a.controlPath).toBe(b.controlPath);
    expect(a.controlPath).not.toBe(moved.controlPath);
    expect(a.controlPath.length).toBeLessThan(100);
  });
});

describe('classifySshError', () => {
  const cases: Array<[string, { code: number; stderr: string }, string]> = [
    ['auth', { code: 255, stderr: 'Permission denied (publickey,password).' }, 'auth'],
    [
      'host-unreachable',
      { code: 255, stderr: 'ssh: Could not resolve hostname x: nodename nor servname provided' },
      'host-unreachable',
    ],
    [
      'host-unreachable',
      { code: 255, stderr: 'ssh: connect to host x port 22: Operation timed out' },
      'host-unreachable',
    ],
    [
      'network',
      { code: 255, stderr: 'ssh: connect to host x port 22: Connection refused' },
      'network',
    ],
    [
      'remote-missing-binary',
      { code: 127, stderr: 'bash: kimi: command not found' },
      'remote-missing-binary',
    ],
    ['unknown', { code: 1, stderr: 'something else' }, 'unknown'],
  ];

  it.each(cases)('%s → %s', (_label, result, expected) => {
    expect(classifySshError({ stdout: '', ...result })).toBe(expected);
  });
});

describe('shQuote', () => {
  it('wraps and escapes single quotes', () => {
    expect(shQuote('/a/b c')).toBe("'/a/b c'");
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });
});
