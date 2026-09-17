/**
 * Tests for the `kimi ssh` command tree and its REST client.
 *
 * No real server, registry, or ssh binary is involved: handlers run against
 * injected deps (fake REST backend / fake manager), the REST client runs
 * against a fake fetch, and local-mode add/list/remove use a real
 * `createSshConnectionManager` pointed at a temp home (those operations never
 * spawn ssh).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerInstanceInfo } from '@moonshot-ai/kap-server';
import {
  SshRemoteError,
  type SshConnectionHandle,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';
import chalk from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSshCommand } from '#/cli/sub/ssh';
import { createSshRestClient, SshApiError, type SshBackend } from '#/cli/sub/ssh/client';
import {
  buildSshDirectUrl,
  buildSshManageUrl,
  buildSshProxyUrl,
  formatConnectionTable,
  sshErrorHint,
} from '#/cli/sub/ssh/format';
import {
  handleSshAdd,
  handleSshConnect,
  handleSshList,
  handleSshRemove,
  handleSshTest,
  type SshCommandDeps,
} from '#/cli/sub/ssh/run';

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

interface DepOverrides extends Partial<SshCommandDeps> {
  backend?: SshBackend;
}

function makeDeps(overrides: DepOverrides = {}): {
  deps: SshCommandDeps;
  io: ReturnType<typeof makeIo>;
  opened: string[];
  backend: SshBackend;
  prompts: string[];
} {
  const io = makeIo();
  const opened: string[] = [];
  const prompts: string[] = [];
  const backend =
    overrides.backend ??
    ({
      list: async () => [],
      add: async () => {
        throw new Error('unexpected add');
      },
      remove: async () => {},
      test: async () => ({ ok: true }) satisfies SshTestResult,
      connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
    }) satisfies SshBackend;
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
    isInteractive: () => false,
    holdForeground: async () => {},
    stdout: io.stdout,
    stderr: io.stderr,
    ...overrides,
  };
  return { deps, io, opened, backend, prompts };
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
      'remove',
      'test',
    ]);
  });

  it('exposes the documented options on add and connect', () => {
    const program = new Command('kimi').exitOverride();
    registerSshCommand(program);
    const ssh = program.commands.find((command) => command.name() === 'ssh');
    const add = ssh?.commands.find((command) => command.name() === 'add');
    const connect = ssh?.commands.find((command) => command.name() === 'connect');
    expect(add?.options.map((option) => option.long)).toEqual([
      '--user',
      '--port',
      '--identity-file',
    ]);
    expect(connect?.options.map((option) => option.long)).toEqual(['--direct', '--no-open']);
  });
});

describe('kimi ssh add', () => {
  it('saves a connection through the REST backend when a server is live', async () => {
    const added: unknown[] = [];
    const backend: SshBackend = {
      list: async () => [],
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
      remove: async () => {},
      test: async () => ({ ok: true }),
      connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
    };
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
    expect(out).toContain('kimi ssh test prod');
    expect(out).toContain('kimi ssh connect prod');
  });

  it('prefers --user over the user part of the target', async () => {
    const added: unknown[] = [];
    const backend: SshBackend = {
      list: async () => [],
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
      remove: async () => {},
      test: async () => ({ ok: true }),
      connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
    };
    const { deps } = makeDeps({ backend });
    await handleSshAdd({ name: 'prod', target: 'ubuntu@example.com', user: 'root' }, deps);
    expect(added).toEqual([
      { name: 'prod', host: 'example.com', user: 'root', port: 22, identityFile: undefined },
    ]);
  });

  it('prompts for missing fields when interactive and no target is given', async () => {
    const answers = ['example.com', 'ubuntu', '2222', '~/.ssh/id_ed25519'];
    const added: unknown[] = [];
    const backend: SshBackend = {
      list: async () => [],
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
      remove: async () => {},
      test: async () => ({ ok: true }),
      connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
    };
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
      status: { state: 'on', localOrigin: 'http://127.0.0.1:49001', error: undefined },
    },
    {
      name: 'staging',
      host: 'staging.internal',
      user: undefined,
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
      status: { state: 'error', localOrigin: undefined, error: 'permission denied' },
    },
    {
      name: 'offbox',
      host: '192.168.1.10',
      user: undefined,
      port: 22,
      identityFile: undefined,
      status: { state: 'off', localOrigin: undefined, error: undefined },
    },
  ];

  it('renders an aligned table with live status from the REST backend', async () => {
    const { deps, io } = makeDeps({
      backend: {
        list: async () => connections,
        add: async () => connections[0]!,
        remove: async () => {},
        test: async () => ({ ok: true }),
        connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
      },
      getLiveServer: async () => LIVE_SERVER,
    });
    await handleSshList(deps);
    const out = io.readStdout();
    expect(out).toContain('NAME');
    expect(out).toContain('TARGET');
    expect(out).toContain('prod');
    expect(out).toContain('ubuntu@example.com');
    expect(out).toContain('connected');
    expect(out).toContain('http://127.0.0.1:49001');
    expect(out).toContain('staging.internal:2222');
    expect(out).toContain('permission denied');
    expect(out).not.toContain('local registry only');
  });

  it('notes the local-only registry when no server is running', async () => {
    const { deps, io } = makeDeps({
      backend: {
        list: async () => connections,
        add: async () => connections[0]!,
        remove: async () => {},
        test: async () => ({ ok: true }),
        connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
      },
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

describe('kimi ssh remove', () => {
  it('removes through the backend and confirms', async () => {
    const removed: string[] = [];
    const { deps, io } = makeDeps({
      backend: {
        list: async () => [],
        add: async () => {
          throw new Error('unexpected');
        },
        remove: async (name) => {
          removed.push(name);
        },
        test: async () => ({ ok: true }),
        connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
      },
    });
    await handleSshRemove({ name: 'prod' }, deps);
    expect(removed).toEqual(['prod']);
    expect(io.readStdout()).toContain('Removed ssh connection "prod".');
  });
});

describe('kimi ssh test', () => {
  it('prints the remote bootstrap state on success', async () => {
    const { deps, io } = makeDeps({
      backend: {
        list: async () => [],
        add: async () => {
          throw new Error('unexpected');
        },
        remove: async () => {},
        test: async () => ({
          ok: true,
          platform: 'linux-x64',
          kimiPath: '/home/ubuntu/.kimi-code/bin/kimi',
          serverRunning: false,
        }),
        connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
      },
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
      backend: {
        list: async () => [],
        add: async () => {
          throw new Error('unexpected');
        },
        remove: async () => {},
        test: async () => ({ ok: false, error: 'ssh exited 255: Permission denied (publickey)' }),
        connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
      },
    });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(/test failed/);
    const out = io.readStdout();
    expect(out).toContain('FAILED');
    expect(out).toContain('Permission denied');
    expect(out).toContain('ssh-add -l');
  });

  it('fails with a network hint on unreachable hosts', async () => {
    const { deps, io } = makeDeps({
      backend: {
        list: async () => [],
        add: async () => {
          throw new Error('unexpected');
        },
        remove: async () => {},
        test: async () => ({ ok: false, error: 'ssh: Could not resolve hostname nope.internal' }),
        connect: async () => ({ localOrigin: 'http://127.0.0.1:49001' }),
      },
    });
    await expect(handleSshTest({ name: 'prod' }, deps)).rejects.toThrow(/test failed/);
    expect(io.readStdout()).toContain('check the host name and your network');
  });
});

describe('kimi ssh connect', () => {
  it('proxy mode: asks the server to connect and prints the kimi_origin URL', async () => {
    const connectCalls: string[] = [];
    const { deps, io, opened } = makeDeps({
      getLiveServer: async () => LIVE_SERVER,
      backend: {
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
        add: async () => {
          throw new Error('unexpected');
        },
        remove: async () => {},
        test: async () => ({ ok: true }),
        connect: async (name) => {
          connectCalls.push(name);
          return { localOrigin: 'http://127.0.0.1:49001' };
        },
      },
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
      status: () => ({ state: 'on' as const, localOrigin: handle.localOrigin }),
      close: async () => {
        closed = true;
      },
      setPassword: async () => {},
      clearPassword: async () => {},
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
      status: () => ({ state: 'off' as const }),
      close: async () => {},
      setPassword: async () => {},
      clearPassword: async () => {},
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
    });
    expect(await client.connect('prod')).toEqual({ localOrigin: 'http://127.0.0.1:49001' });
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

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-ssh-cli-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('add/list/remove round-trip through the real local manager', async () => {
    const io = makeIo();
    const deps: SshCommandDeps = {
      homeDir,
      getLiveServer: async () => undefined,
      resolveToken: () => undefined,
      createRestClient: () => {
        throw new Error('no server in this test');
      },
      openUrl: () => {},
      prompt: async () => '',
      isInteractive: () => false,
      holdForeground: async () => {},
      stdout: io.stdout,
      stderr: io.stderr,
    };
    await handleSshAdd(
      { name: 'prod', target: 'ubuntu@example.com', port: '2222', identityFile: '~/.ssh/id' },
      deps,
    );
    await handleSshList(deps);
    const out = io.readStdout();
    expect(out).toContain('prod');
    expect(out).toContain('ubuntu@example.com:2222');
    await handleSshRemove({ name: 'prod' }, deps);
    await handleSshList(deps);
    expect(io.readStdout()).toContain('No SSH connections saved yet');
  });

  it('rejects duplicates with an actionable message', async () => {
    const io = makeIo();
    const deps: SshCommandDeps = {
      homeDir,
      getLiveServer: async () => undefined,
      resolveToken: () => undefined,
      createRestClient: () => {
        throw new Error('no server in this test');
      },
      openUrl: () => {},
      prompt: async () => '',
      isInteractive: () => false,
      holdForeground: async () => {},
      stdout: io.stdout,
      stderr: io.stderr,
    };
    await handleSshAdd({ name: 'prod', target: 'example.com' }, deps);
    await expect(handleSshAdd({ name: 'prod', target: 'example.com' }, deps)).rejects.toThrow(
      /already exists/,
    );
  });
});
