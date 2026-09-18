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
 * Password authentication: every password is entered through a hidden-echo
 * prompt (`promptSecret`), never as a command-line value. `test`/`connect`
 * first try public-key auth; on a needs-password failure an interactive
 * terminal prompts for a password (offering to save it to the secrets store)
 * and retries once, while a non-interactive run fails with an actionable
 * message.
 *
 * Host keys are trusted on first contact (StrictHostKeyChecking=accept-new).
 * A host-key-changed refusal from `test`/`connect` prints the
 * stored-vs-presented fingerprint comparison; an interactive run offers to
 * forget the stale key and retry, a non-interactive run fails naming
 * `kimi ssh host-key <name> --forget` and the manual `ssh-keygen -R`.
 *
 * Every collaborator behind `SshCommandDeps` is injectable so tests never
 * touch a real server, registry, or ssh binary.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { ServerInstanceInfo } from '@moonshot-ai/kap-server';
import { getLiveServerInstance } from '@moonshot-ai/kap-server';
import {
  createSshConnectionManager,
  errorMessage,
  isNeedsPasswordError,
  sshConnectionProfileSchema,
  type SshAuthOptions,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshConnectionSpec,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';

import { getDataDir } from '#/utils/paths';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import { browserOpenOrigin } from '../web/access-urls';
import { parsePort, tryResolveServerToken } from '../web/shared';
import {
  createSshRestClient,
  SSH_AUTH_REQUIRED_CODE,
  SshApiError,
  type SshBackend,
} from './client';
import {
  buildSshDirectUrl,
  buildSshManageUrl,
  buildSshProxyUrl,
  formatAddAuthLine,
  formatConnectDirectBanner,
  formatConnectProxyBanner,
  formatConnectionTable,
  formatHostKeyChangedAction,
  formatHostKeyChangedWarning,
  formatHostKeyForgotten,
  formatNeedsPasswordError,
  formatScannedHostKeys,
  SSH_LIST_EMPTY_HINT,
  sshTarget,
} from './format';
import {
  extractHostKeyChangedDetails,
  isHostKeyChangedError,
  knownHostsRemoveTarget,
  primaryScannedKey,
  storedHostKeyFingerprint,
  type HostKeyFingerprint,
  type OffendingHostKey,
} from './host-key';
import { readSecretLine } from './secret-prompt';

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
  /** Hidden-echo password entry; requires an interactive terminal. */
  promptSecret: (question: string) => Promise<string>;
  /** Yes/no question; resolves true only for an explicit yes. */
  confirm: (question: string) => Promise<boolean>;
  isInteractive: () => boolean;
  /**
   * Read a known_hosts file to recover the stored fingerprint for the
   * host-key-changed warning; best-effort, failures degrade the display.
   */
  readTextFile?: (path: string) => Promise<string>;
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

/**
 * The manager satisfies `SshBackend` natively once the ssh-remote host-key
 * contract (`scanHostKey`/`forgetHostKey`, merged ahead of this branch) is
 * in; the cast bridges this branch's build against the pre-contract package.
 */
function localManagerBackend(deps: SshCommandDeps): SshBackend {
  return localManager(deps) as unknown as SshBackend;
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
  return { backend: localManagerBackend(deps), server: undefined };
}

/** Where saved passwords live; printed so users can judge the risk. */
function secretsFilePath(deps: SshCommandDeps): string {
  return join(deps.homeDir, 'ssh', 'secrets.json');
}

/** Unified needs-password detection across the REST and local backends. */
function errorNeedsPassword(error: unknown): boolean {
  if (error instanceof SshApiError) return error.code === SSH_AUTH_REQUIRED_CODE;
  return isNeedsPasswordError(error);
}

/**
 * Run a connection test, folding a thrown needs-password failure (REST maps
 * it to an error envelope) into the result shape the local manager returns.
 */
async function runTest(
  backend: SshBackend,
  name: string,
  auth?: SshAuthOptions,
): Promise<SshTestResult> {
  try {
    return await backend.test(name, auth);
  } catch (error) {
    if (errorNeedsPassword(error)) {
      return { ok: false, needsPassword: true, error: errorMessage(error) };
    }
    throw error;
  }
}

async function targetLabel(backend: SshBackend, name: string): Promise<string> {
  const info = await findConnection(backend, name);
  return info === undefined ? name : sshTarget(info);
}

/** Hidden-echo password entry plus the opt-in "remember" question. */
async function promptPasswordAuth(
  deps: SshCommandDeps,
  label: string,
): Promise<SshAuthOptions> {
  const password = await deps.promptSecret(`Password for ${label}: `);
  if (password.length === 0) {
    throw new Error('no password entered — aborted');
  }
  const savePassword = await deps.confirm(
    `Remember this password? It is stored as plaintext in ${secretsFilePath(deps)} (mode 0600)`,
  );
  return { password, savePassword };
}

/**
 * Resolve an explicit `--password` flag into credentials. Passwords are only
 * ever collected through the hidden prompt, so the flag requires a TTY.
 */
async function promptPasswordFlag(
  deps: SshCommandDeps,
  label: string,
): Promise<SshAuthOptions> {
  if (!deps.isInteractive()) {
    throw new Error(
      '--password needs an interactive terminal — the password is entered via a hidden prompt and is never accepted as a command-line value',
    );
  }
  return promptPasswordAuth(deps, label);
}

/**
 * The needs-password branch of `test`/`connect`: interactively collect a
 * password, or fail with an actionable message when there is no TTY.
 */
async function promptPasswordRetry(
  deps: SshCommandDeps,
  name: string,
  command: 'connect' | 'test',
  label: string,
): Promise<SshAuthOptions> {
  if (!deps.isInteractive()) {
    throw new Error(formatNeedsPasswordError(name, command));
  }
  deps.stdout.write(
    `ssh connection "${name}" requires a password — public key authentication failed.\n`,
  );
  return promptPasswordAuth(deps, label);
}

/**
 * Run a `test`/`connect` attempt, resolving a host-key-changed refusal when
 * one comes back: print the stored-vs-presented fingerprint comparison, then
 * either (interactive) forget the stale key on confirmation and retry once —
 * the retry re-trusts under accept-new — or (non-interactive) fail with the
 * forget command and the manual `ssh-keygen -R` equivalent.
 */
async function withHostKeyRetry<T>(
  deps: SshCommandDeps,
  backend: SshBackend,
  name: string,
  label: string,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isHostKeyChangedError(error)) throw error;
    await resolveHostKeyChanged(deps, backend, name, label, error);
    return attempt();
  }
}

