/**
 * `kimi ssh` — manage SSH remote connections and open remote machines in the
 * web UI through a local tunnel.
 *
 * Command tree:
 *   kimi ssh add <name> [target]   save a connection (interactive when the
 *                                  target is omitted and stdin is a TTY)
 *   kimi ssh list                  saved connections + live status
 *   kimi ssh remove <name>         delete a saved connection
 *   kimi ssh test <name>           probe connectivity and the remote setup
 *   kimi ssh connect <name>        establish the tunnel and print the web URL
 */

import type { Command } from 'commander';

import { sshErrorHint } from './format';
import {
  handleSshAdd,
  handleSshConnect,
  handleSshList,
  handleSshRemove,
  handleSshTest,
  type SshAddOptions,
  type SshConnectOptions,
} from './run';

/** Shared failure path: print the message plus an actionable hint, then exit 1. */
function runAction(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const hint = sshErrorHint(error);
    process.stderr.write(hint === undefined ? `${message}\n` : `${message}\n${hint}\n`);
    process.exit(1);
  });
}

export function registerSshCommand(program: Command): void {
  const ssh = program
    .command('ssh')
    .description('Manage SSH remote connections and open them in the web UI.');

  ssh
    .command('add')
    .description('Save an SSH connection. Prompts for missing fields when run interactively.')
    .argument('<name>', 'connection name (letters, digits, dot, underscore, dash)')
    .argument('[target]', 'remote host as [user@]host')
    .option('--user <user>', 'login user; overrides the user part of [user@]host')
    .option('--port <port>', 'SSH port on the remote', '22')
    .option('--identity-file <path>', 'private key file to authenticate with')
    .action((name: string, target: string | undefined, opts: Omit<SshAddOptions, 'name' | 'target'>) => {
      runAction(async () => {
        await handleSshAdd({ name, target, ...opts });
      });
    });

  ssh
    .command('list')
    .description('List saved SSH connections with their live status.')
    .action(() => {
      runAction(handleSshList);
    });

  ssh
    .command('remove')
    .description('Remove a saved SSH connection (disconnects it first when connected).')
    .argument('<name>', 'connection name')
    .action((name: string) => {
      runAction(async () => {
        await handleSshRemove({ name });
      });
    });

  ssh
    .command('test')
    .description('Probe a connection: SSH handshake, remote platform, kimi install state.')
    .argument('<name>', 'connection name')
    .action((name: string) => {
      runAction(async () => {
        await handleSshTest({ name });
      });
    });

  ssh
    .command('connect')
    .description(
      'Establish the tunnel and print the remote web UI URL. With a running local server the server holds the tunnel (default); otherwise the tunnel is held by this terminal until Ctrl+C.',
    )
    .argument('<name>', 'connection name')
    .option(
      '--direct',
      'Hold the tunnel in this terminal even when a local server is running.',
      false,
    )
    .option('--no-open', 'Do not open the remote web UI in the default browser.', true)
    .action((name: string, opts: Omit<SshConnectOptions, 'name'>) => {
      runAction(async () => {
        await handleSshConnect({ name, ...opts });
      });
    });
}
