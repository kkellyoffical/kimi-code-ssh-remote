import { join } from 'node:path';

import {
  bootstrapRemote,
  probeRemote,
  type BootstrapOptions,
  type RemotePlatform,
} from './bootstrap';
import { SshRemoteError, errorMessage, isNeedsPasswordError, type SshHostKeyDetails } from './errors';
import { forgetRemoteHostKey, scanRemoteHostKey, type SshHostKeyScan } from './hostkeys';
import { resolveKimiHome, type SshConnectionProfile, type SshConnectionProfileInput } from './profile';
import { createSystemProcessRunner, type ProcessRunner } from './runner';
import { SecretsStore } from './secrets';
import { SshClient } from './ssh';
import { ConnectionStore } from './store';
import { SshTunnel, type SshTunnelTuning, type TunnelState } from './tunnel';

export type SshManagerState = 'off' | 'connecting' | 'on' | 'error';

export interface SshConnectionStatus {
  readonly state: SshManagerState;
  readonly localOrigin?: string;
  readonly error?: string;
  readonly needsPassword?: boolean;
  readonly hostKey?: SshHostKeyDetails;
  readonly reconnecting?: boolean;
}

export type SshConnectionSpec = SshConnectionProfileInput;

export interface SshAuthOptions {
  readonly password?: string;
  readonly savePassword?: boolean;
}

export interface SshConnectionInfo {
  readonly name: string;
  readonly host: string;
  readonly user?: string;
  readonly port: number;
  readonly identityFile?: string;
  readonly strictHostKeyChecking?: boolean;
  readonly hasPassword?: boolean;
  readonly status: SshConnectionStatus;
}

export interface SshTestResult {
  readonly ok: boolean;
  readonly platform?: RemotePlatform;
  readonly kimiPath?: string;
  readonly serverRunning?: boolean;
  readonly error?: string;
  readonly needsPassword?: boolean;
  readonly hostKey?: SshHostKeyDetails;
}

export interface SshConnectionHandle {
  readonly localOrigin: string;
  readonly remoteToken: string;
}

export interface SshConnectionManager {
  list(): Promise<readonly SshConnectionInfo[]>;
  add(spec: SshConnectionSpec): Promise<SshConnectionInfo>;
  remove(name: string): Promise<void>;
  setPassword(name: string, password: string): Promise<void>;
  clearPassword(name: string): Promise<void>;
  scanHostKey(name: string): Promise<SshHostKeyScan>;
  forgetHostKey(name: string): Promise<void>;
  test(name: string, options?: SshAuthOptions): Promise<SshTestResult>;
  connect(name: string, options?: SshAuthOptions): Promise<SshConnectionHandle>;
  disconnect(name: string): Promise<void>;
  status(name: string): SshConnectionStatus;
  close(): Promise<void>;
}

export interface SshConnectionManagerOptions {
  readonly homeDir?: string;
  readonly runner?: ProcessRunner;
  readonly resolveLocalBinary?: BootstrapOptions['resolveLocalBinary'];
  readonly bootstrap?: Partial<
    Pick<BootstrapOptions, 'readyTimeoutMs' | 'tokenTimeoutMs' | 'pollIntervalMs' | 'sleep'>
  >;
  readonly tunnel?: SshTunnelTuning;
  readonly reconnectWaitTimeoutMs?: number;
  readonly logger?: (line: string) => void;
}

interface ManagedConnection {
  state: SshManagerState;
  client?: SshClient;
  tunnel?: SshTunnel;
  handle?: SshConnectionHandle;
  error?: string;
  needsPassword?: boolean;
  hostKey?: SshHostKeyDetails;
  pending?: Promise<SshConnectionHandle>;
  reconnecting?: boolean;
  stateWaiters?: Set<() => void>;
}

const DEFAULT_RECONNECT_WAIT_TIMEOUT_MS = 30_000;

