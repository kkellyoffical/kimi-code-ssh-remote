import { Socket, createServer } from 'node:net';

import { SshRemoteError, errorMessage } from './errors';
import type { SpawnedProcess } from './runner';
import type { SshClient } from './ssh';

export type TunnelState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

export interface TunnelStatus {
  readonly state: TunnelState;
  readonly localPort?: number;
  readonly remotePort: number;
  readonly attempts: number;
  readonly lastError?: string;
}

export interface SshTunnelOptions {
  readonly client: SshClient;
  readonly remotePort: number;
  readonly localPort?: number;
  readonly pickFreePort?: () => Promise<number>;
  readonly probeLocalPort?: (port: number) => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly readyTimeoutMs?: number;
  readonly readyPollIntervalMs?: number;
  readonly maxReconnectAttempts?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly onStateChange?: (status: TunnelStatus) => void;
}

export type SshTunnelTuning = Partial<
  Pick<
    SshTunnelOptions,
    | 'pickFreePort'
    | 'probeLocalPort'
    | 'sleep'
    | 'readyTimeoutMs'
    | 'readyPollIntervalMs'
    | 'maxReconnectAttempts'
    | 'reconnectBaseDelayMs'
    | 'reconnectMaxDelayMs'
    | 'onStateChange'
  >
>;

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class SshTunnel {
  private state: TunnelState = 'disconnected';
  private attempts = 0;
  private lastErrorText?: string;
  private localPortValue?: number;
  private child?: SpawnedProcess;
  private stderrTail = '';
  private reconnecting = false;

  constructor(private readonly options: SshTunnelOptions) {}

  get localPort(): number | undefined {
    return this.localPortValue;
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      localPort: this.localPortValue,
      remotePort: this.options.remotePort,
      attempts: this.attempts,
      lastError: this.lastErrorText,
    };
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'reconnecting') {
      return;
    }
    this.transition('connecting');
    try {
      this.localPortValue =
        this.options.localPort ?? (await (this.options.pickFreePort ?? pickFreeLocalPort)());
      await this.establish();
    } catch (error) {
      this.child = undefined;
      this.lastErrorText = errorMessage(error);
      if (!this.isStopped()) this.transition('failed');
      throw error;
    }
    if (this.isStopped()) return;
    this.attempts = 0;
    this.lastErrorText = undefined;
    this.transition('connected');
  }

  async disconnect(): Promise<void> {
    if (this.isStopped()) return;
    this.transition('stopped');
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) {
      child.kill();
      await child.exited.catch(() => {});
    }
  }

  private isStopped(): boolean {
    return this.state === 'stopped';
  }

  private transition(state: TunnelState): void {
    this.state = state;
    this.options.onStateChange?.(this.status());
  }

  private tunnelArgv(): string[] {
    const local = this.localPortValue;
    const forward = `127.0.0.1:${local}:127.0.0.1:${this.options.remotePort}`;
    return this.options.client.sshArgv([
      '-N',
      '-T',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-L',
      forward,
    ]);
  }

  private async establish(): Promise<void> {
    const child = this.options.client.runner.spawn(this.tunnelArgv(), {
      onStderr: (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
      },
    });
    this.child = child;
    this.watchChild(child);
    const probe = this.options.probeLocalPort ?? probeTcp;
    const sleep = this.options.sleep ?? defaultSleep;
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const intervalMs = this.options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
    const local = this.localPortValue;
    let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    void child.exited.then((info) => {
      earlyExit = info;
    });
    let waited = 0;
    for (;;) {
      if (earlyExit !== undefined) {
        const detail = this.stderrTail.trim();
        throw new SshRemoteError(
          'network',
          `ssh tunnel process exited before the forward was ready (code ${earlyExit.code})${detail.length > 0 ? `: ${detail}` : ''}`,
          { stderr: this.stderrTail },
        );
      }
      if (local !== undefined && (await probe(local))) return;
      if (waited >= timeoutMs) {
        child.kill();
        throw new SshRemoteError(
          'network',
          `timed out after ${timeoutMs}ms waiting for the ssh tunnel on 127.0.0.1:${local}`,
        );
      }
      await sleep(intervalMs);
      waited += intervalMs;
    }
  }

  private watchChild(child: SpawnedProcess): void {
    void child.exited.then((info) => {
      if (this.child !== child || this.state !== 'connected' || this.reconnecting) return;
      this.child = undefined;
      const detail = this.stderrTail.trim();
      this.lastErrorText =
        detail.length > 0
          ? detail
          : `ssh tunnel process exited (code ${info.code}, signal ${info.signal ?? 'none'})`;
      void this.reconnectLoop();
    });
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting || this.isStopped()) return;
    this.reconnecting = true;
    const sleep = this.options.sleep ?? defaultSleep;
    const maxAttempts = this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const baseDelayMs = this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const maxDelayMs = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.transition('reconnecting');
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        this.attempts = attempt;
        this.options.onStateChange?.(this.status());
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(backoff + Math.floor(Math.random() * baseDelayMs));
        if (this.state === 'stopped') return;
        try {
          this.stderrTail = '';
          await this.establish();
        } catch (error) {
          this.lastErrorText = errorMessage(error);
          continue;
        }
        if (this.isStopped()) return;
        this.attempts = 0;
        this.lastErrorText = undefined;
        this.transition('connected');
        return;
      }
      this.transition('failed');
    } finally {
      this.reconnecting = false;
    }
  }
}

export async function pickFreeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : undefined;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (port === undefined) {
    throw new SshRemoteError('unknown', 'could not allocate a free local TCP port');
  }
  return port;
}

async function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}
