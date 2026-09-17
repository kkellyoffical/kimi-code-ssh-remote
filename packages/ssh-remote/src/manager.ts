import { join } from 'node:path';

import {
  bootstrapRemote,
  probeRemote,
  type BootstrapOptions,
  type RemotePlatform,
} from './bootstrap';
import { SshRemoteError, errorMessage } from './errors';
import { resolveKimiHome, type SshConnectionProfile, type SshConnectionProfileInput } from './profile';
import { createSystemProcessRunner, type ProcessRunner } from './runner';
import { SshClient } from './ssh';
import { ConnectionStore } from './store';
import { SshTunnel, type SshTunnelTuning, type TunnelState } from './tunnel';

export type SshManagerState = 'off' | 'connecting' | 'on' | 'error';

export interface SshConnectionStatus {
  readonly state: SshManagerState;
  readonly localOrigin?: string;
  readonly error?: string;
}

export type SshConnectionSpec = SshConnectionProfileInput;

export interface SshConnectionInfo {
  readonly name: string;
  readonly host: string;
  readonly user?: string;
  readonly port: number;
  readonly identityFile?: string;
  readonly status: SshConnectionStatus;
}

export interface SshTestResult {
  readonly ok: boolean;
  readonly platform?: RemotePlatform;
  readonly kimiPath?: string;
  readonly serverRunning?: boolean;
  readonly error?: string;
}

export interface SshConnectionHandle {
  readonly localOrigin: string;
  readonly remoteToken: string;
}

export interface SshConnectionManager {
  list(): Promise<readonly SshConnectionInfo[]>;
  add(spec: SshConnectionSpec): Promise<SshConnectionInfo>;
  remove(name: string): Promise<void>;
  test(name: string): Promise<SshTestResult>;
  connect(name: string): Promise<SshConnectionHandle>;
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
  readonly logger?: (line: string) => void;
}

interface ManagedConnection {
  state: SshManagerState;
  client?: SshClient;
  tunnel?: SshTunnel;
  handle?: SshConnectionHandle;
  error?: string;
  pending?: Promise<SshConnectionHandle>;
}

export function createSshConnectionManager(
  options: SshConnectionManagerOptions = {},
): SshConnectionManager {
  const homeDir = options.homeDir ?? resolveKimiHome();
  const runner = options.runner ?? createSystemProcessRunner();
  const store = new ConnectionStore(homeDir);
  const active = new Map<string, ManagedConnection>();
  let closed = false;

  const clientFor = (profile: SshConnectionProfile): SshClient =>
    new SshClient({
      profile,
      runner,
      controlDir: join(homeDir, 'ssh', 'sockets'),
    });

  const statusOf = (name: string): SshConnectionStatus => {
    const entry = active.get(name);
    if (entry === undefined) return { state: 'off' };
    return {
      state: entry.state,
      localOrigin: entry.handle?.localOrigin,
      error: entry.error,
    };
  };

  const requireProfile = async (name: string): Promise<SshConnectionProfile> => {
    const profile = await store.get(name);
    if (profile === undefined) {
      throw new SshRemoteError('config', `ssh connection "${name}" not found`);
    }
    return profile;
  };

  const onTunnelState = (name: string, state: TunnelState, lastError?: string): void => {
    const entry = active.get(name);
    if (entry === undefined) return;
    if (state === 'connected') {
      entry.state = 'on';
      entry.error = undefined;
    } else if (state === 'reconnecting') {
      entry.state = 'connecting';
    } else if (state === 'failed') {
      entry.state = 'error';
      entry.error = lastError ?? 'ssh tunnel failed';
    } else if (state === 'stopped' && entry.state !== 'error') {
      entry.state = 'off';
      entry.handle = undefined;
    }
  };

  const connect = (name: string): Promise<SshConnectionHandle> => {
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
    const entry: ManagedConnection = { state: 'connecting' };
    active.set(name, entry);
    const pending = establish(name, entry)
      .catch((error: unknown) => {
        entry.state = 'error';
        entry.error = errorMessage(error);
        throw error;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    entry.pending = pending;
    void pending.catch(() => {});
    return pending;
  };

  const establish = async (
    name: string,
    entry: ManagedConnection,
  ): Promise<SshConnectionHandle> => {
    const profile = await requireProfile(name);
    const client = clientFor(profile);
    entry.client = client;
    try {
      await client.connect();
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
          onTunnelState(name, status.state, status.lastError);
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
    await entry.tunnel?.disconnect();
    await entry.client?.disconnect().catch(() => {});
  };

  return {
    async list() {
      const profiles = await store.list();
      return profiles.map((profile) => ({
        name: profile.name,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile,
        status: statusOf(profile.name),
      }));
    },
    async add(spec) {
      const profile = await store.add(spec);
      return {
        name: profile.name,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile,
        status: statusOf(profile.name),
      };
    },
    async remove(name) {
      await disconnect(name);
      const removed = await store.remove(name);
      if (!removed) {
        throw new SshRemoteError('config', `ssh connection "${name}" not found`);
      }
    },
    async test(name) {
      const existing = active.get(name);
      const profile = await requireProfile(name);
      const client = existing?.client ?? clientFor(profile);
      try {
        await client.connect();
        const probe = await probeRemote(client);
        return {
          ok: true,
          platform: probe.platform,
          kimiPath: probe.kimiPath,
          serverRunning: probe.serverRunning,
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      } finally {
        if (existing === undefined) {
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
