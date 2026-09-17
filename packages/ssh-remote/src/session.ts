import { join } from 'node:path';

import { bootstrapRemote, type BootstrapOptions, type RemotePlatform } from './bootstrap';
import type { SshConnectionProfile } from './profile';
import { resolveKimiHome } from './profile';
import { createSystemProcessRunner, type ProcessRunner } from './runner';
import { SshClient } from './ssh';
import { SshTunnel, type SshTunnelTuning, type TunnelStatus } from './tunnel';

export interface SshRemoteSession {
  readonly profile: SshConnectionProfile;
  readonly platform: RemotePlatform;
  readonly token: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly localOrigin: string;
  status(): TunnelStatus;
  close(): Promise<void>;
}

export interface OpenSshRemoteSessionOptions {
  readonly profile: SshConnectionProfile;
  readonly homeDir?: string;
  readonly runner?: ProcessRunner;
  readonly remotePort?: number;
  readonly localPort?: number;
  readonly resolveLocalBinary?: BootstrapOptions['resolveLocalBinary'];
  readonly bootstrap?: Partial<
    Pick<BootstrapOptions, 'readyTimeoutMs' | 'tokenTimeoutMs' | 'pollIntervalMs' | 'sleep'>
  >;
  readonly tunnel?: SshTunnelTuning;
  readonly logger?: (line: string) => void;
}

export async function openSshRemoteSession(
  options: OpenSshRemoteSessionOptions,
): Promise<SshRemoteSession> {
  const runner = options.runner ?? createSystemProcessRunner();
  const homeDir = options.homeDir ?? resolveKimiHome();
  const client = new SshClient({
    profile: options.profile,
    runner,
    controlDir: join(homeDir, 'ssh', 'sockets'),
  });
  await client.connect();
  try {
    const boot = await bootstrapRemote({
      client,
      remotePort: options.remotePort,
      resolveLocalBinary: options.resolveLocalBinary,
      logger: options.logger,
      ...options.bootstrap,
    });
    const tunnel = new SshTunnel({
      client,
      remotePort: boot.remotePort,
      localPort: options.localPort,
      ...options.tunnel,
    });
    await tunnel.connect();
    const localPort = tunnel.localPort;
    if (localPort === undefined) {
      throw new Error('ssh tunnel connected without a local port');
    }
    return {
      profile: options.profile,
      platform: boot.platform,
      token: boot.token,
      remotePort: boot.remotePort,
      localPort,
      localOrigin: `http://127.0.0.1:${localPort}`,
      status: () => tunnel.status(),
      close: async () => {
        await tunnel.disconnect();
        await client.disconnect();
      },
    };
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}
