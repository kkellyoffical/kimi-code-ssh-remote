import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  filterForwardRequestHeaders,
  rewriteRemoteControlResponse,
} from '@moonshot-ai/remote-control';
import { SshRemoteError, type SshConnectionManager } from '@moonshot-ai/ssh-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';

const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STALE_AFTER_REWRITE_HEADERS = new Set([
  'cache-control',
  'content-length',
  'etag',
  'last-modified',
]);

const PROXY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export interface SshProxyRouteOptions {
  readonly service: SshConnectionManager;
  readonly upstreamTimeoutMs?: number;
}

export async function registerSshProxyRoutes(
  app: FastifyInstance,
  opts: SshProxyRouteOptions,
): Promise<void> {
  await app.register(
    async (ssh) => {
      const bufferParser = (
        _req: unknown,
        body: unknown,
        done: (err: null, body: unknown) => void,
      ): void => {
        done(null, body);
      };
      const parserOpts = { parseAs: 'buffer' as const, bodyLimit: MAX_PROXY_BODY_BYTES };
      ssh.addContentTypeParser('*', parserOpts, bufferParser);
      ssh.addContentTypeParser('application/json', parserOpts, bufferParser);
      ssh.addContentTypeParser('text/plain', parserOpts, bufferParser);
      const handler = (req: FastifyRequest, reply: FastifyReply): Promise<void> =>
        proxySshRequest(
          opts.service,
          req,
          reply,
          opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
        );
      ssh.route({ method: [...PROXY_METHODS], url: '/:name', schema: { hide: true }, handler });
      ssh.route({ method: [...PROXY_METHODS], url: '/:name/*', schema: { hide: true }, handler });
    },
    { prefix: '/ssh' },
  );
}

async function proxySshRequest(
  service: SshConnectionManager,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamTimeoutMs: number,
): Promise<void> {
  const { name } = req.params as { name: string };
  let handle;
  try {
    handle = await service.connect(name);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (error instanceof SshRemoteError && error.kind === 'config') {
      await reply
        .code(404)
        .send(errEnvelope(ErrorCode.SSH_CONNECTION_NOT_FOUND, msg, req.id));
      return;
    }
    await reply.code(502).send(errEnvelope(ErrorCode.SSH_UNREACHABLE, msg, req.id));
    return;
  }

  const target = new URL(handle.localOrigin);
  const rawUrl = req.raw.url ?? '/';
  const afterPrefix = rawUrl.slice('/ssh/'.length);
  const restStart = afterPrefix.search(/[/?]/);
  const rest = restStart < 0 ? '' : afterPrefix.slice(restStart);
  const path = rest === '' ? '/' : rest.startsWith('?') ? `/${rest}` : rest;

  const headerPairs: [string, string][] = [];
  const rawHeaders = req.raw.rawHeaders;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    headerPairs.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  const forwardHeaders = [
    ...filterForwardRequestHeaders(headerPairs, handle.remoteToken),
    'Host',
    target.host,
  ];

  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  const publicPrefix = `/ssh/${name}`;

  await new Promise<void>((resolve) => {
    let responded = false;
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path,
        headers: forwardHeaders,
        timeout: upstreamTimeoutMs,
      },
      (res) => {
        responded = true;
        void sendUpstreamResponse(req, reply, res, publicPrefix).then(resolve);
      },
    );
    upstream.once('timeout', () => {
      upstream.destroy(new Error(`ssh connection "${name}" tunnel request timed out`));
    });
    upstream.once('error', (error) => {
      if (!responded) {
        responded = true;
        void reply.code(502).send(errEnvelope(ErrorCode.SSH_UNREACHABLE, error.message, req.id));
      }
      resolve();
    });
    req.raw.once('close', () => {
      if (!responded) upstream.destroy();
    });
    upstream.end(body);
  });
}

async function sendUpstreamResponse(
  req: FastifyRequest,
  reply: FastifyReply,
  res: IncomingMessage,
  publicPrefix: string,
): Promise<void> {
  const status = res.statusCode ?? 502;
  const contentType = res.headers['content-type'] ?? '';
  const rewritable =
    req.method !== 'HEAD' &&
    status !== 206 &&
    res.headers['content-range'] === undefined &&
    res.headers['content-encoding'] === undefined &&
    isRewritableContentType(contentType);
  if (!rewritable) {
    reply.code(status);
    writeResponseHeaders(reply, res.rawHeaders, false);
    reply.send(res);
    return;
  }
  const received = await new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    res.once('end', () => resolveBody(Buffer.concat(chunks)));
    res.once('error', rejectBody);
  }).catch(() => undefined);
  if (received === undefined) {
    if (!reply.sent) {
      await reply
        .code(502)
        .send(errEnvelope(ErrorCode.SSH_UNREACHABLE, 'upstream response failed', req.id));
    }
    return;
  }
  const rewritten = rewriteRemoteControlResponse(contentType, received, publicPrefix);
  reply.code(status);
  writeResponseHeaders(reply, res.rawHeaders, rewritten !== received);
  if (rewritten !== received) {
    reply.header('cache-control', 'no-cache');
    reply.header('content-length', String(rewritten.length));
  }
  reply.send(rewritten);
}

function isRewritableContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes('text/html') || lower.includes('javascript') || lower.includes('text/css');
}

function writeResponseHeaders(
  reply: FastifyReply,
  rawHeaders: readonly string[],
  rewritten: boolean,
): void {
  const grouped = new Map<string, { name: string; values: string[] }>();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
    if (rewritten && STALE_AFTER_REWRITE_HEADERS.has(lower)) continue;
    const entry = grouped.get(lower) ?? { name, values: [] };
    entry.values.push(rawHeaders[index + 1]!);
    grouped.set(lower, entry);
  }
  for (const { name, values } of grouped.values()) {
    reply.header(name, values.length === 1 ? values[0]! : values);
  }
}
