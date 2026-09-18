/**
 * REST client for the local server's `/api/v1/ssh/connections` routes.
 *
 * The CLI prefers this backend whenever a live local server exists so that
 * `kimi ssh` and the web UI's proxy surface share one runtime state; without
 * a server the handlers fall back to the local `@moonshot-ai/ssh-remote`
 * manager. Both backends are normalized to the manager's own types here, so
 * callers never see the wire format (snake_case, enveloped).
 */

import type {
  RemotePlatform,
  SshAuthOptions,
  SshConnectionInfo,
  SshConnectionSpec,
  SshTestResult,
} from '@moonshot-ai/ssh-remote';

/** Server error code meaning "authentication needs a password" (SSH_AUTH_REQUIRED). */
export const SSH_AUTH_REQUIRED_CODE = 40130;

/** Server error code meaning "the remote's host key changed" (SSH_HOST_KEY_CHANGED). */
export const SSH_HOST_KEY_CHANGED_CODE = 40931;

/**
 * A host key reported by `ssh-keyscan` on the remote, and the scan result
 * wrapping it. Structurally identical to `ScannedHostKey`/`SshHostKeyScan`
 * from `@moonshot-ai/ssh-remote`; declared here so the CLI compiles against
 * the manager both before and after those types land.
 */
export interface SshScannedHostKey {
  keyType: string;
  /** SHA256 fingerprint in the `SHA256:…` form `ssh-keygen -l` prints. */
  fingerprint: string;
}

export interface SshHostKeyScan {
  host: string;
  port: number;
  keys: SshScannedHostKey[];
}

/**
 * Mirror of the manager's `SshHostKeyDetails` (host-key contract): the
 * comparison data attached to a host-key-changed failure — the presented
 * fingerprint, the stored one, and the offending known_hosts location.
 */
export interface SshHostKeyDetailsShape {
  fingerprint?: string;
  keyType?: string;
  expectedFingerprint?: string;
  knownHostsFile?: string;
  knownHostsLine?: number;
}

/**
 * The operation surface `kimi ssh` needs; the local manager satisfies it
 * natively, the REST client maps the same operations onto the server.
 * Passwords are write-only across both: never returned, never logged.
 */
export interface SshBackend {
  list(): Promise<readonly SshConnectionInfo[]>;
  add(spec: SshConnectionSpec): Promise<SshConnectionInfo>;
  remove(name: string): Promise<void>;
  test(name: string, auth?: SshAuthOptions): Promise<SshTestResult>;
  connect(name: string, auth?: SshAuthOptions): Promise<{ localOrigin: string; remoteToken?: string }>;
  setPassword(name: string, password: string): Promise<void>;
  clearPassword(name: string): Promise<void>;
  scanHostKey(name: string): Promise<SshHostKeyScan>;
  forgetHostKey(name: string): Promise<void>;
}

/** Non-ok envelope from the server: carries the numeric error code for hints. */
export class SshApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Error-envelope `details` payload, when the server attaches them. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SshApiError';
  }
}

interface WireStatus {
  state: 'off' | 'connecting' | 'on' | 'error';
  local_origin?: string;
  error?: string;
}

interface WireConnection {
  name: string;
  host: string;
  user?: string;
  port: number;
  identity_file?: string;
  has_password?: boolean;
  status?: WireStatus;
}

interface WireEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  details?: unknown;
}

function fromWire(wire: WireConnection): SshConnectionInfo {
  return {
    name: wire.name,
    host: wire.host,
    user: wire.user,
    port: wire.port,
    identityFile: wire.identity_file,
    hasPassword: wire.has_password,
    status: {
      state: wire.status?.state ?? 'off',
      localOrigin: wire.status?.local_origin,
      error: wire.status?.error,
    },
  };
}

function authBody(auth: SshAuthOptions | undefined): Record<string, unknown> | undefined {
  if (auth === undefined) return undefined;
  return { password: auth.password, save_password: auth.savePassword };
}

export interface SshRestClientOptions {
  /** Bare server origin, e.g. `http://127.0.0.1:58627`. */
  origin: string;
  /** Local server bearer token; omitted only under `--dangerous-bypass-auth`. */
  token?: string;
  fetchFn?: typeof fetch;
}

