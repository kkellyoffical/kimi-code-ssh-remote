import {
  SshRemoteError,
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
  listSshConnectionsResponseSchema,
  sshConnectionNameParamSchema,
  sshConnectionSchema,
  sshConnectionTestResultSchema,
  type ConnectSshConnectionResponse,
  type DisconnectSshConnectionResponse,
  type SshConnectionTestResultWire,
  type SshConnectionWire,
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
}

export interface SshConnectionsRouteOptions {
  readonly service: SshConnectionManager;
  readonly enableWrite?: boolean;
}

interface MappedSshError {
  readonly code: ErrorCode;
  readonly msg: string;
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
      };
      try {
        const info = await opts.service.add({
          name: body.name,
          host: body.host,
          user: body.user,
          port: body.port,
          identityFile: body.identity_file,
        });
        reply.send(okEnvelope(toWire(info), req.id));
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

  if (opts.enableWrite === false) {
    return;
  }

  const testRoute = defineRoute(
    {
      method: 'POST',
      path: '/ssh/connections/{name}/test',
      params: sshConnectionNameParamSchema,
      success: { data: sshConnectionTestResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Probe an SSH connection: handshake plus remote kap-server detection',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        const result = await opts.service.test(name);
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
      success: { data: connectSshConnectionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SSH_CONNECTION_NOT_FOUND]: {},
        [ErrorCode.SSH_UNREACHABLE]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Establish the SSH tunnel for a connection (idempotent)',
      tags: ['ssh'],
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        const handle = await opts.service.connect(name);
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
}

async function findConnection(
  service: SshConnectionManager,
  name: string,
): Promise<SshConnectionInfo | undefined> {
  const connections = await service.list();
  return connections.find((connection) => connection.name === name);
}

function toWire(info: SshConnectionInfo): SshConnectionWire {
  return {
    name: info.name,
    host: info.host,
    user: info.user,
    port: info.port,
    identity_file: info.identityFile,
    status: {
      state: info.status.state,
      local_origin: info.status.localOrigin,
      error: info.status.error,
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
  };
}

function mapSshError(error: unknown): MappedSshError | undefined {
  if (!(error instanceof SshRemoteError)) {
    return undefined;
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
    reply.send(errEnvelope(mapped.code, mapped.msg, req.id));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  requestLog(req)?.error({ err: error }, 'ssh connections route failed');
  reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, req.id));
}