export function createSshConnectionManager(
  options: SshConnectionManagerOptions = {},
): SshConnectionManager {
  const homeDir = options.homeDir ?? resolveKimiHome();
  const runner = options.runner ?? createSystemProcessRunner();
  const store = new ConnectionStore(homeDir);
  const secrets = new SecretsStore(homeDir);
  const active = new Map<string, ManagedConnection>();
  let closed = false;

  const clientFor = (profile: SshConnectionProfile, password?: string): SshClient =>
    new SshClient({
      profile,
      runner,
      controlDir: join(homeDir, 'ssh', 'sockets'),
      password,
    });

  const resolvePassword = async (
    name: string,
    options?: SshAuthOptions,
  ): Promise<string | undefined> => options?.password ?? (await secrets.getPassword(name));

  const normalizeAuth = (options?: SshAuthOptions): SshAuthOptions | undefined => {
    if (options?.password === undefined || options.password.length > 0) return options;
    return { ...options, password: undefined };
  };

  const statusOf = (name: string): SshConnectionStatus => {
    const entry = active.get(name);
    if (entry === undefined) return { state: 'off' };
    return {
      state: entry.state,
      localOrigin: entry.handle?.localOrigin,
      error: entry.error,
      needsPassword: entry.needsPassword,
      hostKey: entry.hostKey,
      reconnecting: entry.reconnecting,
    };
  };

  const requireProfile = async (name: string): Promise<SshConnectionProfile> => {
    const profile = await store.get(name);
    if (profile === undefined) {
      throw new SshRemoteError('config', `ssh connection "${name}" not found`);
    }
    return profile;
  };

  const wakeWaiters = (entry: ManagedConnection): void => {
    if (entry.stateWaiters === undefined) return;
    for (const wake of entry.stateWaiters) wake();
  };

  const onTunnelState = (
    name: string,
    entry: ManagedConnection,
    state: TunnelState,
    lastError?: string,
  ): void => {
    if (active.get(name) !== entry) return;
    if (state === 'connected') {
      entry.state = 'on';
      entry.reconnecting = undefined;
      entry.error = undefined;
      entry.hostKey = undefined;
    } else if (state === 'reconnecting') {
      entry.state = 'connecting';
      entry.reconnecting = true;
    } else if (state === 'failed') {
      entry.state = 'error';
      entry.reconnecting = undefined;
      entry.error = lastError ?? 'ssh tunnel failed';
      entry.handle = undefined;
    } else if (state === 'stopped' && entry.state !== 'error') {
      entry.state = 'off';
      entry.reconnecting = undefined;
      entry.handle = undefined;
    }
    wakeWaiters(entry);
  };

  const waitForStateChange = (entry: ManagedConnection, timeoutMs: number): Promise<void> => {
    let wake: () => void = () => {};
    const notified = new Promise<void>((resolve) => {
      wake = () => {
        entry.stateWaiters?.delete(wake);
        resolve();
      };
      entry.stateWaiters ??= new Set();
      entry.stateWaiters.add(wake);
    });
    const elapsed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        entry.stateWaiters?.delete(wake);
        resolve();
      }, timeoutMs);
      timer.unref();
    });
    return Promise.race([notified, elapsed]);
  };

  const waitForReconnect = async (
    name: string,
    entry: ManagedConnection,
  ): Promise<SshConnectionHandle | undefined> => {
    const deadline =
      Date.now() + (options.reconnectWaitTimeoutMs ?? DEFAULT_RECONNECT_WAIT_TIMEOUT_MS);
    for (;;) {
      if (active.get(name) !== entry) return undefined;
      if (entry.state === 'on' && entry.handle !== undefined) return entry.handle;
      if (entry.state !== 'connecting') return undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        options.logger?.(`ssh connection "${name}" timed out waiting for the tunnel to reconnect`);
        return undefined;
      }
      await waitForStateChange(entry, remaining);
    }
  };

  const takeOver = async (
    stale: ManagedConnection | undefined,
    entry: ManagedConnection,
  ): Promise<void> => {
    if (stale === undefined || stale === entry) return;
    wakeWaiters(stale);
    await stale.tunnel?.disconnect().catch(() => {});
    await stale.client?.disconnect().catch(() => {});
  };

  const startEstablish = (
    name: string,
    connectOptions: SshAuthOptions | undefined,
    stale: ManagedConnection | undefined,
  ): Promise<SshConnectionHandle> => {
    const entry: ManagedConnection = { state: 'connecting' };
    active.set(name, entry);
    const pending = takeOver(stale, entry)
      .then(() => establish(name, entry, normalizeAuth(connectOptions)))
      .catch((error: unknown) => {
        entry.state = 'error';
        entry.error = errorMessage(error);
        entry.needsPassword = isNeedsPasswordError(error);
        entry.hostKey = error instanceof SshRemoteError ? error.hostKey : undefined;
        throw error;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    entry.pending = pending;
    void pending.catch(() => {});
    return pending;
  };

  const connect = (name: string, options?: SshAuthOptions): Promise<SshConnectionHandle> => {
    if (closed) {
      return Promise.reject(new SshRemoteError('unknown', 'ssh connection manager is closed'));
    }
    const existing = active.get(name);
    if (existing?.state === 'on' && existing.handle !== undefined) {
      return Promise.resolve(existing.handle);
    }
    if (existing?.state === 'connecting' && existing.pending !== undefined) {
      return existing.pending;
    }
    if (existing?.state === 'connecting') {
      return waitForReconnect(name, existing).then((handle) => {
        if (handle !== undefined) return handle;
        const current = active.get(name);
        if (current !== undefined && current !== existing) {
          return connect(name, options);
        }
        return startEstablish(name, options, existing);
      });
    }
    return startEstablish(name, options, existing);
  };

  const establish = async (
    name: string,
    entry: ManagedConnection,
    connectOptions?: SshAuthOptions,
  ): Promise<SshConnectionHandle> => {
    const profile = await requireProfile(name);
    const client = clientFor(profile, await resolvePassword(name, connectOptions));
    entry.client = client;
    try {
      await client.connect();
      if (connectOptions?.savePassword === true && connectOptions.password !== undefined) {
        await secrets.setPassword(name, connectOptions.password);
      }
      const boot = await bootstrapRemote({
        client,
        resolveLocalBinary: options.resolveLocalBinary,
        logger: options.logger,
        ...options.bootstrap,
      });
      const tunnel = new SshTunnel({
        client,
        remotePort: boot.remotePort,
        ...options.tunnel,
        onStateChange: (status) => {
          options.tunnel?.onStateChange?.(status);
          onTunnelState(name, entry, status.state, status.lastError);
        },
      });
      entry.tunnel = tunnel;
      await tunnel.connect();
      const localPort = tunnel.localPort;
      if (localPort === undefined) {
        throw new SshRemoteError('unknown', 'ssh tunnel connected without a local port');
      }
      const handle: SshConnectionHandle = {
        localOrigin: `http://127.0.0.1:${localPort}`,
        remoteToken: boot.token,
      };
      if (active.get(name) !== entry) {
        await tunnel.disconnect();
        await client.disconnect().catch(() => {});
        throw new SshRemoteError(
          'unknown',
          `ssh connection "${name}" was disconnected while connecting`,
        );
      }
      entry.handle = handle;
      entry.state = 'on';
      entry.error = undefined;
      entry.needsPassword = undefined;
      entry.hostKey = undefined;
      return handle;
    } catch (error) {
      await client.disconnect().catch(() => {});
      throw error;
    }
  };

  const disconnect = async (name: string): Promise<void> => {
    const entry = active.get(name);
    if (entry === undefined) return;
    active.delete(name);
    wakeWaiters(entry);
    await entry.tunnel?.disconnect();
    await entry.client?.disconnect().catch(() => {});
  };

  return {
    async list() {
      const profiles = await store.list();
      return Promise.all(
        profiles.map(async (profile) => ({
          name: profile.name,
          host: profile.host,
          user: profile.user,
          port: profile.port,
          identityFile: profile.identityFile,
          strictHostKeyChecking: profile.strictHostKeyChecking,
          hasPassword: await secrets.hasPassword(profile.name),
          status: statusOf(profile.name),
        })),
      );
    },
    async add(spec) {
      const profile = await store.add(spec);
      return {
        name: profile.name,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile,
        strictHostKeyChecking: profile.strictHostKeyChecking,
        hasPassword: false,
        status: statusOf(profile.name),
      };
    },
    async remove(name) {
      await disconnect(name);
      const removed = await store.remove(name);
      if (!removed) {
        throw new SshRemoteError('config', `ssh connection "${name}" not found`);
      }
      await secrets.removePassword(name);
    },
    async setPassword(name, password) {
      await requireProfile(name);
      await secrets.setPassword(name, password);
    },
    async clearPassword(name) {
      await secrets.removePassword(name);
    },
    async scanHostKey(name) {
      const profile = await requireProfile(name);
      return scanRemoteHostKey(profile, runner);
    },
    async forgetHostKey(name) {
      const profile = await requireProfile(name);
      await forgetRemoteHostKey(profile, runner);
    },
    async test(name, testOptions) {
      const auth = normalizeAuth(testOptions);
      const existing = active.get(name);
      const profile = await requireProfile(name);
      const reusable = auth?.password === undefined ? existing?.client : undefined;
      const client = reusable ?? clientFor(profile, await resolvePassword(name, auth));
      try {
        await client.connect();
        if (auth?.savePassword === true && auth.password !== undefined) {
          await secrets.setPassword(name, auth.password);
        }
        const probe = await probeRemote(client);
        return {
          ok: true,
          platform: probe.platform,
          kimiPath: probe.kimiPath,
          serverRunning: probe.serverRunning,
        };
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error),
          needsPassword: isNeedsPasswordError(error) ? true : undefined,
          hostKey: error instanceof SshRemoteError ? error.hostKey : undefined,
        };
      } finally {
        if (reusable === undefined) {
          await client.disconnect().catch(() => {});
        }
      }
    },
    connect,
    disconnect,
    status: statusOf,
    async close() {
      if (closed) return;
      closed = true;
      const names = [...active.keys()];
      await Promise.all(
        names.map(async (name) => {
          await disconnect(name).catch((error: unknown) => {
            options.logger?.(`ssh connection "${name}" failed to close: ${errorMessage(error)}`);
          });
        }),
      );
    },
  };
}