export function createSshRestClient(options: SshRestClientOptions): SshBackend {
  const fetchFn = options.fetchFn ?? fetch;
  const base = `${options.origin.replace(/\/$/, '')}/api/v1/ssh/connections`;
  const authHeader: Record<string, string> =
    options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        // Fastify rejects a JSON content-type on a bodyless request (400).
        headers: body === undefined ? authHeader : { ...authHeader, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new SshApiError(
        -1,
        `cannot reach the local server at ${options.origin}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let envelope: WireEnvelope<T>;
    try {
      envelope = (await response.json()) as WireEnvelope<T>;
    } catch {
      throw new SshApiError(
        response.status,
        `unexpected response from the local server (HTTP ${response.status}); is it running a version that supports SSH connections?`,
      );
    }
    if (!response.ok || envelope.code !== 0 || envelope.data === null) {
      throw new SshApiError(
        envelope.code,
        envelope.msg || `request failed (HTTP ${response.status})`,
        envelope.details,
      );
    }
    return envelope.data;
  }

  return {
    async list() {
      const data = await call<{ connections: WireConnection[] }>('GET', '');
      return data.connections.map(fromWire);
    },
    async add(spec: SshConnectionSpec) {
      const data = await call<WireConnection>('POST', '', {
        name: spec.name,
        host: spec.host,
        user: spec.user,
        port: spec.port,
        identity_file: spec.identityFile,
      });
      return fromWire(data);
    },
    async remove(name) {
      await call<Record<string, never>>('DELETE', `/${encodeURIComponent(name)}`);
    },
    async test(name, auth) {
      const data = await call<SshTestWire>(
        'POST',
        `/${encodeURIComponent(name)}/test`,
        authBody(auth),
      );
      const result: SshTestResult & { hostKey?: SshHostKeyDetailsShape } = {
        ok: data.ok,
        platform: data.platform as RemotePlatform | undefined,
        kimiPath: data.kimi_path,
        serverRunning: data.server_running,
        error: data.error,
        needsPassword: data.needs_password,
        hostKey: fromWireHostKeyDetails(data.host_key),
      };
      return result;
    },
    async connect(name, auth) {
      const data = await call<{ local_origin: string }>(
        'POST',
        `/${encodeURIComponent(name)}/connect`,
        authBody(auth),
      );
      return { localOrigin: data.local_origin };
    },
    async setPassword(name, password) {
      await call<Record<string, never>>('PUT', `/${encodeURIComponent(name)}/password`, {
        password,
      });
    },
    async clearPassword(name) {
      await call<Record<string, never>>('DELETE', `/${encodeURIComponent(name)}/password`);
    },
    async scanHostKey(name) {
      const data = await call<WireHostKeyScan>(
        'GET',
        `/${encodeURIComponent(name)}/host-key/forget`,
      );
      return {
        host: data.host,
        port: data.port,
        keys: data.keys.map((key) => ({ keyType: key.key_type, fingerprint: key.fingerprint })),
      };
    },
    async forgetHostKey(name) {
      await call<Record<string, never>>('POST', `/${encodeURIComponent(name)}/host-key/forget`);
    },
  };
}

interface SshTestWire {
  ok: boolean;
  platform?: string;
  kimi_path?: string;
  server_running?: boolean;
  error?: string;
  needs_password?: boolean;
  host_key?: WireHostKeyDetails;
}

interface WireHostKeyDetails {
  fingerprint?: string;
  key_type?: string;
  expected_fingerprint?: string;
  known_hosts_file?: string;
  known_hosts_line?: number;
}

function fromWireHostKeyDetails(
  wire: WireHostKeyDetails | undefined,
): SshHostKeyDetailsShape | undefined {
  if (wire === undefined) return undefined;
  return {
    fingerprint: wire.fingerprint,
    keyType: wire.key_type,
    expectedFingerprint: wire.expected_fingerprint,
    knownHostsFile: wire.known_hosts_file,
    knownHostsLine: wire.known_hosts_line,
  };
}

interface WireHostKeyScan {
  host: string;
  port: number;
  keys: { key_type: string; fingerprint: string }[];
}
