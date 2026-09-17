/**
 * Output formatting for `kimi ssh` — table rendering, status lines, the
 * connect banner URLs, and actionable error hints.
 */

import { SshRemoteError, type SshConnectionInfo } from '@moonshot-ai/ssh-remote';
import chalk from 'chalk';

import { darkColors } from '#/tui/theme/colors';

import { SshApiError } from './client';

const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
const url = (text: string): string => chalk.hex(darkColors.accent)(text);
const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
const strong = (text: string): string => chalk.bold.hex(darkColors.textStrong)(text);
const ok = (text: string): string => chalk.hex(darkColors.success)(text);
const bad = (text: string): string => chalk.hex(darkColors.error)(text);

export function sshTarget(info: Pick<SshConnectionInfo, 'host' | 'user' | 'port'>): string {
  const base = info.user === undefined ? info.host : `${info.user}@${info.host}`;
  return info.port === 22 ? base : `${base}:${info.port}`;
}

export function formatState(info: SshConnectionInfo): string {
  const state = info.status.state;
  if (state === 'on') return ok('connected');
  if (state === 'connecting') return primary('connecting');
  if (state === 'error') return bad('error');
  return muted('off');
}

export const SSH_LIST_EMPTY_HINT =
  'No SSH connections saved yet.\nAdd one with:  kimi ssh add <name> <[user@]host>';

/**
 * Render `kimi ssh list` as an aligned table. The last column shows the live
 * endpoint when connected, the failure when in error state, and `·` otherwise.
 */
export function formatConnectionTable(connections: readonly SshConnectionInfo[]): string {
  const rows = connections.map((info) => {
    const detail =
      info.status.state === 'on' && info.status.localOrigin !== undefined
        ? info.status.localOrigin
        : info.status.state === 'error'
          ? (info.status.error ?? 'unknown error')
          : '·';
    return [info.name, sshTarget(info), String(info.port), formatState(info), detail] as const;
  });
  const header = ['NAME', 'TARGET', 'PORT', 'STATE', 'ENDPOINT / ERROR'] as const;
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => stripAnsiLength(row[column] ?? ''))),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, column) => padAnsi(cell, widths[column] ?? 0)).join('  ').trimEnd();
  return [
    dim(renderRow([...header])),
    ...rows.map((row) => renderRow([...row])),
  ].join('\n');
}

function stripAnsiLength(text: string): number {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '').length;
}

function padAnsi(text: string, width: number): string {
  const padding = width - stripAnsiLength(text);
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

/**
 * The browser entry URL for a tunneled remote, proxied through the local
 * server: the bundled web UI loads from the local origin and redirects its API
 * calls at `<origin>/ssh/<name>` via the `kimi_origin` query parameter. The
 * local bearer token rides in the `#token=` fragment (never sent to servers).
 */
export function buildSshProxyUrl(
  serverOpenOrigin: string,
  name: string,
  token: string | undefined,
): string {
  const base = serverOpenOrigin.endsWith('/') ? serverOpenOrigin.slice(0, -1) : serverOpenOrigin;
  const entry = `${base}/?kimi_origin=${base}/ssh/${name}`;
  return token === undefined ? entry : `${entry}#token=${token}`;
}

/** Direct-mode entry: the remote's own server UI behind the local tunnel port. */
export function buildSshDirectUrl(localOrigin: string, remoteToken: string): string {
  const base = localOrigin.endsWith('/') ? localOrigin.slice(0, -1) : localOrigin;
  return `${base}/#token=${remoteToken}`;
}

/**
 * The server's built-in SSH connections management page (`GET /ssh`): add,
 * test, connect, and open connections from the browser. The local bearer
 * token rides in the `#token=` fragment, which the page reads from the URL.
 */
export function buildSshManageUrl(serverOpenOrigin: string, token: string | undefined): string {
  const base = serverOpenOrigin.endsWith('/') ? serverOpenOrigin.slice(0, -1) : serverOpenOrigin;
  return token === undefined ? `${base}/ssh` : `${base}/ssh#token=${token}`;
}

export function formatConnectProxyBanner(options: {
  name: string;
  target: string;
  manageUrl: string;
  remoteUrl: string;
  opened: boolean;
}): string {
  return [
    `${ok('SSH connection ready:')} ${strong(options.name)} ${dim(`(${options.target})`)}`,
    '',
    `  ${dim('Remote web UI:')}  ${url(options.remoteUrl)}`,
    `  ${dim('Manage page:')}    ${url(options.manageUrl)}`,
    '',
    options.opened
      ? dim('Opened the remote web UI in your browser.')
      : dim('Open the Remote web UI URL in your browser to start working on the remote machine.'),
    dim('The tunnel runs inside the local server process and stays up until that server stops.'),
  ].join('\n');
}

export function formatConnectDirectBanner(options: {
  name: string;
  target: string;
  remoteUrl: string;
  opened: boolean;
}): string {
  return [
    `${ok('SSH tunnel established:')} ${strong(options.name)} ${dim(`(${options.target})`)}`,
    '',
    `  ${dim('Remote web UI:')}  ${url(options.remoteUrl)}`,
    '',
    options.opened
      ? dim('Opened the remote web UI in your browser.')
      : dim('Open the Remote web UI URL in your browser to start working on the remote machine.'),
    dim('This terminal holds the tunnel open — press Ctrl+C to disconnect.'),
  ].join('\n');
}

/**
 * Turn a failure into a next step the user can act on. Returns undefined when
 * the raw message is already self-explanatory.
 */
export function sshErrorHint(error: unknown): string | undefined {
  if (error instanceof SshRemoteError) {
    if (error.kind === 'auth') {
      return 'Authentication failed. Check your keys with `ssh-add -l`, or save the connection with an explicit key: kimi ssh add <name> <[user@]host> --identity-file <path>.';
    }
    if (error.kind === 'host-unreachable' || error.kind === 'network') {
      return 'The host is unreachable. Check the host name and your network connection (VPN, firewall, proxy).';
    }
    if (error.kind === 'remote-missing-binary') {
      return 'The remote machine has no kimi binary and none could be uploaded from this machine. Install Kimi Code CLI on the remote first.';
    }
    return undefined;
  }
  if (error instanceof SshApiError) {
    if (error.code === 40421) {
      return 'No such saved connection. Run `kimi ssh list` to see saved connections or `kimi ssh add` to create one.';
    }
    if (error.code === 40930) {
      return 'A connection with this name already exists. Run `kimi ssh list` to see it, or `kimi ssh remove` it first.';
    }
    if (error.code === -1) {
      return 'The local server accepted no connection. If this keeps happening, stop it and run `kimi web` again.';
    }
  }
  return undefined;
}
