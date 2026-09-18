import {
  SshRemoteError,
  type SshAuthOptions,
  type SshConnectionInfo,
  type SshConnectionManager,
  type SshTestResult,
} from '@moonshot-ai/ssh-remote';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  addSshConnectionRequestSchema,
  connectSshConnectionResponseSchema,
  deleteSshConnectionResponseSchema,
  disconnectSshConnectionResponseSchema,
  forgetSshHostKeyResponseSchema,
  listSshConnectionsResponseSchema,
  setSshConnectionPasswordRequestSchema,
  sshConnectionAuthRequestSchema,
  sshConnectionNameParamSchema,
  sshConnectionPasswordStateSchema,
  sshConnectionSchema,
  sshConnectionTestResultSchema,
  sshHostKeyErrorDetailsSchema,
  sshHostKeyScanResponseSchema,
  submitSshConnectionPasswordRequestSchema,
  type ConnectSshConnectionResponse,
  type DisconnectSshConnectionResponse,
  type SshConnectionTestResultWire,
  type SshConnectionWire,
  type SshHostKeyErrorDetailsWire,
  type SshHostKeyScanResponse,
} from '../protocol/rest-ssh';

interface SshConnectionsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SshConnectionsRouteOptions {
  readonly service: SshConnectionManager;
  readonly enableWrite?: boolean;
}

interface MappedSshError {
  readonly code: ErrorCode;
  readonly msg: string;
  readonly details?: SshHostKeyErrorDetailsWire;
}

interface SshHostKeyDetails {
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly keyType?: string;
  readonly expectedFingerprint?: string;
  readonly knownHostsFile?: string;
  readonly knownHostsLine?: number;
}

interface SshHostKeyScanResult {
  readonly host: string;
  readonly port: number;
  readonly keys: readonly { readonly type: string; readonly fingerprint: string }[];
}

interface SshHostKeyCapableManager {
  scanHostKey(name: string): Promise<SshHostKeyScanResult>;
  forgetHostKey(name: string): Promise<void>;
}

