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
}

/** Non-ok envelope from the server: carries the numeric error code for hints. */
export class SshApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
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
      throw new SshApiError(envelope.code, envelope.msg || `request failed (HTTP ${response.status})`);
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
      return {
        ok: data.ok,
        platform: data.platform as RemotePlatform | undefined,
        kimiPath: data.kimi_path,
        serverRunning: data.server_running,
        error: data.error,
        needsPassword: data.needs_password,
      };
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
  };
}

interface SshTestWire {
  ok: boolean;
  platform?: string;
  kimi_path?: string;
  server_running?: boolean;
  error?: string;
  needs_password?: boolean;
}
