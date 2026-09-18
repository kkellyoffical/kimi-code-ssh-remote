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
  SSH_HOST_KEY_CHANGED_CODE,
  SshApiError,
  type SshBackend,
} from '#/cli/sub/ssh/client';
import {
  buildSshDirectUrl,
  buildSshManageUrl,
  buildSshProxyUrl,
  formatAuthMethod,
  formatConnectionTable,
  formatHostKeyChangedWarning,
  formatNeedsPasswordError,
  sshErrorHint,
} from '#/cli/sub/ssh/format';
import {
  extractHostKeyChangedDetails,
  hostKeyChangedFromTestResult,
  isHostKeyChangedError,
} from '#/cli/sub/ssh/host-key';
import {
  handleSshAdd,
  handleSshConnect,
  handleSshHostKey,
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
    scanHostKey: async () => ({ host: 'example.com', port: 22, keys: [] }),
    forgetHostKey: async () => {},
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
      'host-key',
      'list',
      'passwd',
      'remove',
      'test',
    ]);
  });

  it('exposes the documented options on add, passwd, test, connect, and host-key', () => {
    const program = new Command('kimi').exitOverride();
    registerSshCommand(program);
    const ssh = program.commands.find((command) => command.name() === 'ssh');
    const add = ssh?.commands.find((command) => command.name() === 'add');
    const passwd = ssh?.commands.find((command) => command.name() === 'passwd');
    const test = ssh?.commands.find((command) => command.name() === 'test');
    const connect = ssh?.commands.find((command) => command.name() === 'connect');
    const hostKey = ssh?.commands.find((command) => command.name() === 'host-key');
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
    expect(hostKey?.options.map((option) => option.long)).toEqual(['--forget']);
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

describe('kimi ssh host-key', () => {
  const savedProd: SshConnectionInfo = {
    name: 'prod',
    host: 'example.com',
    user: 'ubuntu',
    port: 22,
    identityFile: undefined,
    status: { state: 'off' },
  };

  it('prints every fingerprint the remote currently presents', async () => {
    const backend = fakeBackend({
      list: async () => [savedProd],
      scanHostKey: async () => ({
        host: 'example.com',
        port: 22,
        keys: [
          { keyType: 'ssh-ed25519', fingerprint: 'SHA256:EdKey111' },
          { keyType: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:EcKey222' },
        ],
      }),
    });
    const { deps, io } = makeDeps({ backend });
    await handleSshHostKey({ name: 'prod' }, deps);
    const out = io.readStdout();
    expect(out).toContain('ubuntu@example.com');
    expect(out).toContain('ssh-ed25519');
    expect(out).toContain('SHA256:EdKey111');
    expect(out).toContain('ecdsa-sha2-nistp256');
    expect(out).toContain('SHA256:EcKey222');
    expect(out).toContain('accept-new');
  });

  it('--forget removes the stored key and points at re-verification', async () => {
    const forgotten: string[] = [];
    const backend = fakeBackend({
      list: async () => [savedProd],
      forgetHostKey: async (name) => {
        forgotten.push(name);
      },
    });
    const { deps, io } = makeDeps({ backend });
    await handleSshHostKey({ name: 'prod', forget: true }, deps);
    expect(forgotten).toEqual(['prod']);
    const out = io.readStdout();
    expect(out).toContain('Removed the stored host key for ssh connection "prod"');
    expect(out).toContain('kimi ssh host-key prod');
  });

  it('fails when the scan finds no host key', async () => {
    const { deps } = makeDeps();
    await expect(handleSshHostKey({ name: 'prod' }, deps)).rejects.toThrow(/no host key found/);
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

describe('host-key-changed handling', () => {
  const SSH_CHANGED_STDERR = [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
    'The fingerprint for the ED25519 key sent by the remote host is',
    'SHA256:NewKeyFingerprintExample0000000000000000000000.',
    'Please contact your system administrator.',
    'Add correct host key in /home/user/.ssh/known_hosts to get rid of this message.',
    'Offending ED25519 key in /home/user/.ssh/known_hosts:12',
    'Host key for example.com has changed and you have requested strict checking.',
    'Host key verification failed.',
  ].join('\n');

  const STORED_FINGERPRINT = 'SHA256:J8jFK3DyrmnwzAe9O2AbJDJmuwEimCKoRkyR4G1GdOU';
  const PRESENTED_FINGERPRINT = 'SHA256:NewKeyFingerprintExample0000000000000000000000';
  const HOST_KEY = {
    host: 'example.com',
    port: 22,
    fingerprint: PRESENTED_FINGERPRINT,
    keyType: 'ssh-ed25519',
    expectedFingerprint: STORED_FINGERPRINT,
    knownHostsFile: '/home/user/.ssh/known_hosts',
    knownHostsLine: 12,
  };

  function hostKeyChangedError(): SshRemoteError {
    return new SshRemoteError('host-key-changed', 'Host key verification failed.', {
      stderr: SSH_CHANGED_STDERR,
      hostKey: HOST_KEY,
    });
  }

  it('test: warns with the fingerprint comparison, forgets on confirm, and retries', async () => {
    const attempts: (SshAuthOptions | undefined)[] = [];
    let forgotten = 0;
    const backend = fakeBackend({
      test: async (_name, auth) => {
        attempts.push(auth);
        if (attempts.length === 1) throw hostKeyChangedError();
        return { ok: true, platform: 'linux-x64' };
      },
      forgetHostKey: async () => {
        forgotten += 1;
      },
    });
    const { deps, io, confirms } = makeDeps({
      backend,
      isInteractive: () => true,
      confirmAnswers: [true],
    });
    await handleSshTest({ name: 'prod' }, deps);
    expect(attempts).toHaveLength(2);
    expect(forgotten).toBe(1);
    const out = io.readStdout();
    expect(out).toContain('has changed');
    expect(out).toContain(`Stored fingerprint:     ${STORED_FINGERPRINT}`);
    expect(out).toContain(`Presented fingerprint:  ${PRESENTED_FINGERPRINT}`);
    expect(out).toContain('/home/user/.ssh/known_hosts:12');
    expect(out).toContain('man-in-the-middle');
    expect(out).toContain('retrying');
    expect(out).toContain('ssh connection "prod": OK');
    expect(confirms[0]).toContain('Remove the old host key and retry?');
  });

  it('test: resolves a hostKey failure folded into the result (local manager shape)', async () => {
    let attempts = 0;
    let forgotten = 0;
    const backend = fakeBackend({
      test: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, error: 'Host key verification failed.', hostKey: HOST_KEY };
        }
        return { ok: true, platform: 'linux-x64' };
      },
      forgetHostKey: async () => {
        forgotten += 1;
      },
    });
    const { deps, io } = makeDeps({
      backend,
      isInteractive: () => true,
      confirmAnswers: [true],
    });
    await handleSshTest({ name: 'prod' }, deps);
    expect(attempts).toBe(2);
    expect(forgotten).toBe(1);
    const out = io.readStdout();
    expect(out).toContain(`Presented fingerprint:  ${PRESENTED_FINGERPRINT}`);
    expect(out).toContain('ssh connection "prod": OK');
  });

  it('test: aborts without forgetting when the user declines', async () => {
    let forgotten = 0;
    const backend = fakeBackend({
      test: async () => {
        throw hostKeyChangedError();
      },
      forgetHostKey: async () => {
        forgotten += 1;
      },
    });
    const { deps } = makeDeps({
      backend,
      isInteractive: () => true,
      confirmAnswers: [false],
    });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(/left unchanged/);
    expect(forgotten).toBe(0);
  });

  it('test: fails with the forget command and ssh-keygen -R when not interactive', async () => {
    let forgotten = 0;
    const backend = fakeBackend({
      list: async () => [
        { name: 'prod', host: 'example.com', user: 'ubuntu', port: 2222, status: { state: 'off' } },
      ],
      test: async () => {
        throw hostKeyChangedError();
      },
      forgetHostKey: async () => {
        forgotten += 1;
      },
    });
    const { deps } = makeDeps({ backend });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(
      /kimi ssh host-key prod --forget/,
    );
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(
      /ssh-keygen -R \[example\.com\]:2222/,
    );
    expect(forgotten).toBe(0);
  });

  it('connect (proxy): resolves a REST 40931 with the details fingerprints and retries', async () => {
    let attempts = 0;
    let forgotten = 0;
    const backend = fakeBackend({
      connect: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new SshApiError(SSH_HOST_KEY_CHANGED_CODE, 'host key for example.com:22 has changed', {
            host: 'example.com',
            port: 22,
            fingerprint: PRESENTED_FINGERPRINT,
            key_type: 'ssh-ed25519',
            expected_fingerprint: STORED_FINGERPRINT,
            known_hosts_file: '/home/user/.ssh/known_hosts',
            known_hosts_line: 12,
          });
        }
        return { localOrigin: 'http://127.0.0.1:49001' };
      },
      forgetHostKey: async () => {
        forgotten += 1;
      },
    });
    const { deps, io } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      backend,
      isInteractive: () => true,
      confirmAnswers: [true],
    });
    await handleSshConnect({ name: 'prod', open: false }, deps);
    expect(attempts).toBe(2);
    expect(forgotten).toBe(1);
    const out = io.readStdout();
    expect(out).toContain(`Stored fingerprint:     ${STORED_FINGERPRINT}`);
    expect(out).toContain(`Presented fingerprint:  ${PRESENTED_FINGERPRINT}`);
    expect(out).toContain('SSH connection ready: prod');
  });

  it('connect (direct): forgets and re-trusts through the local manager', async () => {
    let attempts = 0;
    let forgotten = 0;
    const manager = {
      list: async () => [],
      add: async () => {
        throw new Error('unexpected');
      },
      remove: async () => {},
      test: async () => ({ ok: true }),
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw hostKeyChangedError();
        return { localOrigin: 'http://127.0.0.1:49001', remoteToken: 'remote-token' };
      },
      disconnect: async () => {},
      setPassword: async () => {},
      clearPassword: async () => {},
      scanHostKey: async () => ({ host: 'example.com', port: 22, keys: [] }),
      forgetHostKey: async () => {
        forgotten += 1;
      },
      status: () => ({ state: 'on' as const, localOrigin: 'http://127.0.0.1:49001' }),
      close: async () => {},
    } satisfies SshConnectionManager;
    const { deps, io } = makeDeps({
      createLocalManager: () => manager,
      isInteractive: () => true,
      confirmAnswers: [true],
      holdForeground: async () => {},
    });
    await handleSshConnect({ name: 'prod', direct: true, open: false }, deps);
    expect(attempts).toBe(2);
    expect(forgotten).toBe(1);
    expect(io.readStdout()).toContain('SSH tunnel established: prod');
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

describe('host-key helpers', () => {
  const HOST_KEY = {
    host: 'example.com',
    port: 22,
    fingerprint: 'SHA256:New',
    keyType: 'ssh-ed25519',
    expectedFingerprint: 'SHA256:Old',
    knownHostsFile: '/home/user/.ssh/known_hosts',
    knownHostsLine: 12,
  };

  it('detects host-key-changed across the local and REST backends', () => {
    const local = new SshRemoteError('host-key-changed', 'changed', { hostKey: HOST_KEY });
    expect(isHostKeyChangedError(local)).toBe(true);
    expect(isHostKeyChangedError(new SshApiError(SSH_HOST_KEY_CHANGED_CODE, 'changed'))).toBe(true);
    expect(isHostKeyChangedError(new SshRemoteError('auth', 'denied'))).toBe(false);
    expect(isHostKeyChangedError(new SshApiError(SSH_AUTH_REQUIRED_CODE, 'password'))).toBe(false);
    expect(isHostKeyChangedError(new Error('boom'))).toBe(false);
  });

  it('extracts the comparison details from a REST 40931 envelope', () => {
    const error = new SshApiError(SSH_HOST_KEY_CHANGED_CODE, 'changed', {
      fingerprint: 'SHA256:New',
      key_type: 'ssh-ed25519',
      expected_fingerprint: 'SHA256:Old',
      known_hosts_file: '/home/user/.ssh/known_hosts',
      known_hosts_line: 12,
    });
    expect(extractHostKeyChangedDetails(error)).toEqual({
      presented: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:New' },
      storedFingerprint: 'SHA256:Old',
      offending: { file: '/home/user/.ssh/known_hosts', line: 12 },
    });
    expect(extractHostKeyChangedDetails(new SshApiError(SSH_HOST_KEY_CHANGED_CODE, 'changed'))).toEqual(
      {},
    );
  });

  it('extracts the comparison details from a local error hostKey payload', () => {
    const local = new SshRemoteError('host-key-changed', 'changed', { hostKey: HOST_KEY });
    expect(extractHostKeyChangedDetails(local)).toEqual({
      presented: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:New' },
      storedFingerprint: 'SHA256:Old',
      offending: { file: '/home/user/.ssh/known_hosts', line: 12 },
    });
    expect(
      extractHostKeyChangedDetails(new SshRemoteError('host-key-changed', 'changed')),
    ).toEqual({});
  });

  it('reads the host-key-changed case out of a folded test result', () => {
    expect(hostKeyChangedFromTestResult({ ok: false, hostKey: HOST_KEY })).toEqual({
      presented: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:New' },
      storedFingerprint: 'SHA256:Old',
      offending: { file: '/home/user/.ssh/known_hosts', line: 12 },
    });
    expect(hostKeyChangedFromTestResult({ ok: true, hostKey: HOST_KEY })).toBeUndefined();
    expect(hostKeyChangedFromTestResult({ ok: false })).toBeUndefined();
  });
});

describe('formatHostKeyChangedWarning', () => {
  it('lays out the stored and presented fingerprints for comparison', () => {
    const warning = stripAnsi(
      formatHostKeyChangedWarning({
        name: 'prod',
        target: 'ubuntu@example.com',
        presented: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:New' },
        storedFingerprint: 'SHA256:Old',
        offending: { file: '/home/user/.ssh/known_hosts', line: 12 },
      }),
    );
    expect(warning).toContain('prod');
    expect(warning).toContain('ubuntu@example.com');
    expect(warning).toContain('Stored fingerprint:     SHA256:Old');
    expect(warning).toContain('Presented fingerprint:  SHA256:New');
    expect(warning).toContain('/home/user/.ssh/known_hosts:12');
    expect(warning).toContain('man-in-the-middle');
  });

  it('degrades to the known_hosts location when the stored fingerprint is unreadable', () => {
    const warning = stripAnsi(
      formatHostKeyChangedWarning({
        name: 'prod',
        target: 'ubuntu@example.com',
        offending: { file: '/home/user/.ssh/known_hosts', line: 12 },
      }),
    );
    expect(warning).toContain('Stored key:             /home/user/.ssh/known_hosts:12');
    expect(warning).not.toContain('Presented fingerprint');
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

  it('maps host-key-changed to the host-key command on both backends', () => {
    expect(sshErrorHint(new SshApiError(SSH_HOST_KEY_CHANGED_CODE, 'changed'))).toContain(
      'kimi ssh host-key <name> --forget',
    );
    expect(sshErrorHint(new SshRemoteError('host-key-changed', 'changed'))).toContain(
      'kimi ssh host-key <name> --forget',
    );
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

  it('scans and forgets host keys on the host-key/forget endpoint', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async (url, init) => {
        calls.push({ url, method: init.method });
        if (init.method === 'GET') {
          return jsonResponse(
            envelope({
              name: 'prod',
              host: 'example.com',
              port: 2222,
              keys: [
                { key_type: 'ssh-ed25519', fingerprint: 'SHA256:EdKey111' },
                { key_type: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:EcKey222' },
              ],
            }),
          );
        }
        return jsonResponse(envelope({ name: 'prod', forgotten: true }));
      }),
    });
    const scan = await client.scanHostKey('prod');
    expect(scan).toEqual({
      host: 'example.com',
      port: 2222,
      keys: [
        { keyType: 'ssh-ed25519', fingerprint: 'SHA256:EdKey111' },
        { keyType: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:EcKey222' },
      ],
    });
    await client.forgetHostKey('prod');
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:58627/api/v1/ssh/connections/prod/host-key/forget',
        method: 'GET',
      },
      {
        url: 'http://127.0.0.1:58627/api/v1/ssh/connections/prod/host-key/forget',
        method: 'POST',
      },
    ]);
  });

  it('carries the 40931 envelope details on SshApiError', async () => {
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async () =>
        jsonResponse(
          {
            code: 40931,
            msg: 'host key for example.com:22 has changed',
            data: null,
            request_id: 'r',
            details: {
              host: 'example.com',
              port: 22,
              fingerprint: 'SHA256:New',
              key_type: 'ssh-ed25519',
              expected_fingerprint: 'SHA256:Old',
              known_hosts_file: '/home/user/.ssh/known_hosts',
              known_hosts_line: 12,
            },
          },
          409,
        ),
      ),
    });
    const failure = await client.connect('prod').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshApiError);
    expect((failure as SshApiError).code).toBe(SSH_HOST_KEY_CHANGED_CODE);
    expect((failure as SshApiError).details).toMatchObject({
      fingerprint: 'SHA256:New',
      expected_fingerprint: 'SHA256:Old',
      known_hosts_line: 12,
    });
  });

  it('maps a host_key payload on a failed test result', async () => {
    const client = createSshRestClient({
      origin: 'http://127.0.0.1:58627',
      token: 'tok',
      fetchFn: fakeFetch(async () =>
        jsonResponse(
          envelope({
            ok: false,
            error: 'Host key verification failed.',
            host_key: {
              host: 'example.com',
              port: 22,
              fingerprint: 'SHA256:New',
              key_type: 'ssh-ed25519',
              expected_fingerprint: 'SHA256:Old',
              known_hosts_file: '/home/user/.ssh/known_hosts',
              known_hosts_line: 12,
            },
          }),
        ),
      ),
    });
    const result = await client.test('prod');
    expect(result.ok).toBe(false);
    expect(result.hostKey).toEqual({
      host: 'example.com',
      port: 22,
      fingerprint: 'SHA256:New',
      keyType: 'ssh-ed25519',
      expectedFingerprint: 'SHA256:Old',
      knownHostsFile: '/home/user/.ssh/known_hosts',
      knownHostsLine: 12,
    });
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

  it('host-key scan/forget round-trip through the real local manager', async () => {
    const removedTargets: string[] = [];
    const runner: ProcessRunner = {
      run: async (argv) => {
        if (argv[0] === 'ssh-keyscan') {
          return {
            code: 0,
            stdout:
              'example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7Yq+xMZ+0k0k0k0k0k0k0k0k0k0k0k0k0k0k0k0k0x\n',
            stderr: '',
          };
        }
        if (argv[0] === 'ssh-keygen') {
          removedTargets.push(argv[2] ?? '');
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
      },
      spawn: () => {
        throw new Error('unexpected spawn');
      },
    };
    const io = makeIo();
    const deps = {
      ...makeLocalDeps(io),
      createLocalManager: () => createSshConnectionManager({ homeDir, runner }),
    };
    await handleSshAdd({ name: 'prod', target: 'example.com' }, deps);
    await handleSshHostKey({ name: 'prod' }, deps);
    const out = io.readStdout();
    expect(out).toContain('ssh-ed25519');
    expect(out).toContain('SHA256:J8jFK3DyrmnwzAe9O2AbJDJmuwEimCKoRkyR4G1GdOU');
    await handleSshHostKey({ name: 'prod', forget: true }, deps);
    expect(removedTargets).toEqual(['example.com']);
    expect(io.readStdout()).toContain('Removed the stored host key for ssh connection "prod"');
  });
});