export function registerSshConnectionsRoutes(
  app: SshConnectionsRouteHost,
  opts: SshConnectionsRouteOptions,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/ssh/connections',
      success: { data: listSshConnectionsResponseSchema },
      description: 'List SSH connections with runtime status',
      tags: ['ssh'],
    },
    async (req, reply) => {
      try {
        const connections = await opts.service.list();
        reply.send(okEnvelope({ connections: connections.map(toWire) }, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SshConnectionsRouteHost['get']>[2],
  );

  const addRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections',
      body: addSshConnectionRequestSchema,
      success: { data: sshConnectionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_ALREADY_EXISTS]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Add an SSH connection to the registry',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const body = req.body as {
        name: string;
        host: string;
        user?: string;
        port?: number;
        identity_file?: string;
        password?: string;
        save_password?: boolean;
      };
      if (body.password !== undefined && body.save_password !== true) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'save_password must be true when password is provided',
            req.id,
          ),
        );
        return;
      }
      try {
        const info = await opts.service.add({
          name: body.name,
          host: body.host,
          user: body.user,
          port: body.port,
          identityFile: body.identity_file,
        });
        if (body.password !== undefined) {
          await opts.service.setPassword(body.name, body.password);
        }
        reply.send(
          okEnvelope(
            { ...toWire(info), has_password: body.password !== undefined || info.hasPassword === true },
            req.id,
          ),
        );
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.post(
    addRoute.path,
    addRoute.options,
    addRoute.handler as Parameters<SshConnectionsRouteHost['post']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/ssh/connections/{name}',
      params: sshConnectionNameParamSchema,
      success: { data: sshConnectionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Get an SSH connection with runtime status',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        const info = await findConnection(opts.service, name);
        if (info === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SSH_CONNECTION_NOT_FOUND,
              `ssh connection "${name}" not found`,
              req.id,
            ),
          );
          return;
        }
        reply.send(okEnvelope(toWire(info), req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SshConnectionsRouteHost['get']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/ssh/connections/{name}',
      params: sshConnectionNameParamSchema,
      success: { data: deleteSshConnectionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Remove an SSH connection, disconnecting it first when connected',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        await opts.service.remove(name);
        reply.send(okEnvelope({ name }, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<SshConnectionsRouteHost['delete']>[2],
  );

  const setPasswordRoute = defineRoute(
    {
      method: 'PUT',
      path: '/ssh/connections/{name}/password',
      params: sshConnectionNameParamSchema,
      body: setSshConnectionPasswordRequestSchema,
      success: { data: sshConnectionPasswordStateSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Store or overwrite the saved password for an SSH connection without connecting',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const body = req.body as { password: string };
      try {
        await opts.service.setPassword(name, body.password);
        reply.send(okEnvelope({ name, has_password: true }, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.put(
    setPasswordRoute.path,
    setPasswordRoute.options,
    setPasswordRoute.handler as Parameters<SshConnectionsRouteHost['put']>[2],
  );

  const clearPasswordRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/ssh/connections/{name}/password',
      params: sshConnectionNameParamSchema,
      success: { data: sshConnectionPasswordStateSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Clear the saved password for an SSH connection',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        if ((await findConnection(opts.service, name)) === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SSH_CONNECTION_NOT_FOUND,
              `ssh connection "${name}" not found`,
              req.id,
            ),
          );
          return;
        }
        await opts.service.clearPassword(name);
        reply.send(okEnvelope({ name, has_password: false }, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.delete(
    clearPasswordRoute.path,
    clearPasswordRoute.options,
    clearPasswordRoute.handler as Parameters<SshConnectionsRouteHost['delete']>[2],
  );

  if (opts.enableWrite === false) {
    return;
  }

  const testRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections/{name}/test',
      params: sshConnectionNameParamSchema,
      body: sshConnectionAuthRequestSchema.optional(),
      success: { data: sshConnectionTestResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.SSH_AUTH_REQUIRED]: {},
        [ErrorCode.SSH_HOST_KEY_CHANGED]: { detailsSchema: sshHostKeyErrorDetailsSchema },
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Probe an SSH connection: handshake plus remote kap-server detection',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const body = authOptionsOf(req.body);
      try {
        const result = await opts.service.test(name, body);
        const hostKey = testHostKeyOf(result);
        if (hostKey !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SSH_HOST_KEY_CHANGED,
              result.error ?? `host key for connection "${name}" has changed`,
              req.id,
              undefined,
              toHostKeyDetailsWire(hostKey),
            ),
          );
          return;
        }
        reply.send(okEnvelope(toTestWire(result), req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.post(
    testRoute.path,
    testRoute.options,
    testRoute.handler as Parameters<SshConnectionsRouteHost['post']>[2],
  );

  const connectRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections/{name}/connect',
      params: sshConnectionNameParamSchema,
      body: sshConnectionAuthRequestSchema.optional(),
      success: { data: connectSshConnectionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.SSH_AUTH_REQUIRED]: {},
        [ErrorCode.SSH_UNREACHABLE]: {},
        [ErrorCode.SSH_HOST_KEY_CHANGED]: { detailsSchema: sshHostKeyErrorDetailsSchema },
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Establish the SSH tunnel for a connection (idempotent)',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const body = authOptionsOf(req.body);
      try {
        const handle = await opts.service.connect(name, body);
        const response: ConnectSshConnectionResponse = {
          name,
          state: 'on',
          local_origin: handle.localOrigin,
        };
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.post(
    connectRoute.path,
    connectRoute.options,
    connectRoute.handler as Parameters<SshConnectionsRouteHost['post']>[2],
  );

  const submitPasswordRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections/{name}/password',
      params: sshConnectionNameParamSchema,
      body: submitSshConnectionPasswordRequestSchema,
      success: { data: connectSshConnectionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.SSH_AUTH_REQUIRED]: {},
        [ErrorCode.SSH_UNREACHABLE]: {},
        [ErrorCode.SSH_HOST_KEY_CHANGED]: { detailsSchema: sshHostKeyErrorDetailsSchema },
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Submit an SSH password and connect, persisting it when save_password is true',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const body = req.body as { password: string; save_password?: boolean };
      try {
        const handle = await opts.service.connect(name, {
          password: body.password,
          savePassword: body.save_password,
        });
        const response: ConnectSshConnectionResponse = {
          name,
          state: 'on',
          local_origin: handle.localOrigin,
        };
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.post(
    submitPasswordRoute.path,
    submitPasswordRoute.options,
    submitPasswordRoute.handler as Parameters<SshConnectionsRouteHost['post']>[2],
  );

  const disconnectRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections/{name}/disconnect',
      params: sshConnectionNameParamSchema,
      success: { data: disconnectSshConnectionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Tear down the SSH tunnel for a connection',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        if ((await findConnection(opts.service, name)) === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SSH_CONNECTION_NOT_FOUND,
              `ssh connection "${name}" not found`,
              req.id,
            ),
          );
          return;
        }
        await opts.service.disconnect(name);
        const response: DisconnectSshConnectionResponse = { name, state: 'off' };
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.post(
    disconnectRoute.path,
    disconnectRoute.options,
    disconnectRoute.handler as Parameters<SshConnectionsRouteHost['post']>[2],
  );

  const scanHostKeyRoute = defineRoute(
    {
      method: 'GET',
      path: '/ssh/connections/{name}/host-key/forget',
      params: sshConnectionNameParamSchema,
      success: { data: sshHostKeyScanResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Scan the host key fingerprints the remote currently presents',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const hostKeys = hostKeyCapableOf(opts.service);
      if (hostKeys === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            'ssh host key management is not available',
            req.id,
          ),
        );
        return;
      }
      try {
        const scan = await hostKeys.scanHostKey(name);
        const response: SshHostKeyScanResponse = {
          name,
          host: scan.host,
          port: scan.port,
          keys: scan.keys.map((key) => ({ type: key.type, fingerprint: key.fingerprint })),
        };
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.get(
    scanHostKeyRoute.path,
    scanHostKeyRoute.options,
    scanHostKeyRoute.handler as Parameters<SshConnectionsRouteHost['get']>[2],
  );

  const forgetHostKeyRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections/{name}/host-key/forget',
      params: sshConnectionNameParamSchema,
      success: { data: forgetSshHostKeyResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Forget the stored host key for a connection, then retry test or connect',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const hostKeys = hostKeyCapableOf(opts.service);
      if (hostKeys === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            'ssh host key management is not available',
            req.id,
          ),
        );
        return;
      }
      try {
        await hostKeys.forgetHostKey(name);
        reply.send(okEnvelope({ name, forgotten: true }, req.id));
      } catch (error) {
        sendSshError(reply, req, error);
      }
    },
  );
  app.post(
    forgetHostKeyRoute.path,
    forgetHostKeyRoute.options,
    forgetHostKeyRoute.handler as Parameters<SshConnectionsRouteHost['post']>[2],
  );
}

async function findConnection(
  service: SshConnectionManager,
  name: string,
): Promise<SshConnectionInfo | undefined> {
  const connections = await service.list();
  return connections.find((connection) => connection.name === name);
}

function authOptionsOf(body: unknown): SshAuthOptions | undefined {
  if (body === undefined || body === null) return undefined;
  const auth = body as { password?: string; save_password?: boolean };
  if (auth.password === undefined && auth.save_password === undefined) return undefined;
  return { password: auth.password, savePassword: auth.save_password };
}

function toWire(info: SshConnectionInfo): SshConnectionWire {
  return {
    name: info.name,
    host: info.host,
    user: info.user,
    port: info.port,
    identity_file: info.identityFile,
    has_password: info.hasPassword === true,
    status: {
      state: info.status.state,
      local_origin: info.status.localOrigin,
      error: info.status.error,
      needs_password: info.status.needsPassword,
    },
  };
}

function toTestWire(result: SshTestResult): SshConnectionTestResultWire {
  return {
    ok: result.ok,
    platform: result.platform,
    kimi_path: result.kimiPath,
    server_running: result.serverRunning,
    error: result.error,
    needs_password: result.needsPassword,
  };
}

function hostKeyCapableOf(service: SshConnectionManager): SshHostKeyCapableManager | undefined {
  const candidate = service as SshConnectionManager & Partial<SshHostKeyCapableManager>;
  if (
    typeof candidate.scanHostKey !== 'function' ||
    typeof candidate.forgetHostKey !== 'function'
  ) {
    return undefined;
  }
  return candidate as SshHostKeyCapableManager;
}

function isHostKeyChangedError(error: SshRemoteError): boolean {
  const kind: string = error.kind;
  return kind === 'host-key-changed';
}

function errorHostKeyOf(error: SshRemoteError): SshHostKeyDetails | undefined {
  return (error as SshRemoteError & { hostKey?: SshHostKeyDetails }).hostKey;
}

function testHostKeyOf(result: SshTestResult): SshHostKeyDetails | undefined {
  if (result.ok) return undefined;
  return (result as SshTestResult & { hostKey?: SshHostKeyDetails }).hostKey;
}

function toHostKeyDetailsWire(details: SshHostKeyDetails): SshHostKeyErrorDetailsWire {
  return {
    host: details.host,
    port: details.port,
    fingerprint: details.fingerprint,
    key_type: details.keyType,
    expected_fingerprint: details.expectedFingerprint,
    known_hosts_file: details.knownHostsFile,
    known_hosts_line: details.knownHostsLine,
  };
}

function mapSshError(error: unknown): MappedSshError | undefined {
  if (!(error instanceof SshRemoteError)) {
    return undefined;
  }
  if (isHostKeyChangedError(error)) {
    const hostKey = errorHostKeyOf(error);
    const details = hostKey === undefined ? undefined : toHostKeyDetailsWire(hostKey);
    return { code: ErrorCode.SSH_HOST_KEY_CHANGED, msg: error.message, details };
  }
  if (error.kind === 'config') {
    if (error.message.includes('not found')) {
      return { code: ErrorCode.SSH_CONNECTION_NOT_FOUND, msg: error.message };
    }
    if (error.message.includes('already exists')) {
      return { code: ErrorCode.SSH_CONNECTION_ALREADY_EXISTS, msg: error.message };
    }
    return { code: ErrorCode.VALIDATION_FAILED, msg: error.message };
  }
  if (error.kind === 'auth') {
    return { code: ErrorCode.SSH_AUTH_REQUIRED, msg: error.message };
  }
  if (error.kind === 'unknown') {
    return undefined;
  }
  return { code: ErrorCode.SSH_UNREACHABLE, msg: error.message };
}

function sendSshError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  error: unknown,
): void {
  const mapped = mapSshError(error);
  if (mapped !== undefined) {
    reply.send(errEnvelope(mapped.code, mapped.msg, req.id, undefined, mapped.details));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  requestLog(req)?.error({ err: error }, 'ssh connections route failed');
  reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, req.id));
}