async function resolveHostKeyChanged(
  deps: SshCommandDeps,
  backend: SshBackend,
  name: string,
  label: string,
  error: unknown,
): Promise<void> {
  const details = extractHostKeyChangedDetails(error);
  const presented = details.presented ?? (await scanPresentedKey(backend, name));
  const stored =
    details.offending === undefined
      ? undefined
      : await readStoredFingerprint(deps, details.offending);
  const warning = formatHostKeyChangedWarning({
    name,
    target: label,
    presented,
    stored,
    offending: details.offending,
  });
  if (!deps.isInteractive()) {
    throw new Error(`${warning}\n${await hostKeyChangedAction(backend, name, label)}`);
  }
  deps.stdout.write(`${warning}\n`);
  const confirmed = await deps.confirm('Remove the old host key and retry?');
  if (!confirmed) {
    throw new Error('host key verification failed — the stored key was left unchanged');
  }
  await backend.forgetHostKey(name);
  deps.stdout.write(`Removed the stored host key for "${name}" — retrying.\n`);
}

/** The presented fingerprint for the warning when the error carried none. */
async function scanPresentedKey(
  backend: SshBackend,
  name: string,
): Promise<HostKeyFingerprint | undefined> {
  try {
    return primaryScannedKey(await backend.scanHostKey(name));
  } catch {
    return undefined;
  }
}

async function readStoredFingerprint(
  deps: SshCommandDeps,
  offending: OffendingHostKey,
): Promise<HostKeyFingerprint | undefined> {
  const read = deps.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  try {
    return storedHostKeyFingerprint(await read(offending.file), offending.line);
  } catch {
    return undefined;
  }
}

async function hostKeyChangedAction(
  backend: SshBackend,
  name: string,
  label: string,
): Promise<string> {
  const info = await findConnection(backend, name);
  const removeTarget =
    info === undefined ? label : knownHostsRemoveTarget(info.host, info.port ?? 22);
  return formatHostKeyChangedAction(name, removeTarget);
}

