import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SshRemoteError, type SshErrorKind } from './errors';
import { sshDestination, type SshConnectionProfile } from './profile';
import type { ProcessRunner, RunResult } from './runner';

export type SshConnectionState = 'connected' | 'disconnected';

export interface SshClientOptions {
  readonly profile: SshConnectionProfile;
  readonly runner: ProcessRunner;
  readonly controlDir: string;
  readonly password?: string;
  readonly connectTimeoutSeconds?: number;
  readonly controlPersistSeconds?: number;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_CONTROL_PERSIST_SECONDS = 60;

const ASKPASS_PASSWORD_ENV = 'KIMI_SSH_PASSWORD';
const ASKPASS_SCRIPT = `#!/bin/sh\nprintf '%s\\n' "$${ASKPASS_PASSWORD_ENV}"\n`;

export class SshClient {
  readonly profile: SshConnectionProfile;
  readonly runner: ProcessRunner;

  private readonly controlDir: string;
  private readonly password?: string;
  private readonly connectTimeoutSeconds: number;
  private readonly controlPersistSeconds: number;

  constructor(options: SshClientOptions) {
    this.profile = options.profile;
    this.runner = options.runner;
    this.controlDir = options.controlDir;
    this.password = options.password;
    this.connectTimeoutSeconds =
      options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
    this.controlPersistSeconds =
      options.controlPersistSeconds ?? DEFAULT_CONTROL_PERSIST_SECONDS;
  }

  get destination(): string {
    return sshDestination(this.profile);
  }

  get controlPath(): string {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          this.profile.name,
          this.profile.host,
          this.profile.user,
          this.profile.port,
          this.profile.identityFile,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
    return join(this.controlDir, `cm-${key}`);
  }

  baseArgs(): string[] {
    return this.connectionArgs('-p');
  }

  sshArgv(extra: readonly string[] = [], options?: { batchMode?: boolean }): string[] {
    return ['ssh', ...this.connectionArgs('-p', options), ...extra, this.destination];
  }

  async connect(): Promise<void> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    const result = await this.runSsh(['true'], (this.connectTimeoutSeconds + 5) * 1000);
    if (result.code !== 0) {
      throw toSshError(result, `cannot connect to ${this.destination}`, {
        needsPassword: classifySshError(result) === 'auth',
      });
    }
  }

  async status(): Promise<SshConnectionState> {
    const result = await this.runner.run(
      ['ssh', '-O', 'check', '-o', `ControlPath=${this.controlPath}`, this.destination],
      { timeoutMs: 5_000 },
    );
    return result.code === 0 ? 'connected' : 'disconnected';
  }

  async disconnect(): Promise<void> {
    await this.runner.run(
      ['ssh', '-O', 'exit', '-o', `ControlPath=${this.controlPath}`, this.destination],
      { timeoutMs: 5_000 },
    );
  }

  async exec(command: string, options?: { timeoutMs?: number }): Promise<RunResult> {
    return this.runSsh([command], options?.timeoutMs);
  }

  async execOrThrow(command: string, options?: { timeoutMs?: number }): Promise<string> {
    const result = await this.exec(command, options);
    if (result.code !== 0) {
      throw toSshError(result, `remote command failed on ${this.destination}: ${command}`, {
        needsPassword: classifySshError(result) === 'auth',
      });
    }
    return result.stdout;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    const remoteSpec = `${this.destination}:${shQuote(remotePath)}`;
    const result = await this.retryWithPassword(
      await this.runner.run(['scp', ...this.scpArgs(), localPath, remoteSpec], {
        timeoutMs: 120_000,
      }),
      () => ['scp', ...this.connectionArgs('-P', { batchMode: false }), localPath, remoteSpec],
      120_000,
    );
    if (result.code !== 0) {
      throw toSshError(result, `cannot upload ${localPath} to ${this.destination}`, {
        needsPassword: classifySshError(result) === 'auth',
      });
    }
  }

  private scpArgs(): string[] {
    return this.connectionArgs('-P');
  }

  private connectionArgs(portFlag: '-p' | '-P', options?: { batchMode?: boolean }): string[] {
    const args = [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${this.controlPath}`,
      '-o',
      `ControlPersist=${this.controlPersistSeconds}`,
    ];
    if (options?.batchMode ?? true) {
      args.push('-o', 'BatchMode=yes');
    }
    args.push(
      '-o',
      `ConnectTimeout=${this.connectTimeoutSeconds}`,
      portFlag,
      String(this.profile.port),
    );
    if (this.profile.identityFile !== undefined) {
      args.push('-i', this.profile.identityFile);
    }
    return args;
  }

  private async runSsh(extra: readonly string[], timeoutMs?: number): Promise<RunResult> {
    return this.retryWithPassword(
      await this.runner.run([...this.sshArgv(), ...extra], { timeoutMs }),
      () => [...this.sshArgv([], { batchMode: false }), ...extra],
      timeoutMs,
    );
  }

  private async retryWithPassword(
    first: RunResult,
    retryArgv: () => string[],
    timeoutMs?: number,
  ): Promise<RunResult> {
    if (
      first.code === 0 ||
      classifySshError(first) !== 'auth' ||
      this.password === undefined ||
      this.password.length === 0
    ) {
      return first;
    }
    return this.runWithAskpass(retryArgv(), this.password, timeoutMs);
  }

  private async runWithAskpass(
    argv: readonly string[],
    password: string,
    timeoutMs?: number,
  ): Promise<RunResult> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    const scriptPath = join(this.controlDir, `askpass-${randomBytes(8).toString('hex')}.sh`);
    await writeFile(scriptPath, ASKPASS_SCRIPT, { mode: 0o700 });
    try {
      return await this.runner.run(argv, {
        timeoutMs,
        env: {
          SSH_ASKPASS: scriptPath,
          SSH_ASKPASS_REQUIRE: 'force',
          [ASKPASS_PASSWORD_ENV]: password,
        },
      });
    } finally {
      await rm(scriptPath, { force: true }).catch(() => {});
    }
  }
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function classifySshError(result: RunResult): SshErrorKind {
  const stderr = result.stderr;
  if (result.code === 127 || /command not found/i.test(stderr)) {
    return 'remote-missing-binary';
  }
  if (/permission denied/i.test(stderr)) {
    return 'auth';
  }
  if (
    /could not resolve hostname|name or service not known|temporary failure in name resolution|no route to host|operation timed out|connection timed out/i.test(
      stderr,
    )
  ) {
    return 'host-unreachable';
  }
  if (
    /connection refused|network is unreachable|connection reset|broken pipe|connection closed|host is down/i.test(
      stderr,
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

export function toSshError(
  result: RunResult,
  context: string,
  options?: { needsPassword?: boolean },
): SshRemoteError {
  const kind = classifySshError(result);
  const detail = result.stderr.trim();
  return new SshRemoteError(
    kind,
    detail.length > 0 ? `${context}: ${detail}` : `${context} (exit code ${result.code})`,
    { stderr: result.stderr, needsPassword: options?.needsPassword },
  );
}
