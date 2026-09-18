import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SshRemoteError, isNeedsPasswordError } from '../src/errors';
import type { SshConnectionProfile } from '../src/profile';
import type { RunResult } from '../src/runner';
import { SshClient, classifySshError, parseOffendingHostKey, shQuote } from '../src/ssh';

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
    expect(joined).toContain('StrictHostKeyChecking=accept-new');
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

  it('uses strict host key checking when the profile opts in', async () => {
    const runner = new FakeProcessRunner();
    const client = makeClient(runner, { ...PROFILE, strictHostKeyChecking: true });
    await client.connect();
    const joined = runner.lastRun().argv.join(' ');
    expect(joined).toContain('StrictHostKeyChecking=yes');
    expect(joined).not.toContain('StrictHostKeyChecking=accept-new');
  });

  it('injects accept-new into scp argv', async () => {
    const runner = new FakeProcessRunner();
    const client = makeClient(runner);
    await client.upload('/tmp/kimi-linux-x64', '/home/alice/bin/kimi');
    const joined = runner.lastRun().argv.join(' ');
    expect(runner.lastRun().argv[0]).toBe('scp');
    expect(joined).toContain('StrictHostKeyChecking=accept-new');
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

describe('SshClient host key verification', () => {
  const CHANGED_KEY: RunResult = {
    code: 255,
    stdout: '',
    stderr: [
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
      'The fingerprint for the ED25519 key sent by the remote host is',
      'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.',
      'Offending ED25519 key in /home/alice/.ssh/known_hosts:17',
      'Host key for dev.example.com has changed and you have requested strict checking.',
      'Host key verification failed.',
    ].join('\n'),
  };

  it('classifies a changed host key with guidance and the offending key location', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = CHANGED_KEY;
    const client = makeClient(runner);
    const error: unknown = await client.connect().catch((error) => error);
    expect(error).toBeInstanceOf(SshRemoteError);
    const sshError = error as SshRemoteError;
    expect(sshError.kind).toBe('host-key-changed');
    expect(sshError.hostKey).toEqual({
      host: 'dev.example.com',
      port: 2222,
      fingerprint: 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.',
      keyType: 'ssh-ed25519',
      expectedFingerprint: undefined,
      knownHostsFile: '/home/alice/.ssh/known_hosts',
      knownHostsLine: 17,
    });
    expect(sshError.message).toContain('ssh-keygen -R [dev.example.com]:2222');
    expect(sshError.message).toContain('/home/alice/.ssh/known_hosts:17');
    expect(sshError.needsPassword).toBe(false);
  });

  it('reads the stored fingerprint from the offending known_hosts line', async () => {
    const dir = makeControlDir();
    const knownHosts = join(dir, 'known_hosts');
    const blob = Buffer.from('stored-key-blob').toString('base64');
    const lines = Array.from({ length: 16 }, () => '# filler');
    lines.push(`dev.example.com ssh-ed25519 ${blob}`);
    writeFileSync(knownHosts, `${lines.join('\n')}\n`, { mode: 0o600 });
    const runner = new FakeProcessRunner();
    runner.defaultResult = {
      ...CHANGED_KEY,
      stderr: CHANGED_KEY.stderr.replace('/home/alice/.ssh/known_hosts', knownHosts),
    };
    const client = makeClient(runner);
    const error: unknown = await client.connect().catch((error) => error);
    const expected = `SHA256:${createHash('sha256')
      .update(Buffer.from(blob, 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`;
    expect((error as SshRemoteError).hostKey?.expectedFingerprint).toBe(expected);
    expect((error as SshRemoteError).hostKey?.fingerprint).toBe(
      'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.',
    );
  });

  it('never retries a changed host key through askpass, even with a password', async () => {
    const runner = new FakeProcessRunner();
    runner.defaultResult = CHANGED_KEY;
    const client = makeClient(runner, PROFILE, 's3cret');
    const error: unknown = await client.connect().catch((error) => error);
    expect((error as SshRemoteError).kind).toBe('host-key-changed');
    expect(runner.runs).toHaveLength(1);
  });
});

describe('parseOffendingHostKey', () => {
  it('extracts the known_hosts file and line from ssh stderr', () => {
    expect(
      parseOffendingHostKey('Offending RSA key in /home/alice/.ssh/known_hosts:3\nHost key verification failed.'),
    ).toEqual({ file: '/home/alice/.ssh/known_hosts', line: 3 });
  });

  it('returns undefined when no offending key is reported', () => {
    expect(parseOffendingHostKey('Host key verification failed.')).toBeUndefined();
  });
});

describe('classifySshError', () => {
  const cases: Array<[string, { code: number; stderr: string }, string]> = [
    ['auth', { code: 255, stderr: 'Permission denied (publickey,password).' }, 'auth'],
    [
      'host key changed',
      {
        code: 255,
        stderr:
          'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.',
      },
      'host-key-changed',
    ],
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
