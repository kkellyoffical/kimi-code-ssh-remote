/**
 * Tests for the `kimi ssh` command tree and its REST client.
 *
 * No real server, registry, or ssh binary is involved: handlers run against
 * injected deps (fake REST backend / fake manager), the REST client runs
 * against a fake fetch, and local-mode add/list/remove use a real
 * `createSshConnectionManager` pointed at a temp home with a fake process
 * runner (the post-add auto-test would otherwise spawn ssh).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { ServerInstanceInfo } from '@moonshot-ai/kap-server';
import {
  createSshConnectionManager,
  SshRemoteError,
  type ProcessRunner,
  type SshAuthOptions,
  type SshConnectionHandle,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';
import chalk from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSshCommand } from '#/cli/sub/ssh';
import {
  createSshRestClient,
  SSH_AUTH_REQUIRED_CODE,
  SshApiError,
  type SshBackend,
} from '#/cli/sub/ssh/client';
import {
  buildSshDirectUrl,
  buildSshManageUrl,
  buildSshProxyUrl,
  formatAuthMethod,
  formatConnectionTable,
  formatNeedsPasswordError,
  sshErrorHint,
} from '#/cli/sub/ssh/format';
import {
  handleSshAdd,
  handleSshConnect,
  handleSshList,
  handleSshPasswd,
  handleSshRemove,
  handleSshTest,
  type SshCommandDeps,
} from '#/cli/sub/ssh/run';
import { readSecretLine } from '#/cli/sub/ssh/secret-prompt';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeIo(): {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  readStdout: () => string;
  readStderr: () => string;
} {
  let out = '';
  let err = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        err += String(chunk);
        return true;
      },
    },
    readStdout: () => stripAnsi(out),
    readStderr: () => stripAnsi(err),
  };
}

const LIVE_SERVER: ServerInstanceInfo = {
  serverId: 'srv-1',
  pid: 4242,
  host: '127.0.0.1',
  port: 58627,
  startedAt: 0,
  heartbeatAt: 0,
};

function fakeBackend(overrides: Partial<SshBackend> = {}): SshBackend {
  return {
    list: async () => [],
    add: async () => {
      throw new Error('unexpected add');
    },
    remove: async () => {},
    test: async () => ({ ok: true }) satisfies SshTestResult,
    connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
    setPassword: async () => {},
    clearPassword: async () => {},
    ...overrides,
  };
}

interface DepOverrides extends Partial<SshCommandDeps> {
  backend?: SshBackend;
  secretAnswers?: string[];
  confirmAnswers?: boolean[];
}

function makeDeps(overrides: DepOverrides = {}): {
  deps: SshCommandDeps;
  io: ReturnType<typeof makeIo>;
  opened: string[];
  backend: SshBackend;
  prompts: string[];
  secrets: string[];
  confirms: string[];
} {
  const io = makeIo();
  const opened: string[] = [];
  const prompts: string[] = [];
  const secrets: string[] = [];
  const confirms: string[] = [];
  const backend = overrides.backend ?? fakeBackend();
  const deps: SshCommandDeps = {
    homeDir: '/tmp/kimi-ssh-test-home',
    getLiveServer: async () => undefined,
    resolveToken: () => 'local-token',
    createRestClient: () => backend,
    createLocalManager: () => backend as unknown as SshConnectionManager,
    openUrl: (target) => {
      opened.push(target);
    },
    prompt: async (question) => {
      prompts.push(question);
      return '';
    },
    promptSecret: async (question) => {
      secrets.push(question);
      return overrides.secretAnswers?.shift() ?? '';
    },
    confirm: async (question) => {
      confirms.push(question);
      return overrides.confirmAnswers?.shift() ?? false;
    },
    isInteractive: () => false,
    holdForeground: async () => {},
    stdout: io.stdout,
    stderr: io.stderr,
    ...overrides,
  };
  return { deps, io, opened, backend, prompts, secrets, confirms };
}

describe('kimi ssh command wiring', () => {
  it('registers the ssh command with the full subcommand tree', () => {
    const program = new Command('kimi').exitOverride();
    registerSshCommand(program);
    const ssh = program.commands.find((command) => command.name() === 'ssh');
    expect(ssh).toBeDefined();
    expect(ssh?.commands.map((command) => command.name()).toSorted()).toEqual([
      'add',
      'connect',
      'list',
      'passwd',
      'remove',
      'test',
    ]);
  });

  it('exposes the documented options on add, passwd, test, and connect', () => {
    const program = new Command('kimi').exitOverride();
    registerSshCommand(program);
    const ssh = program.commands.find((command) => command.name() === 'ssh');
    const add = ssh?.commands.find((command) => command.name() === 'add');
    const passwd = ssh?.commands.find((command) => command.name() === 'passwd');
    const test = ssh?.commands.find((command) => command.name() === 'test');
    const connect = ssh?.commands.find((command) => command.name() === 'connect');
    expect(add?.options.map((option) => option.long)).toEqual([
      '--user',
      '--port',
      '--identity-file',
      '--password',
      '--save-password',
    ]);
    expect(passwd?.options.map((option) => option.long)).toEqual(['--clear']);
    expect(test?.options.map((option) => option.long)).toEqual(['--password']);
    expect(connect?.options.map((option) => option.long)).toEqual([
      '--direct',
      '--no-open',
      '--password',
    ]);
  });
});

describe('kimi ssh add', () => {
  it('saves a connection through the REST backend when a server is live', async () => {
    const added: unknown[] = [];
    const backend = fakeBackend({
      add: async (spec) => {
        added.push(spec);
        return {
          name: spec.name,
          host: spec.host,
          user: spec.user,
          port: spec.port ?? 22,
          identityFile: spec.identityFile,
          status: { state: 'off' },
        };
      },
    });
    const { deps, io } = makeDeps({
      backend,
      getLiveServer: async () => LIVE_SERVER,
    });
    await handleSshAdd({ name: 'prod', target: 'ubuntu@example.com', port: '2222' }, deps);
    expect(added).toEqual([
      { name: 'prod', host: 'example.com', user: 'ubuntu', port: 2222, identityFile: undefined },
    ]);
    const out = io.readStdout();
    expect(out).toContain('Saved ssh connection "prod" (ubuntu@example.com:2222)');
    expect(out).toContain('Authentication: OK (public key)');
    expect(out).toContain('kimi ssh connect prod');
  });

  it('auto-tests after saving and reports a needs-password status', async () => {
    const backend = fakeBackend({
      add: async (spec) => ({
        name: spec.name,
        host: spec.host,
        port: spec.port ?? 22,
        status: { state: 'off' },
      }),
      test: async () => ({
        ok: false,
        needsPassword: true,
        error: 'Permission denied (publickey,password).',
      }),
    });
    const { deps, io } = makeDeps({ backend });
    await handleSshAdd({ name: 'prod', target: 'example.com' }, deps);
    const out = io.readStdout();
    expect(out).toContain('Saved ssh connection "prod"');
    expect(out).toContain('password required');
    expect(out).toContain('kimi ssh passwd prod');
    expect(out).toContain('kimi ssh test prod');
  });

  it('reports a plain probe failure when the auto-test fails before auth', async () => {
    const backend = fakeBackend({
      add: async (spec) => ({
        name: spec.name,
        host: spec.host,
        port: spec.port ?? 22,
        status: { state: 'off' },
      }),
      test: async () => ({ ok: false, error: 'ssh: Could not resolve hostname nope.internal' }),
    });
    const { deps, io } = makeDeps({ backend });
    await handleSshAdd({ name: 'prod', target: 'nope.internal' }, deps);
    const out = io.readStdout();
    expect(out).toContain('Connection test: failed');
    expect(out).toContain('check the host name and your network');
    expect(out).not.toContain('Authentication: failed');
  });

  it('rejects --save-password without --password', async () => {
    const { deps } = makeDeps();
    await expect(
      handleSshAdd({ name: 'prod', target: 'example.com', savePassword: true }, deps),
    ).rejects.toThrow(/--save-password requires --password/);
  });

  it('rejects --password when not interactive', async () => {
    const { deps } = makeDeps();
    await expect(
      handleSshAdd({ name: 'prod', target: 'example.com', password: true }, deps),
    ).rejects.toThrow(/interactive terminal/);
  });

  it('prompts (hidden) for --password and tests with the password', async () => {
    const tests: (SshAuthOptions | undefined)[] = [];
    const backend = fakeBackend({
      add: async (spec) => ({
        name: spec.name,
        host: spec.host,
        user: spec.user,
        port: spec.port ?? 22,
        status: { state: 'off' },
      }),
      test: async (_name, auth) => {
        tests.push(auth);
        return { ok: true, platform: 'linux-x64' };
      },
    });
    const { deps, io, secrets } = makeDeps({
      backend,
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
      confirmAnswers: [true],
    });
    await handleSshAdd(
      { name: 'prod', target: 'ubuntu@example.com', password: true, savePassword: true },
      deps,
    );
    expect(secrets).toEqual(['Password for ubuntu@example.com: ']);
    expect(tests).toEqual([{ password: 's3cret', savePassword: true }]);
    expect(io.readStdout()).toContain('Authentication: OK (password, saved)');
  });

  it('notes when an entered password is verified but not saved', async () => {
    const backend = fakeBackend({
      add: async (spec) => ({
        name: spec.name,
        host: spec.host,
        port: spec.port ?? 22,
        status: { state: 'off' },
      }),
      test: async () => ({ ok: true }),
    });
    const { deps, io } = makeDeps({
      backend,
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
      confirmAnswers: [false],
    });
    await handleSshAdd({ name: 'prod', target: 'example.com', password: true }, deps);
    expect(io.readStdout()).toContain('Authentication: OK (password, not saved');
  });

  it('prefers --user over the user part of the target', async () => {
    const added: unknown[] = [];
    const backend = fakeBackend({
      add: async (spec) => {
        added.push(spec);
        return {
          name: spec.name,
          host: spec.host,
          user: spec.user,
          port: spec.port ?? 22,
          identityFile: spec.identityFile,
          status: { state: 'off' },
        };
      },
    });
    const { deps } = makeDeps({ backend });
    await handleSshAdd({ name: 'prod', target: 'ubuntu@example.com', user: 'root' }, deps);
    expect(added).toEqual([
      { name: 'prod', host: 'example.com', user: 'root', port: 22, identityFile: undefined },
    ]);
  });

  it('prompts for missing fields when interactive and no target is given', async () => {
    const answers = ['example.com', 'ubuntu', '2222', '~/.ssh/id_ed25519'];
    const added: unknown[] = [];
    const backend = fakeBackend({
      add: async (spec) => {
        added.push(spec);
        return {
          name: spec.name,
          host: spec.host,
          user: spec.user,
          port: spec.port ?? 22,
          identityFile: spec.identityFile,
          status: { state: 'off' },
        };
      },
    });
    const { deps, prompts } = makeDeps({
      backend,
      isInteractive: () => true,
      prompt: async (question) => {
        prompts.push(question);
        return answers.shift() ?? '';
      },
    });
    await handleSshAdd({ name: 'prod' }, deps);
    expect(prompts).toHaveLength(4);
    expect(added).toEqual([
      {
        name: 'prod',
        host: 'example.com',
        user: 'ubuntu',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
      },
    ]);
  });

  it('rejects a missing target when not interactive', async () => {
    const { deps } = makeDeps();
    await expect(handleSshAdd({ name: 'prod' }, deps)).rejects.toThrow(
      /missing target.*kimi ssh add <name>/,
    );
  });

  it('rejects invalid connection names with the schema message', async () => {
    const { deps } = makeDeps();
    await expect(
      handleSshAdd({ name: '-bad', target: 'example.com' }, deps),
    ).rejects.toThrow(/invalid ssh connection/);
  });
});

describe('kimi ssh list', () => {
  const connections: SshConnectionInfo[] = [
    {
      name: 'prod',
      host: 'example.com',
      user: 'ubuntu',
      port: 22,
      identityFile: undefined,
      hasPassword: undefined,
      status: { state: 'on', localOrigin: 'http://127.0.0.1:49001', error: undefined },
    },
    {
      name: 'staging',
      host: 'staging.internal',
      user: undefined,
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
      hasPassword: undefined,
      status: { state: 'error', localOrigin: undefined, error: 'permission denied' },
    },
    {
      name: 'offbox',
      host: '192.168.1.10',
      user: undefined,
      port: 22,
      identityFile: undefined,
      hasPassword: true,
      status: { state: 'off', localOrigin: undefined, error: undefined },
    },
  ];

  it('renders an aligned table with auth methods and live status', async () => {
    const { deps, io } = makeDeps({
      backend: fakeBackend({ list: async () => connections }),
      getLiveServer: async () => LIVE_SERVER,
    });
    await handleSshList(deps);
    const out = io.readStdout();
    expect(out).toContain('NAME');
    expect(out).toContain('TARGET');
    expect(out).toContain('AUTH');
    expect(out).toContain('prod');
    expect(out).toContain('ubuntu@example.com');
    expect(out).toContain('connected');
    expect(out).toContain('http://127.0.0.1:49001');
    expect(out).toContain('staging.internal:2222');
    expect(out).toContain('permission denied');
    expect(out).toContain('agent');
    expect(out).toContain('key');
    expect(out).toContain('password (saved)');
    expect(out).not.toContain('local registry only');
  });

  it('notes the local-only registry when no server is running', async () => {
    const { deps, io } = makeDeps({
      backend: fakeBackend({ list: async () => connections }),
    });
    await handleSshList(deps);
    expect(io.readStdout()).toContain('local registry only');
  });

  it('keeps header and data columns aligned when state cells are ANSI-colored', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const table = formatConnectionTable([
        {
          name: 'prod',
          host: 'example.com',
          user: 'ubuntu',
          port: 22,
          identityFile: undefined,
          status: { state: 'on', localOrigin: 'http://127.0.0.1:49001', error: undefined },
        },
      ]);
      const lines = table.split('\n').map((line) => stripAnsi(line));
      const header = lines[0]!;
      const row = lines[1]!;
      expect(header).toContain('ENDPOINT / ERROR');
      expect(row.indexOf('http://127.0.0.1:49001')).toBe(header.indexOf('ENDPOINT / ERROR'));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('prints an add hint when nothing is saved', async () => {
    const { deps, io } = makeDeps();
    await handleSshList(deps);
    const out = io.readStdout();
    expect(out).toContain('No SSH connections saved yet');
    expect(out).toContain('kimi ssh add <name> <[user@]host>');
  });
});

describe('formatAuthMethod', () => {
  it('derives the auth label from the identity file and saved-password marker', () => {
    expect(formatAuthMethod({})).toBe('agent');
    expect(formatAuthMethod({ identityFile: '~/.ssh/id_ed25519' })).toBe('key');
    expect(formatAuthMethod({ hasPassword: true })).toBe('password (saved)');
    expect(formatAuthMethod({ identityFile: '~/.ssh/id_ed25519', hasPassword: true })).toBe(
      'key + password (saved)',
    );
  });
});

describe('kimi ssh remove', () => {
  it('removes through the backend and confirms', async () => {
    const removed: string[] = [];
    const { deps, io } = makeDeps({
      backend: fakeBackend({
        remove: async (name) => {
          removed.push(name);
        },
      }),
    });
    await handleSshRemove({ name: 'prod' }, deps);
    expect(removed).toEqual(['prod']);
    expect(io.readStdout()).toContain('Removed ssh connection "prod".');
  });
});

describe('kimi ssh passwd', () => {
  it('saves a password entered via the hidden prompt', async () => {
    const saved: [string, string][] = [];
    const { deps, io, secrets } = makeDeps({
      backend: fakeBackend({
        setPassword: async (name, password) => {
          saved.push([name, password]);
        },
      }),
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
    });
    await handleSshPasswd({ name: 'prod' }, deps);
    expect(saved).toEqual([['prod', 's3cret']]);
    expect(secrets).toEqual(['Password for prod: ']);
    const out = io.readStdout();
    expect(out).toContain('Saved the password for ssh connection "prod"');
    expect(out).toContain(join('/tmp/kimi-ssh-test-home', 'ssh', 'secrets.json'));
    expect(out).toContain('kimi ssh test prod');
  });

  it('rejects setting a password when not interactive', async () => {
    const { deps } = makeDeps();
    await expect(handleSshPasswd({ name: 'prod' }, deps)).rejects.toThrow(/interactive terminal/);
  });

  it('rejects an empty password entry', async () => {
    const { deps } = makeDeps({
      isInteractive: () => true,
      secretAnswers: [''],
    });
    await expect(handleSshPasswd({ name: 'prod' }, deps)).rejects.toThrow(/no password entered/);
  });

  it('clears the saved password with --clear', async () => {
    const cleared: string[] = [];
    const { deps, io } = makeDeps({
      backend: fakeBackend({
        clearPassword: async (name) => {
          cleared.push(name);
        },
      }),
    });
    await handleSshPasswd({ name: 'prod', clear: true }, deps);
    expect(cleared).toEqual(['prod']);
    expect(io.readStdout()).toContain('Cleared the saved password for ssh connection "prod".');
  });
});

describe('kimi ssh test', () => {
  it('prints the remote bootstrap state on success', async () => {
    const { deps, io } = makeDeps({
      backend: fakeBackend({
        test: async () => ({
          ok: true,
          platform: 'linux-x64',
          kimiPath: '/home/ubuntu/.kimi-code/bin/kimi',
          serverRunning: false,
        }),
      }),
    });
    await handleSshTest({ name: 'prod' }, deps);
    const out = io.readStdout();
    expect(out).toContain('ssh connection "prod": OK');
    expect(out).toContain('linux-x64');
    expect(out).toContain('/home/ubuntu/.kimi-code/bin/kimi');
    expect(out).toContain('not running — it will be started on first connect');
  });

  it('fails with an actionable auth hint on permission errors', async () => {
    const { deps, io } = makeDeps({
      backend: fakeBackend({
        test: async () => ({ ok: false, error: 'ssh exited 255: Permission denied (publickey)' }),
      }),
    });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(/test failed/);
    const out = io.readStdout();
    expect(out).toContain('FAILED');
    expect(out).toContain('Permission denied');
    expect(out).toContain('ssh-add -l');
  });

  it('fails with a network hint on unreachable hosts', async () => {
    const { deps, io } = makeDeps({
      backend: fakeBackend({
        test: async () => ({ ok: false, error: 'ssh: Could not resolve hostname nope.internal' }),
      }),
    });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(/test failed/);
    expect(io.readStdout()).toContain('check the host name and your network');
  });

  it('prompts (hidden) and retries once when the probe needs a password', async () => {
    const auths: (SshAuthOptions | undefined)[] = [];
    const results: SshTestResult[] = [
      { ok: false, needsPassword: true, error: 'Permission denied (publickey,password).' },
      { ok: true, platform: 'linux-x64' },
    ];
    const { deps, io, secrets, confirms } = makeDeps({
      backend: fakeBackend({
        test: async (_name, auth) => {
          auths.push(auth);
          return results.shift() ?? { ok: false, error: 'unexpected extra attempt' };
        },
      }),
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
      confirmAnswers: [true],
    });
    await handleSshTest({ name: 'prod' }, deps);
    expect(auths).toEqual([undefined, { password: 's3cret', savePassword: true }]);
    expect(secrets).toEqual(['Password for prod: ']);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('secrets.json');
    expect(io.readStdout()).toContain('ssh connection "prod": OK');
  });

  it('fails with an actionable needs-password error when not interactive', async () => {
    const { deps } = makeDeps({
      backend: fakeBackend({
        test: async () => ({
          ok: false,
          needsPassword: true,
          error: 'Permission denied (publickey,password).',
        }),
      }),
    });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(/requires a password/);
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(
      /kimi ssh test prod --password/,
    );
  });

  it('tests with the password from --password without a passwordless attempt', async () => {
    const auths: (SshAuthOptions | undefined)[] = [];
    const { deps } = makeDeps({
      backend: fakeBackend({
        test: async (_name, auth) => {
          auths.push(auth);
          return { ok: true };
        },
      }),
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
      confirmAnswers: [false],
    });
    await handleSshTest({ name: 'prod', password: true }, deps);
    expect(auths).toEqual([{ password: 's3cret', savePassword: false }]);
  });

  it('does not re-prompt when a --password attempt still needs a password', async () => {
    const auths: (SshAuthOptions | undefined)[] = [];
    const { deps, io, secrets } = makeDeps({
      backend: fakeBackend({
        test: async (_name, auth) => {
          auths.push(auth);
          return { ok: false, needsPassword: true, error: 'Permission denied (password).' };
        },
      }),
      isInteractive: () => true,
      secretAnswers: ['wrong'],
      confirmAnswers: [false],
    });
    await expect(handleSshTest({ name: 'prod', password: true }, deps)).rejects.toThrow(
      /test failed/,
    );
    expect(auths).toEqual([{ password: 'wrong', savePassword: false }]);
    expect(secrets).toHaveLength(1);
    expect(io.readStdout()).toContain('kimi ssh passwd prod');
  });
});

describe('kimi ssh connect', () => {
  it('proxy mode: asks the server to connect and prints the kimi_origin URL', async () => {
    const connectCalls: string[] = [];
    const { deps, io, opened } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      backend: fakeBackend({
        list: async () => [
          {
            name: 'prod',
            host: 'example.com',
            user: 'ubuntu',
            port: 22,
            identityFile: undefined,
            status: { state: 'on', localOrigin: 'http://127.0.0.1:49001', error: undefined },
          },
        ],
        connect: async (name) => {
          connectCalls.push(name);
          return { localOrigin: 'http://127.0.0.1:49001' };
        },
      }),
    });
    await handleSshConnect({ name: 'prod', open: true }, deps);
    expect(connectCalls).toEqual(['prod']);
    const out = io.readStdout();
    expect(out).toContain('SSH connection ready: prod (ubuntu@example.com)');
    const expectedRemote =
      'http://127.0.0.1:58627/?kimi_origin=http://127.0.0.1:58627/ssh/prod#token=local-token';
    expect(out).toContain(expectedRemote);
    expect(out).toContain('http://127.0.0.1:58627/ssh#token=local-token');
    expect(opened).toEqual([expectedRemote]);
  });

  it('proxy mode: --no-open skips the browser', async () => {
    const { deps, opened } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
    });
    await handleSshConnect({ name: 'prod', open: false }, deps);
    expect(opened).toEqual([]);
  });

  it('proxy mode: needs-password prompts (hidden) and retries with the password', async () => {
    const auths: (SshAuthOptions | undefined)[] = [];
    const { deps, io, secrets } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      backend: fakeBackend({
        connect: async (_name, auth) => {
          auths.push(auth);
          if (auth === undefined) {
            throw new SshApiError(SSH_AUTH_REQUIRED_CODE, 'password required');
          }
          return { localOrigin: 'http://127.0.0.1:49001' };
        },
      }),
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
      confirmAnswers: [true],
    });
    await handleSshConnect({ name: 'prod', open: false }, deps);
    expect(auths).toEqual([undefined, { password: 's3cret', savePassword: true }]);
    expect(secrets).toEqual(['Password for prod: ']);
    expect(io.readStdout()).toContain('requires a password');
    expect(io.readStdout()).toContain('SSH connection ready: prod');
  });

  it('proxy mode: needs-password fails with an actionable error when not interactive', async () => {
    const { deps } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      backend: fakeBackend({
        connect: async () => {
          throw new SshApiError(SSH_AUTH_REQUIRED_CODE, 'password required');
        },
      }),
    });
    await expect(handleSshConnect({ name: 'prod', open: false }, deps)).rejects.toThrow(
      /requires a password/,
    );
    await expect(handleSshConnect({ name: 'prod', open: false }, deps)).rejects.toThrow(
      /kimi ssh passwd prod/,
    );
  });

  it('proxy mode: --password connects with the entered password directly', async () => {
    const auths: (SshAuthOptions | undefined)[] = [];
    const { deps } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      backend: fakeBackend({
        connect: async (_name, auth) => {
          auths.push(auth);
          return { localOrigin: 'http://127.0.0.1:49001' };
        },
      }),
      isInteractive: () => true,
      secretAnswers: ['s3cret'],
      confirmAnswers: [true],
    });
    await handleSshConnect({ name: 'prod', open: false, password: true }, deps);
    expect(auths).toEqual([{ password: 's3cret', savePassword: true }]);
  });

  it('direct mode: holds the tunnel in-process and prints the remote token URL', async () => {
    let closed = false;
    let held = false;
    const handle: SshConnectionHandle = {
      localOrigin: 'http://127.0.0.1:49001',
      remoteToken: 'remote-token',
    };
    const manager = {
      list: async () => [],
      add: async () => {
        throw new Error('unexpected');
      },
      remove: async () => {},
      test: async () => ({ ok: true }),
      connect: async () => handle,
      disconnect: async () => {},
      setPassword: async () => {},
      clearPassword: async () => {},
      scanHostKey: async () => ({ host: 'example.com', port: 22, keys: [] }),
      forgetHostKey: async () => {},
      status: () => ({ state: 'on' as const, localOrigin: handle.localOrigin }),
      close: async () => {
        closed = true;
      },
    } satisfies SshConnectionManager;
    const { deps, io, opened } = makeDeps({
      createLocalManager: () => manager,
      holdForeground: async (onShutdown) => {
        held = true;
        await onShutdown('test');
      },
    });
    await handleSshConnect({ name: 'prod', open: true }, deps);
    const out = io.readStdout();
    expect(out).toContain('SSH tunnel established: prod');
    expect(out).toContain('http://127.0.0.1:49001/#token=remote-token');
    expect(out).toContain('Ctrl+C');
    expect(opened).toEqual(['http://127.0.0.1:49001/#token=remote-token']);
    expect(held).toBe(true);
    expect(closed).toBe(true);
  });

  it('--direct bypasses a live server', async () => {
    let restUsed = false;
    const manager = {
      list: async () => [],
      add: async () => {
        throw new Error('unexpected');
      },
      remove: async () => {},
      test: async () => ({ ok: true }),
      connect: async () => ({
        localOrigin: 'http://127.0.0.1:49001',
        remoteToken: 'remote-token',
      }),
      disconnect: async () => {},
      setPassword: async () => {},
      clearPassword: async () => {},
      scanHostKey: async () => ({ host: 'example.com', port: 22, keys: [] }),
      forgetHostKey: async () => {},
      status: () => ({ state: 'off' as const }),
      close: async () => {},
    } satisfies SshConnectionManager;
    const { deps } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      createRestClient: () => {
        restUsed = true;
        throw new Error('must not use REST in --direct mode');
      },
      createLocalManager: () => manager,
      holdForeground: async () => {},
    });
    await handleSshConnect({ name: 'prod', direct: true, open: false }, deps);
    expect(restUsed).toBe(false);
  });
});

describe('hidden-echo secret prompt', () => {
  function fakeTty(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream; written: () => string } {
    const stream = new PassThrough();
    let raw = false;
    let out = '';
    const input = Object.assign(stream, {
      isRaw: raw,
      setRawMode: (value: boolean) => {
        raw = value;
      },
    }) as unknown as NodeJS.ReadStream;
    const output = {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { input, output, written: () => out };
  }

  it('reads a line without echo and restores raw mode', async () => {
    const { input, output, written } = fakeTty();
    const pending = readSecretLine({ input, output }, 'Password: ');
    input.write('s3cr');
    input.write('et');
    input.write('\u007F');
    input.write('t!');
    input.write('\r');
    await expect(pending).resolves.toBe('s3cret!');
    expect(written()).toBe('Password: \n');
  });

  it('resolves empty on immediate enter', async () => {
    const { input, output } = fakeTty();
    const pending = readSecretLine({ input, output }, 'Password: ');
    input.write('\r');
    await expect(pending).resolves.toBe('');
  });

  it('rejects on Ctrl+C', async () => {
    const { input, output } = fakeTty();
    const pending = readSecretLine({ input, output }, 'Password: ');
    input.write('\u0003');
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it('rejects when the input is not a TTY', async () => {
    const { output } = fakeTty();
    await expect(
      readSecretLine({ input: new PassThrough() as unknown as NodeJS.ReadStream, output }, 'Password: '),
    ).rejects.toThrow(/interactive terminal/);
  });
});

describe('formatNeedsPasswordError', () => {
  it('points at the interactive flag, passwd, and key-based auth', () => {
    const message = formatNeedsPasswordError('prod', 'connect');
    expect(message).toContain('kimi ssh connect prod --password');
    expect(message).toContain('kimi ssh passwd prod');
    expect(message).toContain('ssh-add');
  });
});

describe('url builders', () => {
  it('builds the proxy entry URL with token fragment', () => {
    expect(buildSshProxyUrl('http://127.0.0.1:58627', 'prod', 'tok')).toBe(
      'http://127.0.0.1:58627/?kimi_origin=http://127.0.0.1:58627/ssh/prod#token=tok',
    );
  });

  it('omits the fragment when auth is bypassed', () => {
    expect(buildSshProxyUrl('http://127.0.0.1:58627/', 'prod', undefined)).toBe(
      'http://127.0.0.1:58627/?kimi_origin=http://127.0.0.1:58627/ssh/prod',
    );
  });

  it('builds the direct URL from the tunnel origin and remote token', () => {
    expect(buildSshDirectUrl('http://127.0.0.1:49001', 'rtok')).toBe(
      'http://127.0.0.1:49001/#token=rtok',
    );
  });

  it('builds the /ssh management page URL with the token fragment', () => {
    expect(buildSshManageUrl('http://127.0.0.1:58627', 'tok')).toBe(
      'http://127.0.0.1:58627/ssh#token=tok',
    );
    expect(buildSshManageUrl('http://127.0.0.1:58627/', undefined)).toBe(
      'http://127.0.0.1:58627/ssh',
    );
  });
});

describe('sshErrorHint', () => {
  it('maps auth failures to key-check guidance', () => {
    expect(sshErrorHint(new SshRemoteError('auth', 'denied'))).toContain('ssh-add -l');
  });

  it('maps network failures to connectivity guidance', () => {
    expect(sshErrorHint(new SshRemoteError('host-unreachable', 'no route'))).toContain(
      'network connection',
    );
  });

  it('maps REST not-found to add/list guidance', () => {
    expect(sshErrorHint(new SshApiError(40421, 'not found'))).toContain('kimi ssh list');
  });

  it('returns undefined for unknown errors', () => {
    expect(sshErrorHint(new Error('boom'))).toBeUndefined();
  });
});

describe('ssh REST client', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function fakeFetch(
    handler: (url: string, init: RequestInit) => Promise<Response>,
  ): typeof fetch {
    return handler as unknown as typeof fetch;
  }

  function envelope<T>(data: T, code = 0, msg = 'success'): unknown {
    return { code, msg, data, request_id: 'req-1' };
  }

  it('unwraps the envelope and maps snake_case connections', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(
          envelope({
            connections: [
              {
                name: 'prod',
                host: 'example.com',
                user: 'ubuntu',
                port: 22,
                identity_file: '~/.ssh/id_ed25519',
                has_password: true,
                status: { state: 'on', local_origin: 'http://127.0.0.1:49001' },
              },
            ],
          }),
        );
      }),
    });
    const list = await client.list();
    expect(list).toEqual([
      {
        name: 'prod',
        host: 'example.com',
        user: 'ubuntu',
        port: 22,
        identityFile: '~/.ssh/id_ed25519',
        hasPassword: true,
        status: { state: 'on', localOrigin: 'http://127.0.0.1:49001', error: undefined },
      },
    ]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:58627/api/v1/ssh/connections');
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('posts snake_case add bodies and unwraps the created connection', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(
          envelope({
            name: 'prod',
            host: 'example.com',
            user: 'ubuntu',
            port: 2222,
            status: { state: 'off' },
          }),
        );
      }),
    });
    const info = await client.add({
      name: 'prod',
      host: 'example.com',
      user: 'ubuntu',
      port: 2222,
      identityFile: undefined,
    });
    expect(info.port).toBe(2222);
    expect(info.status.state).toBe('off');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      name: 'prod',
      host: 'example.com',
      user: 'ubuntu',
      port: 2222,
    });
  });

  it('maps test and connect payloads', async () => {
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url) => {
        if (url.endsWith('/test')) {
          return jsonResponse(
            envelope({ ok: true, platform: 'linux-x64', kimi_path: '/k/bin/kimi', server_running: true }),
          );
        }
        return jsonResponse(envelope({ local_origin: 'http://127.0.0.1:49001' }));
      }),
    });
    const test = await client.test('prod');
    expect(test).toEqual({
      ok: true,
      platform: 'linux-x64',
      kimiPath: '/k/bin/kimi',
      serverRunning: true,
      error: undefined,
      needsPassword: undefined,
    });
    expect(await client.connect('prod')).toEqual({ localOrigin: 'http://127.0.0.1:49001' });
  });

  it('sends password attempts as snake_case bodies on test and connect', async () => {
    const bodies: unknown[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url, init) => {
        bodies.push(init.body === undefined ? undefined : JSON.parse(init.body as string));
        if (url.endsWith('/test')) {
          return jsonResponse(envelope({ ok: false, needs_password: true, error: 'denied' }));
        }
        return jsonResponse(envelope({ local_origin: 'http://127.0.0.1:49001' }));
      }),
    });
    const auth: SshAuthOptions = { password: 's3cret', savePassword: true };
    const test = await client.test('prod', auth);
    expect(test).toEqual({
      ok: false,
      platform: undefined,
      kimiPath: undefined,
      serverRunning: undefined,
      error: 'denied',
      needsPassword: true,
    });
    await client.connect('prod', auth);
    expect(bodies).toEqual([
      { password: 's3cret', save_password: true },
      { password: 's3cret', save_password: true },
    ]);
  });

  it('sends no body on test and connect when no password attempt is given', async () => {
    const inits: RequestInit[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url, init) => {
        inits.push(init);
        if (url.endsWith('/test')) {
          return jsonResponse(envelope({ ok: true }));
        }
        return jsonResponse(envelope({ local_origin: 'http://127.0.0.1:49001' }));
      }),
    });
    await client.test('prod');
    await client.connect('prod');
    expect(inits.map((init) => init.body)).toEqual([undefined, undefined]);
    expect(inits.map((init) => (init.headers as Record<string, string>)['Content-Type'])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('posts and deletes saved passwords on the password endpoint', async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url, init) => {
        calls.push({
          url,
          method: init.method,
          body: init.body === undefined ? undefined : JSON.parse(init.body as string),
        });
        return jsonResponse(envelope({}));
      }),
    });
    await client.setPassword('prod', 's3cret');
    await client.clearPassword('prod');
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:58627/api/v1/ssh/connections/prod/password',
        method: 'PUT',
        body: { password: 's3cret' },
      },
      {
        url: 'http://127.0.0.1:58627/api/v1/ssh/connections/prod/password',
        method: 'DELETE',
        body: undefined,
      },
    ]);
  });

  it('sends no JSON content-type on bodyless requests', async () => {
    const seen: Record<string, string>[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (_url, init) => {
        seen.push((init.headers ?? {}) as Record<string, string>);
        return jsonResponse(envelope({ name: 'prod' }));
      }),
    });
    await client.remove('prod');
    expect(seen[0]?.['Authorization']).toBe('Bearer tok');
    expect(seen[0]?.['Content-Type']).toBeUndefined();
  });

  it('raises SshApiError with the server error code on failure envelopes', async () => {
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async () =>
        jsonResponse({ code: 40421, msg: 'ssh connection "nope" not found', data: null, request_id: 'r' }, 404),
      ),
    });
    const failure = await client.connect('nope').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshApiError);
    expect((failure as SshApiError).code).toBe(40421);
    expect((failure as SshApiError).message).toContain('not found');
  });

  it('raises a reachability error when fetch itself fails', async () => {
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      fetchFn: fakeFetch(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    const failure = await client.list().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshApiError);
    expect((failure as SshApiError).message).toContain('cannot reach the local server');
  });
});

describe('local registry integration (temp home, no server)', () => {
  let homeDir: string;

  const fakeRunner: ProcessRunner = {
    run: async () => ({ code: 255, stdout: '', stderr: 'Permission denied (publickey).' }),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  };

  function makeLocalDeps(io: ReturnType<typeof makeIo>): SshCommandDeps {
    return {
      homeDir,
      getLiveServer: async () => undefined,
      resolveToken: () => undefined,
      createRestClient: () => {
        throw new Error('no server in this test');
      },
      createLocalManager: () => createSshConnectionManager({ homeDir, runner: fakeRunner }),
      openUrl: () => {},
      prompt: async () => '',
      promptSecret: async () => '',
      confirm: async () => false,
      isInteractive: () => false,
      holdForeground: async () => {},
      stdout: io.stdout,
      stderr: io.stderr,
    };
  }

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-ssh-cli-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('add/list/remove round-trip through the real local manager', async () => {
    const io = makeIo();
    const deps = makeLocalDeps(io);
    await handleSshAdd(
      { name: 'prod', target: 'ubuntu@example.com', port: '2222', identityFile: '~/.ssh/id' },
      deps,
    );
    await handleSshList(deps);
    const out = io.readStdout();
    expect(out).toContain('prod');
    expect(out).toContain('ubuntu@example.com:2222');
    expect(out).toContain('key');
    await handleSshRemove({ name: 'prod' }, deps);
    await handleSshList(deps);
    expect(io.readStdout()).toContain('No SSH connections saved yet');
  });

  it('rejects duplicates with an actionable message', async () => {
    const io = makeIo();
    const deps = makeLocalDeps(io);
    await handleSshAdd({ name: 'prod', target: 'example.com' }, deps);
    await expect(handleSshAdd({ name: 'prod', target: 'example.com' }, deps)).rejects.toThrow(
      /already exists/,
    );
  });

  it('passwd set/clear round-trip through the real local secrets store', async () => {
    const io = makeIo();
    const deps = makeLocalDeps(io);
    await handleSshAdd({ name: 'prod', target: 'example.com' }, deps);
    await handleSshPasswd(
      { name: 'prod' },
      { ...deps, isInteractive: () => true, promptSecret: async () => 's3cret' },
    );
    const secretsPath = join(homeDir, 'ssh', 'secrets.json');
    const stored = JSON.parse(readFileSync(secretsPath, 'utf8')) as {
      passwords: Record<string, string>;
    };
    expect(stored.passwords['prod']).toBe('s3cret');
    await handleSshList(deps);
    expect(io.readStdout()).toContain('password (saved)');
    await handleSshPasswd({ name: 'prod', clear: true }, deps);
    const cleared = JSON.parse(readFileSync(secretsPath, 'utf8')) as {
      passwords: Record<string, string>;
    };
    expect(cleared.passwords['prod']).toBeUndefined();
  });

  it('remove cascades the saved password', async () => {
    const io = makeIo();
    const deps = makeLocalDeps(io);
    await handleSshAdd({ name: 'prod', target: 'example.com' }, deps);
    await handleSshPasswd(
      { name: 'prod' },
      { ...deps, isInteractive: () => true, promptSecret: async () => 's3cret' },
    );
    await handleSshRemove({ name: 'prod' }, deps);
    const cleared = JSON.parse(
      readFileSync(join(homeDir, 'ssh', 'secrets.json'), 'utf8'),
    ) as { passwords: Record<string, string> };
    expect(cleared.passwords['prod']).toBeUndefined();
  });
});
