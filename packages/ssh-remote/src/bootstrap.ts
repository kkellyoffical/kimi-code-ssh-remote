import { randomBytes } from 'node:crypto';

import { SshRemoteError } from './errors';
import { shQuote, toSshError, type SshClient } from './ssh';

export type RemotePlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

export const REMOTE_SERVER_HOST = '127.0.0.1';
export const DEFAULT_REMOTE_SERVER_PORT = 58627;
export const REMOTE_KIMI_RELATIVE_PATH = 'bin/kimi';
export const REMOTE_SERVER_TOKEN_FILE = 'server.token';

export interface BootstrapOptions {
  readonly client: SshClient;
  readonly remotePort?: number;
  readonly resolveLocalBinary?: (
    platform: RemotePlatform,
  ) => string | undefined | Promise<string | undefined>;
  readonly readyTimeoutMs?: number;
  readonly tokenTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: (line: string) => void;
}

export interface BootstrapResult {
  readonly platform: RemotePlatform;
  readonly kimiPath: string;
  readonly remoteHome: string;
  readonly remotePort: number;
  readonly token: string;
  readonly serverStarted: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function bootstrapRemote(options: BootstrapOptions): Promise<BootstrapResult> {
  const { client } = options;
  const remotePort = options.remotePort ?? DEFAULT_REMOTE_SERVER_PORT;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? 30_000;
  const log = options.logger ?? ((): void => {});

  const probe = await probeRemote(client, { remotePort });
  log(`remote platform: ${probe.platform}`);

  let kimiPath = probe.kimiPath;
  if (kimiPath === undefined) {
    kimiPath = await installRemoteKimi(client, options, probe.platform, probe.remoteHome, log);
  } else {
    log(`remote kimi found at ${kimiPath}`);
  }

  const origin = `http://${REMOTE_SERVER_HOST}:${remotePort}`;
  let serverStarted = false;
  if (probe.serverRunning) {
    log(`remote kimi web already listening on ${origin}`);
  } else {
    await startRemoteServer(client, kimiPath, probe.remoteHome, remotePort, log);
    serverStarted = true;
    await waitFor(() => healthProbe(client, origin), {
      timeoutMs: readyTimeoutMs,
      intervalMs: pollIntervalMs,
      sleep,
      description: `remote kimi web to listen on ${origin} (see ${probe.remoteHome}/logs/web.log on the remote)`,
    });
  }

  const token = await readRemoteToken(client, probe.remoteHome, {
    timeoutMs: tokenTimeoutMs,
    intervalMs: pollIntervalMs,
    sleep,
  });

  return {
    platform: probe.platform,
    kimiPath,
    remoteHome: probe.remoteHome,
    remotePort,
    token,
    serverStarted,
  };
}

export interface RemoteProbeResult {
  readonly platform: RemotePlatform;
  readonly remoteHome: string;
  readonly kimiPath?: string;
  readonly serverRunning: boolean;
}

export async function probeRemote(
  client: SshClient,
  options?: { remotePort?: number },
): Promise<RemoteProbeResult> {
  const platform = await detectPlatform(client);
  const probe = await probeRemoteKimi(client);
  const serverRunning = await healthProbe(
    client,
    `http://${REMOTE_SERVER_HOST}:${options?.remotePort ?? DEFAULT_REMOTE_SERVER_PORT}`,
  );
  return {
    platform,
    remoteHome: probe.remoteHome,
    kimiPath: probe.kimiPath,
    serverRunning,
  };
}

export async function detectPlatform(client: SshClient): Promise<RemotePlatform> {
  const stdout = await client.execOrThrow('uname -s && uname -m', { timeoutMs: 15_000 });
  const [osLine, archLine] = stdout.trim().split('\n');
  const os = osLine?.trim();
  const arch = archLine?.trim();
  const osKey = os === 'Linux' ? 'linux' : os === 'Darwin' ? 'darwin' : undefined;
  const archKey =
    arch === 'x86_64' || arch === 'amd64'
      ? 'x64'
      : arch === 'arm64' || arch === 'aarch64'
        ? 'arm64'
        : undefined;
  if (osKey === undefined || archKey === undefined) {
    throw new SshRemoteError(
      'unknown',
      `unsupported remote platform: ${os ?? '?'} ${arch ?? '?'} (expected Linux/Darwin on x64/arm64)`,
    );
  }
  return `${osKey}-${archKey}`;
}

interface RemoteKimiProbe {
  readonly remoteHome: string;
  readonly kimiPath?: string;
}

async function probeRemoteKimi(client: SshClient): Promise<RemoteKimiProbe> {
  const command = [
    'kh="${KIMI_CODE_HOME:-$HOME/.kimi-code}"',
    'printf \'%s\\n\' "$kh"',
    `command -v kimi 2>/dev/null || { [ -x "$kh/${REMOTE_KIMI_RELATIVE_PATH}" ] && printf '%s\\n' "$kh/${REMOTE_KIMI_RELATIVE_PATH}"; }`,
  ].join('; ');
  const stdout = await client.execOrThrow(command, { timeoutMs: 15_000 });
  const [homeLine, kimiLine] = stdout.split('\n');
  const remoteHome = homeLine?.trim();
  if (remoteHome === undefined || remoteHome.length === 0) {
    throw new SshRemoteError('unknown', 'could not resolve the remote KIMI_CODE_HOME directory');
  }
  const kimiPath = kimiLine?.trim();
  return {
    remoteHome,
    kimiPath: kimiPath !== undefined && kimiPath.length > 0 ? kimiPath : undefined,
  };
}

async function installRemoteKimi(
  client: SshClient,
  options: BootstrapOptions,
  platform: RemotePlatform,
  remoteHome: string,
  log: (line: string) => void,
): Promise<string> {
  const localBinary = await options.resolveLocalBinary?.(platform);
  if (localBinary === undefined) {
    throw new SshRemoteError(
      'remote-missing-binary',
      `the remote has no kimi installation and no local kimi binary is available for ${platform}`,
    );
  }
  const remoteBinDir = `${remoteHome}/bin`;
  const remoteKimi = `${remoteBinDir}/kimi`;
  const uploadPath = `${remoteBinDir}/.kimi-upload-${randomBytes(6).toString('hex')}`;
  log(`installing kimi on the remote from ${localBinary}`);
  await client.execOrThrow(`mkdir -p ${shQuote(remoteBinDir)}`, { timeoutMs: 15_000 });
  await client.upload(localBinary, uploadPath);
  await client.execOrThrow(
    `chmod 755 ${shQuote(uploadPath)} && mv ${shQuote(uploadPath)} ${shQuote(remoteKimi)}`,
    { timeoutMs: 30_000 },
  );
  return remoteKimi;
}

async function healthProbe(client: SshClient, origin: string): Promise<boolean> {
  const command = `curl -sf -o /dev/null --max-time 3 ${shQuote(`${origin}/api/v1/healthz`)} 2>/dev/null || wget -q -O /dev/null -T 3 ${shQuote(`${origin}/api/v1/healthz`)} 2>/dev/null`;
  const result = await client.exec(command, { timeoutMs: 10_000 });
  return result.code === 0;
}

async function startRemoteServer(
  client: SshClient,
  kimiPath: string,
  remoteHome: string,
  remotePort: number,
  log: (line: string) => void,
): Promise<void> {
  const logDir = `${remoteHome}/logs`;
  const command = [
    `mkdir -p ${shQuote(logDir)}`,
    `nohup ${shQuote(kimiPath)} web --host ${REMOTE_SERVER_HOST} --port ${remotePort} --no-open </dev/null >>${shQuote(`${logDir}/web.log`)} 2>&1 & printf '%s' $!`,
  ].join('; ');
  const result = await client.exec(command, { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw toSshError(result, 'could not start kimi web on the remote');
  }
  const pid = result.stdout.trim();
  log(`remote kimi web started (pid ${pid}) on ${REMOTE_SERVER_HOST}:${remotePort}`);
}

async function readRemoteToken(
  client: SshClient,
  remoteHome: string,
  options: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const tokenPath = `${remoteHome}/${REMOTE_SERVER_TOKEN_FILE}`;
  return waitFor(
    async () => {
      const result = await client.exec(`cat ${shQuote(tokenPath)} 2>/dev/null`, {
        timeoutMs: 10_000,
      });
      const token = result.stdout.trim();
      return result.code === 0 && token.length > 0 ? token : undefined;
    },
    { ...options, description: `the remote server token at ${tokenPath}` },
  );
}

async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
    description: string;
  },
): Promise<T> {
  let waited = 0;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (waited >= options.timeoutMs) {
      throw new SshRemoteError(
        'unknown',
        `timed out after ${options.timeoutMs}ms waiting for ${options.description}`,
      );
    }
    await options.sleep(options.intervalMs);
    waited += options.intervalMs;
  }
}
