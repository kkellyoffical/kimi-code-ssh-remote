import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SshRemoteError, isNeedsPasswordError } from '../src/errors';
import type { SshConnectionProfile } from '../src/profile';
import type { RunResult } from '../src/runner';
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
  password?: string,
): SshClient {
  return new SshClient({ profile, runner, controlDir: makeControlDir(), password });
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

describe('SshClient password authentication', () => {
  const AUTH_FAILURE: RunResult = {
    code: 255,
    stdout: '',
    stderr: 'alice@dev.example.com: Permission denied (publickey,password).',
  };
  const OK: RunResult = { code: 0, stdout: '', stderr: '' };

  const batchOnly = (argv: readonly string[]): boolean => argv.includes('BatchMode=yes');

  it('flags needsPassword when batch auth fails and no password is available', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = AUTH_FAILURE;
    const client = makeClient(runner);
    const error: unknown = await client.connect().catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    expect((error as SshRemoteError).kind).toBe('auth');
    expect((error as SshRemoteError).needsPassword).toBe(true);
    expect(isNeedsPasswordError(error)).toBe(true);
    expect(runner.runs).toHaveLength(1);
  });

  it('treats an empty password as no password', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = AUTH_FAILURE;
    const client = makeClient(runner, PROFILE, '');
    const error: unknown = await client.connect().catch((error) => error);
    expect(isNeedsPasswordError(error)).toBe(true);
    expect(runner.runs).toHaveLength(1);
  });

  it('does not retry or flag needsPassword for non-auth failures', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = {
      code: 255,
      stdout: '',
      stderr: 'ssh: Could not resolve hostname dev.example.com',
    };
    const client = makeClient(runner, PROFILE, 's3cret');
    const error: unknown = await client.connect().catch((error) => error);
    expect((error as SshRemoteError).kind).toBe('host-unreachable');
    expect((error as SshRemoteError).needsPassword).toBe(false);
    expect(isNeedsPasswordError(error)).toBe(false);
    expect(runner.runs).toHaveLength(1);
  });

  it('retries through SSH_ASKPASS with the password in the environment, never in argv', async () => {
    const runner = new FakeProcessRunner();
    runner.onRun(/ssh/, (argv) => (batchOnly(argv) ? AUTH_FAILURE : OK));
    const client = makeClient(runner, PROFILE, 's3cret');
    await client.connect();
    expect(runner.runs).toHaveLength(2);
    const [batch, retry] = runner.runs;
    expect(batch?.argv.join(' ')).toContain('BatchMode=yes');
    expect(batch?.env).toBeUndefined();
    expect(retry?.argv.join(' ')).not.toContain('BatchMode=yes');
    expect(retry?.env?.['SSH_ASKPASS_REQUIRE']).toBe('force');
    expect(retry?.env?.['KIMI_SSH_PASSWORD']).toBe('s3cret');
    const askpass = retry?.env?.['SSH_ASKPASS'];
    expect(askpass).toBeDefined();
    expect(askpass).toContain('askpass-');
    expect(existsSync(askpass ?? '')).toBe(false);
    for (const run of runner.runs) {
      expect(run.argv.join(' ')).not.toContain('s3cret');
    }
  });

  it('flags needsPassword when the password retry also fails', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = AUTH_FAILURE;
    const client = makeClient(runner, PROFILE, 'wr0ng');
    const error: unknown = await client.connect().catch((error) => error);
    expect(isNeedsPasswordError(error)).toBe(true);
    expect(runner.runs).toHaveLength(2);
    expect((error as SshRemoteError).message).not.toContain('wr0ng');
    expect((error as SshRemoteError).stderr ?? '').not.toContain('wr0ng');
  });

  it('treats "Too many authentication failures" as an auth failure', async () => {
    const failure: RunResult = {
      code: 255,
      stdout: '',
      stderr: 'Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures',
    };
    const runner = new FakeProcessRunner();
    runner.defaultResult = failure;
    const withoutPassword = makeClient(runner);
    const error: unknown = await withoutPassword.connect().catch((error) => error);
    expect((error as SshRemoteError).kind).toBe('auth');
    expect(isNeedsPasswordError(error)).toBe(true);
    runner.onRun(/ssh/, (argv) => (batchOnly(argv) ? failure : OK));
    const withPassword = makeClient(runner, PROFILE, 's3cret');
    await withPassword.connect();
    expect(runner.runs.at(-1)?.env?.['KIMI_SSH_PASSWORD']).toBe('s3cret');
  });

  it('retries exec through SSH_ASKPASS on auth failure', async () => {
    const runner = new FakeProcessRunner();
    runner.onRun(/ssh/, (argv) =>
      batchOnly(argv) ? AUTH_FAILURE : { code: 0, stdout: 'ok\n', stderr: '' },
    );
    const client = makeClient(runner, PROFILE, 's3cret');
    await expect(client.execOrThrow('uname -a')).resolves.toBe('ok\n');
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]?.env?.['KIMI_SSH_PASSWORD']).toBe('s3cret');
  });
});

describe('classifySshError', () => {
  const cases: Array<[string, { code: number; stderr: string }, string]> = [
    ['auth', { code: 255, stderr: 'Permission denied (publickey,password).' }, 'auth'],
    [
      'too many authentication failures',
      {
        code: 255,
        stderr: 'Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures',
      },
      'auth',
    ],
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
