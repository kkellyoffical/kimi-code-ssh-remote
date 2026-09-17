/**
 * `kimi ssh` — manage SSH remote connections and open remote machines in the
 * web UI through a local tunnel.
 *
 * Command tree:
 *   kimi ssh add <name> [target]   save a connection (interactive when the
 *                                  target is omitted and stdin is a TTY),
 *                                  then probe it and report the auth status
 *   kimi ssh list                  saved connections + auth method + live status
 *   kimi ssh remove <name>         delete a saved connection
 *   kimi ssh passwd <name>         save a password (hidden prompt) or --clear it
 *   kimi ssh test <name>           probe connectivity and the remote setup
 *   kimi ssh connect <name>        establish the tunnel and print the web URL
 *
 * Passwords are only ever collected through a hidden-echo prompt — never as
 * command-line values. `test`/`connect` try public-key auth first and, on a
 * needs-password failure, prompt for a password (offering to save it) and
 * retry once when interactive; otherwise they fail with an actionable error.
 */

import type { Command } from 'commander';

import { sshErrorHint } from './format';
import {
  handleSshAdd,
  handleSshConnect,
  handleSshList,
  handleSshPasswd,
  handleSshRemove,
  handleSshTest,
  type SshAddOptions,
  type SshConnectOptions,
  type SshPasswdOptions,
  type SshTestOptions,
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
    .description(
      'Save an SSH connection, then probe it and report the authentication status. Prompts for missing fields when run interactively.',
    )
    .argument('<name>', 'connection name (letters, digits, dot, underscore, dash)')
    .argument('[target]', 'remote host as [user@]host')
    .option('--user <user>', 'login user; overrides the user part of [user@]host')
    .option('--port <port>', 'SSH port on the remote', '22')
    .option('--identity-file <path>', 'private key file to authenticate with')
    .option('--password', 'prompt for a password (hidden input) to authenticate the probe')
    .option('--save-password', 'save the password entered via --password for future connections')
    .action((name: string, target: string | undefined, opts: Omit<SshAddOptions, 'name' | 'target'>) => {
      runAction(async () => {
        await handleSshAdd({ name, target, ...opts });
      });
    });

  ssh
    .command('list')
    .description('List saved SSH connections with their auth method and live status.')
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
    .command('passwd')
    .description(
      'Save the password for an SSH connection via a hidden prompt, or clear it with --clear.',
    )
    .argument('<name>', 'connection name')
    .option('--clear', 'remove the saved password', false)
    .action((name: string, opts: Omit<SshPasswdOptions, 'name'>) => {
      runAction(async () => {
        await handleSshPasswd({ name, ...opts });
      });
    });

  ssh
    .command('test')
    .description('Probe a connection: SSH handshake, remote platform, kimi install state.')
    .argument('<name>', 'connection name')
    .option('--password', 'prompt for a password (hidden input) before probing', false)
    .action((name: string, opts: Omit<SshTestOptions, 'name'>) => {
      runAction(async () => {
        await handleSshTest({ name, ...opts });
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
    .option('--password', 'prompt for a password (hidden input) before connecting', false)
    .action((name: string, opts: Omit<SshConnectOptions, 'name'>) => {
      runAction(async () => {
        await handleSshConnect({ name, ...opts });
      });
    });
}
