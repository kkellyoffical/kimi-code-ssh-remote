import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { SshRemoteError, type SshErrorKind } from './errors';
import { sshDestination, type SshConnectionProfile } from './profile';
import type { ProcessRunner, RunResult } from './runner';

export type SshConnectionState = 'connected' | 'disconnected';

export interface SshClientOptions {
  readonly profile: SshConnectionProfile;
  readonly runner: ProcessRunner;
  readonly controlDir: string;
  readonly connectTimeoutSeconds?: number;
  readonly controlPersistSeconds?: number;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_CONTROL_PERSIST_SECONDS = 60;

export class SshClient {
  readonly profile: SshConnectionProfile;
  readonly runner: ProcessRunner;

  private readonly controlDir: string;
  private readonly connectTimeoutSeconds: number;
  private readonly controlPersistSeconds: number;

  constructor(options: SshClientOptions) {
    this.profile = options.profile;
    this.runner = options.runner;
    this.controlDir = options.controlDir;
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

  sshArgv(extra: readonly string[] = []): string[] {
    return ['ssh', ...this.baseArgs(), ...extra, this.destination];
  }

  async connect(): Promise<void> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    const result = await this.runner.run([...this.sshArgv(), 'true'], {
      timeoutMs: (this.connectTimeoutSeconds + 5) * 1000,
    });
    if (result.code !== 0) {
      throw toSshError(result, `cannot connect to ${this.destination}`);
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
    return this.runner.run([...this.sshArgv(), command], { timeoutMs: options?.timeoutMs });
  }

  async execOrThrow(command: string, options?: { timeoutMs?: number }): Promise<string> {
    const result = await this.exec(command, options);
    if (result.code !== 0) {
      throw toSshError(result, `remote command failed on ${this.destination}: ${command}`);
    }
    return result.stdout;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    const result = await this.runner.run(
      ['scp', ...this.scpArgs(), localPath, `${this.destination}:${shQuote(remotePath)}`],
      { timeoutMs: 120_000 },
    );
    if (result.code !== 0) {
      throw toSshError(result, `cannot upload ${localPath} to ${this.destination}`);
    }
  }

  private scpArgs(): string[] {
    return this.connectionArgs('-P');
  }

  private connectionArgs(portFlag: '-p' | '-P'): string[] {
    const args = [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${this.controlPath}`,
      '-o',
      `ControlPersist=${this.controlPersistSeconds}`,
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${this.connectTimeoutSeconds}`,
      portFlag,
      String(this.profile.port),
    ];
    if (this.profile.identityFile !== undefined) {
      args.push('-i', this.profile.identityFile);
    }
    return args;
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

export function toSshError(result: RunResult, context: string): SshRemoteError {
  const kind = classifySshError(result);
  const detail = result.stderr.trim();
  return new SshRemoteError(
    kind,
    detail.length > 0 ? `${context}: ${detail}` : `${context} (exit code ${result.code})`,
    { stderr: result.stderr },
  );
}
