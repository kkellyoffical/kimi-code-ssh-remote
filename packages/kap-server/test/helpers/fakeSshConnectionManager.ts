import {
  SshRemoteError,
  sshConnectionProfileSchema,
  type SshConnectionHandle,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshConnectionSpec,
  type SshConnectionStatus,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';

export interface FakeSshConnectionManager extends SshConnectionManager {
  readonly connectCalls: string[];
  setHandle(name: string, handle: SshConnectionHandle | undefined): void;
  setConnectError(name: string, error: Error | undefined): void;
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
}

export function fakeSshConnectionManager(
  opts: FakeSshConnectionManagerOptions = {},
): FakeSshConnectionManager {
  const entries = new Map<string, FakeEntry>();
  const passwords = new Map<string, string>();
  const connectCalls: string[] = [];

  const statusOf = (name: string): SshConnectionStatus => {
    const entry = entries.get(name);
    if (entry === undefined || entry.state === 'off') return { state: 'off' };
    return { state: 'on', localOrigin: entry.handle?.localOrigin };
  };

  const infoOf = (entry: FakeEntry): SshConnectionInfo => ({
    name: entry.spec.name,
    host: entry.spec.host,
    user: entry.spec.user,
    port: entry.spec.port,
    identityFile: entry.spec.identityFile,
    status: statusOf(entry.spec.name),
  });

  const requireEntry = (name: string): FakeEntry => {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new SshRemoteError('config', `ssh connection "${name}" not found`);
    }
    return entry;
  };

  return {
    connectCalls,
    setHandle(name, handle) {
      const entry = requireEntry(name);
      entry.handle = handle;
    },
    setConnectError(name, error) {
      const entry = requireEntry(name);
      entry.connectError = error;
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
      const entry: FakeEntry = { spec: parsed.data, state: 'off' };
      entries.set(parsed.data.name, entry);
      return infoOf(entry);
    },
    async remove(name: string) {
      const entry = requireEntry(name);
      entry.state = 'off';
      entry.handle = undefined;
      entries.delete(name);
      passwords.delete(name);
    },
    async setPassword(name: string, password: string) {
      requireEntry(name);
      if (password.length === 0) {
        throw new SshRemoteError('config', 'password must not be empty');
      }
      passwords.set(name, password);
    },
    async clearPassword(name: string) {
      requireEntry(name);
      passwords.delete(name);
    },
    async test(name: string): Promise<SshTestResult> {
      requireEntry(name);
      return (
        opts.testResult ?? {
          ok: true,
          platform: 'linux-x64',
          kimiPath: '/home/example/.kimi-code/bin/kimi',
          serverRunning: true,
        }
      );
    },
    async connect(name: string): Promise<SshConnectionHandle> {
      connectCalls.push(name);
      const entry = requireEntry(name);
      if (entry.connectError !== undefined) throw entry.connectError;
      const handle = opts.handleFor?.(name) ??
        entry.handle ?? { localOrigin: 'http://127.0.0.1:9', remoteToken: 'fake-remote-token' };
      entry.state = 'on';
      entry.handle = handle;
      return handle;
    },
    async disconnect(name: string) {
      const entry = requireEntry(name);
      entry.state = 'off';
      entry.handle = undefined;
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
