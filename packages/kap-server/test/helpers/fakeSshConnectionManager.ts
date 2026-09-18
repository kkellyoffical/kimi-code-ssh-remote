import {
  SshRemoteError,
  sshConnectionProfileSchema,
  type SshAuthOptions,
  type SshConnectionHandle,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshConnectionSpec,
  type SshConnectionStatus,
  type SshErrorKind,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';

export interface FakeHostKeyDetails {
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly keyType?: string;
  readonly expectedFingerprint?: string;
  readonly knownHostsFile?: string;
  readonly knownHostsLine?: number;
}

export interface FakeHostKeyScan {
  readonly host: string;
  readonly port: number;
  readonly keys: readonly { readonly type: string; readonly fingerprint: string }[];
}

export interface FakeSshConnectionManager extends SshConnectionManager {
  readonly connectCalls: string[];
  readonly connectOptions: (SshAuthOptions | undefined)[];
  readonly forgottenHostKeys: string[];
  setHandle(name: string, handle: SshConnectionHandle | undefined): void;
  setConnectError(name: string, error: Error | undefined): void;
  setAuthRequired(name: string, required: boolean): void;
  setHostKeyChanged(name: string, details: FakeHostKeyDetails | undefined): void;
  setHostKeyScan(name: string, scan: FakeHostKeyScan | undefined): void;
  savedPassword(name: string): string | undefined;
  scanHostKey(name: string): Promise<FakeHostKeyScan>;
  forgetHostKey(name: string): Promise<void>;
}

export interface FakeSshConnectionManagerOptions {
  readonly handleFor?: (name: string) => SshConnectionHandle | undefined;
  readonly testResult?: SshTestResult;
}

interface FakeEntry {
  readonly spec: {
    name: string;
    host: string;
    user?: string;
    port: number;
    identityFile?: string;
  };
  state: 'off' | 'on';
  handle?: SshConnectionHandle;
  connectError?: Error;
  authRequired: boolean;
  password?: string;
  needsPassword: boolean;
  hostKeyChanged?: FakeHostKeyDetails;
  hostKeyScan?: FakeHostKeyScan;
}

function hostKeyChangedError(details: FakeHostKeyDetails): SshRemoteError {
  const kind = 'host-key-changed' as unknown as SshErrorKind;
  const error = new SshRemoteError(
    kind,
    `host key for ${details.host}:${details.port} has changed`,
  );
  return Object.assign(error, { hostKey: details });
}

function defaultHostKeyScan(entry: FakeEntry): FakeHostKeyScan {
  return {
    host: entry.spec.host,
    port: entry.spec.port,
    keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:fake-scanned-host-key' }],
  };
}

export function fakeSshConnectionManager(
  opts: FakeSshConnectionManagerOptions = {},
): FakeSshConnectionManager {
  const entries = new Map<string, FakeEntry>();
  const connectCalls: string[] = [];
  const connectOptions: (SshAuthOptions | undefined)[] = [];
  const forgottenHostKeys: string[] = [];

  const statusOf = (name: string): SshConnectionStatus => {
    const entry = entries.get(name);
    if (entry === undefined || entry.state === 'off') {
      return { state: 'off', needsPassword: entry?.needsPassword === true ? true : undefined };
    }
    return {
      state: 'on',
      localOrigin: entry.handle?.localOrigin,
      needsPassword: entry.needsPassword === true ? true : undefined,
    };
  };

  const infoOf = (entry: FakeEntry): SshConnectionInfo => ({
    name: entry.spec.name,
    host: entry.spec.host,
    user: entry.spec.user,
    port: entry.spec.port,
    identityFile: entry.spec.identityFile,
    hasPassword: entry.password !== undefined,
    status: statusOf(entry.spec.name),
  });

  const requireEntry = (name: string): FakeEntry => {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new SshRemoteError('config', `ssh connection "${name}" not found`);
    }
    return entry;
  };

  const passwordFor = (entry: FakeEntry, options?: SshAuthOptions): string | undefined =>
    options?.password ?? entry.password;

  return {
    connectCalls,
    connectOptions,
    forgottenHostKeys,
    setHandle(name, handle) {
      const entry = requireEntry(name);
      entry.handle = handle;
    },
    setConnectError(name, error) {
      const entry = requireEntry(name);
      entry.connectError = error;
    },
    setAuthRequired(name, required) {
      const entry = requireEntry(name);
      entry.authRequired = required;
    },
    setHostKeyChanged(name, details) {
      const entry = requireEntry(name);
      entry.hostKeyChanged = details;
    },
    setHostKeyScan(name, scan) {
      const entry = requireEntry(name);
      entry.hostKeyScan = scan;
    },
    savedPassword(name) {
      return entries.get(name)?.password;
    },
    async list() {
      return [...entries.values()].map(infoOf);
    },
    async add(spec: SshConnectionSpec) {
      const parsed = sshConnectionProfileSchema.safeParse(spec);
      if (!parsed.success) {
        throw new SshRemoteError('config', `invalid ssh connection profile: ${parsed.error.message}`);
      }
      if (entries.has(parsed.data.name)) {
        throw new SshRemoteError('config', `ssh connection "${parsed.data.name}" already exists`);
      }
      const entry: FakeEntry = {
        spec: parsed.data,
        state: 'off',
        authRequired: false,
        needsPassword: false,
      };
      entries.set(parsed.data.name, entry);
      return infoOf(entry);
    },
    async remove(name: string) {
      const entry = requireEntry(name);
      entry.state = 'off';
      entry.handle = undefined;
      entries.delete(name);
    },
    async setPassword(name: string, password: string) {
      const entry = requireEntry(name);
      if (password.length === 0) {
        throw new SshRemoteError('config', 'password must not be empty');
      }
      entry.password = password;
    },
    async clearPassword(name: string) {
      const entry = requireEntry(name);
      entry.password = undefined;
    },
    async scanHostKey(name: string) {
      const entry = requireEntry(name);
      return {
        host: entry.spec.host,
        port: entry.spec.port,
        keys: [],
      };
    },
    async forgetHostKey(name: string) {
      requireEntry(name);
    },
    async test(name: string, options?: SshAuthOptions): Promise<SshTestResult> {
      const entry = requireEntry(name);
      if (entry.hostKeyChanged !== undefined) {
        const details = entry.hostKeyChanged;
        return {
          ok: false,
          error: `host key for ${details.host}:${details.port} has changed`,
          hostKey: details,
        } as SshTestResult;
      }
      if (entry.authRequired && passwordFor(entry, options) === undefined) {
        return { ok: false, error: 'ssh authentication failed: permission denied', needsPassword: true };
      }
      return (
        opts.testResult ?? {
          ok: true,
          platform: 'linux-x64',
          kimiPath: '/home/example/.kimi-code/bin/kimi',
          serverRunning: true,
        }
      );
    },
    async connect(name: string, options?: SshAuthOptions): Promise<SshConnectionHandle> {
      connectCalls.push(name);
      connectOptions.push(options);
      const entry = requireEntry(name);
      if (entry.connectError !== undefined) throw entry.connectError;
      if (entry.hostKeyChanged !== undefined) throw hostKeyChangedError(entry.hostKeyChanged);
      if (entry.authRequired && passwordFor(entry, options) === undefined) {
        entry.needsPassword = true;
        throw new SshRemoteError('auth', 'ssh authentication failed: permission denied');
      }
      const handle = opts.handleFor?.(name) ??
        entry.handle ?? { localOrigin: 'http://127.0.0.1:9', remoteToken: 'fake-remote-token' };
      entry.state = 'on';
      entry.handle = handle;
      entry.needsPassword = false;
      if (options?.password !== undefined && options.savePassword === true) {
        entry.password = options.password;
      }
      return handle;
    },
    async disconnect(name: string) {
      const entry = requireEntry(name);
      entry.state = 'off';
      entry.handle = undefined;
    },
    async scanHostKey(name: string): Promise<FakeHostKeyScan> {
      const entry = requireEntry(name);
      return entry.hostKeyScan ?? defaultHostKeyScan(entry);
    },
    async forgetHostKey(name: string): Promise<void> {
      const entry = requireEntry(name);
      forgottenHostKeys.push(name);
      entry.hostKeyChanged = undefined;
    },
    status: statusOf,
    async close() {
      for (const entry of entries.values()) {
        entry.state = 'off';
        entry.handle = undefined;
      }
    },
  };
}