export interface SshAddOptions {
  name: string;
  target?: string;
  user?: string;
  port?: string;
  identityFile?: string;
  /** Prompt (hidden echo) for a password used by the post-add auto-test. */
  password?: boolean;
  /** Persist the password entered via --password after a successful test. */
  savePassword?: boolean;
}

export async function handleSshAdd(
  options: SshAddOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  if (options.savePassword === true && options.password !== true) {
    throw new Error(
      '--save-password requires --password — the password is entered via a hidden prompt and is never accepted as a command-line value',
    );
  }
  if (options.password === true && !deps.isInteractive()) {
    throw new Error(
      '--password needs an interactive terminal — the password is entered via a hidden prompt and is never accepted as a command-line value',
    );
  }
  const spec = await resolveAddSpec(options, deps);
  const { backend } = await resolveBackend(deps);
  const info = await backend.add(spec);
  const auth =
    options.password === true ? await promptPasswordAuth(deps, sshTarget(info)) : undefined;
  const result = await runTest(backend, info.name, auth);
  deps.stdout.write(formatAddResult(info, result, auth));
}

function formatAddResult(
  info: SshConnectionInfo,
  result: SshTestResult,
  auth: SshAuthOptions | undefined,
): string {
  const lines = [
    `Saved ssh connection "${info.name}" (${sshTarget(info)}).`,
    '',
    formatAddAuthLine({
      name: info.name,
      ok: result.ok,
      needsPassword: result.needsPassword,
      passwordUsed: auth?.password !== undefined,
      passwordSaved: result.ok && auth?.savePassword === true,
    }),
  ];
  if (result.ok) {
    lines.push(
      `  Remote platform:  ${result.platform ?? 'unknown'}`,
      `  kimi binary:      ${result.kimiPath ?? 'not installed — it will be uploaded on first connect'}`,
      `  Remote server:    ${result.serverRunning === true ? 'running' : 'not running — it will be started on first connect'}`,
    );
  } else {
    if (result.error !== undefined) lines.push(`  ${result.error}`);
    if (result.needsPassword !== true) lines.push(sshTestHint(result.error ?? ''));
  }
  lines.push('', 'Next steps:', `  kimi ssh connect ${info.name}  open the remote web UI`);
  if (!result.ok) {
    lines.push(`  kimi ssh test ${info.name}     re-run the connectivity check`);
  }
  lines.push('');
  return lines.join('\n');
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

export interface SshPasswdOptions {
  name: string;
  /** Clear the saved password instead of setting one. */
  clear?: boolean;
}

export async function handleSshPasswd(
  options: SshPasswdOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const { backend } = await resolveBackend(deps);
  if (options.clear === true) {
    await backend.clearPassword(options.name);
    deps.stdout.write(`Cleared the saved password for ssh connection "${options.name}".\n`);
    return;
  }
  if (!deps.isInteractive()) {
    throw new Error(
      'setting a password needs an interactive terminal — the password is entered via a hidden prompt and is never accepted as a command-line value',
    );
  }
  const label = await targetLabel(backend, options.name);
  const password = await deps.promptSecret(`Password for ${label}: `);
  if (password.length === 0) {
    throw new Error('no password entered — nothing saved');
  }
  await backend.setPassword(options.name, password);
  deps.stdout.write(
    [
      `Saved the password for ssh connection "${options.name}" in ${secretsFilePath(deps)} (mode 0600).`,
      `Verify it with:  kimi ssh test ${options.name}`,
      '',
    ].join('\n'),
  );
}

export interface SshHostKeyOptions {
  name: string;
  /** Remove the stored host key instead of showing the current one. */
  forget?: boolean;
}

export async function handleSshHostKey(
  options: SshHostKeyOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const { backend } = await resolveBackend(deps);
  const label = await targetLabel(backend, options.name);
  if (options.forget === true) {
    await backend.forgetHostKey(options.name);
    deps.stdout.write(`${formatHostKeyForgotten(options.name, label)}\n`);
    return;
  }
  const keys = await backend.scanHostKey(options.name);
  if (keys.length === 0) {
    throw new Error(
      `no host key found for ssh connection "${options.name}" — the host did not answer the scan`,
    );
  }
  deps.stdout.write(`${formatScannedHostKeys(options.name, label, keys)}\n`);
}

export interface SshTestOptions {
  name: string;
  /** Prompt (hidden echo) for a password before testing. */
  password?: boolean;
}

export async function handleSshTest(
  options: SshTestOptions,
  deps: SshCommandDeps = DEFAULT_SSH_DEPS,
): Promise<void> {
  const { backend } = await resolveBackend(deps);
  const label = await targetLabel(backend, options.name);
  const preAuth = options.password === true ? await promptPasswordFlag(deps, label) : undefined;
  let result = await withHostKeyRetry(deps, backend, options.name, label, () =>
    runTest(backend, options.name, preAuth),
  );
  if (!result.ok && result.needsPassword === true && preAuth === undefined) {
    const retry = await promptPasswordRetry(deps, options.name, 'test', label);
    result = await withHostKeyRetry(deps, backend, options.name, label, () =>
      runTest(backend, options.name, retry),
    );
  }
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
      result.needsPassword === true
        ? `Hint: a password is required — save one with \`kimi ssh passwd ${name}\`, or re-run with \`kimi ssh test ${name} --password\`.`
        : sshTestHint(result.error ?? ''),
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
    return 'Hint: authentication failed — check `ssh-add -l` for loaded keys, re-add the connection with --identity-file, or save a password with `kimi ssh passwd`.';
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
  /** Prompt (hidden echo) for a password before connecting. */
  password?: boolean;
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

/**
 * Connect with public-key auth first; on a needs-password failure prompt
 * (hidden echo) and retry once with the entered password. A host-key-changed
 * refusal is resolved inside `withHostKeyRetry` before auth is considered.
 */
async function connectWithAuth(
  backend: SshBackend,
  options: SshConnectOptions,
  deps: SshCommandDeps,
): Promise<{ localOrigin: string; remoteToken?: string }> {
  const label = await targetLabel(backend, options.name);
  const preAuth =
    options.password === true ? await promptPasswordFlag(deps, label) : undefined;
  try {
    return await withHostKeyRetry(deps, backend, options.name, label, () =>
      backend.connect(options.name, preAuth),
    );
  } catch (error) {
    if (preAuth !== undefined || !errorNeedsPassword(error)) throw error;
    const retry = await promptPasswordRetry(deps, options.name, 'connect', label);
    return withHostKeyRetry(deps, backend, options.name, label, () =>
      backend.connect(options.name, retry),
    );
  }
}

/** Proxy mode: the local server holds the tunnel; this command prints and exits. */
async function connectViaServer(
  options: SshConnectOptions,
  server: ServerInstanceInfo,
  deps: SshCommandDeps,
): Promise<void> {
  const token = deps.resolveToken();
  const backend = restBackend(deps, server);
  await connectWithAuth(backend, options, deps);
  const info = await findConnection(backend, options.name);
  const openOrigin = browserOpenOrigin(serverOrigin(server));
  const remoteUrl = buildSshProxyUrl(openOrigin, options.name, token);
  deps.stdout.write(
    `${formatConnectProxyBanner({
      name: options.name,
      target: info !== undefined ? sshTarget(info) : 'saved connection',
      manageUrl: buildSshManageUrl(openOrigin, token),
      remoteUrl,
      opened: options.open === true,
    })}\n`,
  );
  if (options.open === true) deps.openUrl(remoteUrl);
}

/** Direct mode: hold the tunnel in this process until Ctrl+C. */
async function connectDirect(options: SshConnectOptions, deps: SshCommandDeps): Promise<void> {
  const manager = localManager(deps);
  const backend = manager as unknown as SshBackend;
  const handle = await connectWithAuth(backend, options, deps);
  if (handle.remoteToken === undefined) {
    throw new Error('ssh tunnel connected without a remote token');
  }
  const info = await findConnection(backend, options.name);
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

function defaultPromptSecret(question: string): Promise<string> {
  return readSecretLine({ input: process.stdin, output: process.stdout }, question);
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
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
  promptSecret: defaultPromptSecret,
  confirm: defaultConfirm,
  isInteractive: () => process.stdin.isTTY ?? false,
  holdForeground: defaultHoldForeground,
  stdout: process.stdout,
  stderr: process.stderr,
};
