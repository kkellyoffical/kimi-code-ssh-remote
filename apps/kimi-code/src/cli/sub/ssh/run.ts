/**
 * Handlers for the `kimi ssh` subcommand tree.
 *
 * Backend selection: when a live local server exists (read-only probe via
 * `getLiveServerInstance`), every operation goes through its REST API so the
 * CLI and the server's SSH proxy share one runtime state; otherwise the local
 * `@moonshot-ai/ssh-remote` manager talks to the registry / ssh directly.
 * `connect` is the exception: with a live server it asks the server to hold
 * the tunnel (proxy mode) and exits; without one (or with `--direct`) it holds
 * the tunnel in this process until Ctrl+C.
 *
 * Every collaborator behind `SshCommandDeps` is injectable so tests never
 * touch a real server, registry, or ssh binary.
 */

import { createInterface } from 'node:readline/promises';

import type { ServerInstanceInfo } from '@moonshot-ai/kap-server';
import { getLiveServerInstance } from '@moonshot-ai/kap-server';
import {
  createSshConnectionManager,
  sshConnectionProfileSchema,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshConnectionSpec,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';

import { getDataDir } from '#/utils/paths';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import { browserOpenOrigin, buildOpenableUrl } from '../web/access-urls';
import { parsePort, tryResolveServerToken } from '../web/shared';
import { createSshRestClient, type SshBackend } from './client';
import {
  buildSshDirectUrl,
  buildSshProxyUrl,
  formatConnectDirectBanner,
  formatConnectProxyBanner,
  formatConnectionTable,
  SSH_LIST_EMPTY_HINT,
  sshTarget,
} from './format';

export interface SshCommandDeps {
  homeDir: string;
  /** Read-only lookup of a running local server; never starts or stops one. */
  getLiveServer: () => Promise<ServerInstanceInfo | undefined>;
  /** Best-effort local server bearer token (undefined under bypass-auth). */
  resolveToken: () => string | undefined;
  /** Defaults to the real client/manager built on `homeDir` when omitted. */
  createRestClient?: (origin: string, token: string | undefined) => SshBackend;
  createLocalManager?: () => SshConnectionManager;
  openUrl: (url: string) => void;
  /** Interactive prompt; only used by `add` when the target is omitted. */
  prompt: (question: string) => Promise<string>;
  isInteractive: () => boolean;
  /** Blocks until SIGINT/SIGTERM, then runs the shutdown callback. */
  holdForeground: (onShutdown: (reason: string) => Promise<void>) => Promise<void>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

function serverOrigin(instance: ServerInstanceInfo): string {
  const host =
    instance.host === '' || instance.host === '0.0.0.0' || instance.host === '::'
      ? '127.0.0.1'
      : instance.host;
  return `http://${host}:${instance.port}`;
}

function restBackend(
  deps: SshCommandDeps,
  server: ServerInstanceInfo,
): SshBackend {
  const origin = serverOrigin(server);
  const token = deps.resolveToken();
  return deps.createRestClient?.(origin, token) ?? createSshRestClient({ origin, token });
}

function localManager(deps: SshCommandDeps): SshConnectionManager {
  return deps.createLocalManager?.() ?? createSshConnectionManager({ homeDir: deps.homeDir });
}

/** Pick the REST backend when a server is live, else the local manager. */
async function resolveBackend(deps: SshCommandDeps): Promise<{
  backend: SshBackend;
  server: ServerInstanceInfo | undefined;
}> {
  const server = await deps.getLiveServer();
  if (server !== undefined) {
    return { backend: restBackend(deps, server), server };
  }
  return { backend: localManager(deps), server: undefined };
}

export interface SshAddOptions {
  name: string;
  target?: string;
  user?: string;
  port?: string;
  identityFile?: string;
}

export async function handleSshAdd(
  options: SshAddOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const spec = await resolveAddSpec(options, deps);
  const { backend } = await resolveBackend(deps);
  const info = await backend.add(spec);
  deps.stdout.write(
    [
      `Saved ssh connection "${info.name}" (${sshTarget(info)}).`,
      '',
      'Next steps:',
      `  kimi ssh test ${info.name}     verify connectivity and the remote setup`,
      `  kimi ssh connect ${info.name}  open the remote web UI`,
      '',
    ].join('\n'),
  );
}

async function resolveAddSpec(
  options: SshAddOptions,
  deps: SshCommandDeps,
): Promise<SshConnectionSpec> {
  let host: string | undefined;
  let user = options.user;
  let port = parsePort(options.port, '--port', 22);
  let identityFile = options.identityFile;

  if (options.target !== undefined) {
    const at = options.target.lastIndexOf('@');
    if (at >= 0) {
      user = user ?? options.target.slice(0, at);
      host = options.target.slice(at + 1);
    } else {
      host = options.target;
    }
  } else {
    if (!deps.isInteractive()) {
      throw new Error(
        'missing target. Usage: kimi ssh add <name> <[user@]host> [--port <port>] [--identity-file <path>]',
      );
    }
    host = (await deps.prompt('Host (e.g. example.com or 192.168.1.10): ')).trim();
    const userAnswer = (await deps.prompt('User (optional, press Enter to skip): ')).trim();
    if (user === undefined && userAnswer.length > 0) user = userAnswer;
    const portAnswer = (await deps.prompt('Port [22]: ')).trim();
    if (portAnswer.length > 0) port = parsePort(portAnswer, '--port', 22);
    const identityAnswer = (await deps.prompt('Identity file (optional, press Enter to skip): ')).trim();
    if (identityFile === undefined && identityAnswer.length > 0) identityFile = identityAnswer;
  }

  if (host === undefined || host.length === 0) {
    throw new Error('invalid ssh connection: host is required');
  }
  const candidate = { name: options.name, host, user, port, identityFile };
  const parsed = sshConnectionProfileSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `invalid ssh connection: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export async function handleSshList(deps: SshCommandDeps = DEFAULT_SSH_DEPS): Promise<void> {
  const { backend, server } = await resolveBackend(deps);
  const connections = await backend.list();
  if (connections.length === 0) {
    deps.stdout.write(`${SSH_LIST_EMPTY_HINT}\n`);
    return;
  }
  const note =
    server === undefined
      ? ' (local registry only — start `kimi web` for live status)\n'
      : '\n';
  deps.stdout.write(`${formatConnectionTable(connections)}\n${note}`);
}

export interface SshNameOptions {
  name: string;
}

export async function handleSshRemove(
  options: SshNameOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const { backend } = await resolveBackend(deps);
  await backend.remove(options.name);
  deps.stdout.write(`Removed ssh connection "${options.name}".\n`);
}

export async function handleSshTest(
  options: SshNameOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const { backend } = await resolveBackend(deps);
  const result = await backend.test(options.name);
  deps.stdout.write(formatTestResult(options.name, result));
  if (!result.ok) {
    throw new Error(`ssh connection "${options.name}" test failed`);
  }
}

function formatTestResult(name: string, result: SshTestResult): string {
  if (!result.ok) {
    return [
      `ssh connection "${name}": FAILED`,
      `  ${result.error ?? 'unknown error'}`,
      sshTestHint(result.error ?? ''),
      '',
    ].join('\n');
  }
  return [
    `ssh connection "${name}": OK`,
    `  Remote platform:  ${result.platform ?? 'unknown'}`,
    `  kimi binary:      ${result.kimiPath ?? 'not installed — it will be uploaded on first connect'}`,
    `  Remote server:    ${result.serverRunning === true ? 'running' : 'not running — it will be started on first connect'}`,
    '',
  ].join('\n');
}

/** Pattern-based hint: `test` collapses error kinds into plain messages. */
function sshTestHint(message: string): string {
  if (/permission denied|authentication failed|auth/i.test(message)) {
    return 'Hint: authentication failed — check `ssh-add -l` for loaded keys, or re-add the connection with --identity-file.';
  }
  if (/could not resolve|no route|timed out|timeout|unreachable|refused/i.test(message)) {
    return 'Hint: the host is unreachable — check the host name and your network connection (VPN, firewall).';
  }
  return 'Hint: run `ssh <[user@]host>` manually to see the full ssh error.';
}

export interface SshConnectOptions {
  name: string;
  direct?: boolean;
  open?: boolean;
}

export async function handleSshConnect(
  options: SshConnectOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const server = await deps.getLiveServer();
  if (server !== undefined && options.direct !== true) {
    await connectViaServer(options, server, deps);
    return;
  }
  await connectDirect(options, deps);
}

/** Proxy mode: the local server holds the tunnel; this command prints and exits. */
async function connectViaServer(
  options: SshConnectOptions,
  server: ServerInstanceInfo,
  deps: SshCommandDeps,
): Promise<void> {
  const token = deps.resolveToken();
  const backend = restBackend(deps, server);
  await backend.connect(options.name);
  const info = await findConnection(backend, options.name);
  const openOrigin = browserOpenOrigin(serverOrigin(server));
  const remoteUrl = buildSshProxyUrl(openOrigin, options.name, token);
  deps.stdout.write(
    `${formatConnectProxyBanner({
      name: options.name,
      target: info !== undefined ? sshTarget(info) : 'saved connection',
      manageUrl: buildOpenableUrl(openOrigin, token),
      remoteUrl,
      opened: options.open === true,
    })}\n`,
  );
  if (options.open === true) deps.openUrl(remoteUrl);
}

/** Direct mode: hold the tunnel in this process until Ctrl+C. */
async function connectDirect(options: SshConnectOptions, deps: SshCommandDeps): Promise<void> {
  const manager = localManager(deps);
  const handle = await manager.connect(options.name);
  const info = await findConnection(manager, options.name);
  const remoteUrl = buildSshDirectUrl(handle.localOrigin, handle.remoteToken);
  deps.stdout.write(
    `${formatConnectDirectBanner({
      name: options.name,
      target: info !== undefined ? sshTarget(info) : 'saved connection',
      remoteUrl,
      opened: options.open === true,
    })}\n`,
  );
  if (options.open === true) deps.openUrl(remoteUrl);
  await deps.holdForeground(async () => {
    await manager.close();
  });
}

async function findConnection(
  backend: SshBackend,
  name: string,
): Promise<SshConnectionInfo | undefined> {
  try {
    return (await backend.list()).find((info) => info.name === name);
  } catch {
    return undefined;
  }
}

function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => {
    rl.close();
  });
}

async function defaultHoldForeground(
  onShutdown: (reason: string) => Promise<void>,
): Promise<void> {
  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    void onShutdown(reason).finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
  return new Promise<void>(() => {});
}

export const DEFAULT_SSH_DEPS: SshCommandDeps = {
  homeDir: getDataDir(),
  getLiveServer: () => getLiveServerInstance(),
  resolveToken: () => tryResolveServerToken(getDataDir()),
  openUrl: defaultOpenUrl,
  prompt: defaultPrompt,
  isInteractive: () => process.stdin.isTTY ?? false,
  holdForeground: defaultHoldForeground,
  stdout: process.stdout,
  stderr: process.stderr,
};
