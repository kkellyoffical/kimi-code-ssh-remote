import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import {
  ErrorCodes,
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFileSystem,
  IHostFolderBrowser,
  isError2,
  type HostFileStat,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import {
  buildEtag,
  FS_BINARY_SAMPLE_BYTES,
  guessMime,
} from '@moonshot-ai/agent-core-v2/_base/utils/fileMeta';
import { classifyTextSample } from '@moonshot-ai/agent-core-v2/_base/text/encoding';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface FsContentReply {
  type(mime: string): FsContentReply;
  header(name: string, value: string | number): FsContentReply;
  code(status: number): FsContentReply;
  send(payload: unknown): unknown;
}

interface WorkspaceFsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: { path?: string }; headers: Record<string, unknown> },
      reply: FsContentReply,
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: { path?: string }; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  addContentTypeParser(
    contentType: string,
    opts: { parseAs: 'buffer'; bodyLimit: number },
    parser: (req: unknown, body: unknown, done: (err: null, body: unknown) => void) => void,
  ): unknown;
}

const MAX_FS_WRITE_BYTES = 10 * 1024 * 1024;

export function registerWorkspaceFsRoutes(app: WorkspaceFsRouteHost, core: Scope): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_FS_WRITE_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  const browseRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::browse',
      querystring: fsBrowseQuerySchema,
      success: { data: fsBrowseResponseSchema },
      description: 'Browse local directories (server folder picker backend)',
      tags: ['workspaces'],
      operationId: 'fsBrowse',
    },
    async (req, reply) => {
      try {
        const data = await core.accessor.get(IHostFolderBrowser).browse(req.query.path);
        reply.send(okEnvelope(data, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    browseRoute.path,
    browseRoute.options,
    browseRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
  );

  const homeRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::home',
      success: { data: fsHomeResponseSchema },
      description: 'Folder picker landing payload: $HOME + recent workspace roots',
      tags: ['workspaces'],
      operationId: 'fsHome',
    },
    async (req, reply) => {
      try {
        const data = await core.accessor.get(IHostFolderBrowser).home();
        reply.send(okEnvelope(data, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    homeRoute.path,
    homeRoute.options,
    homeRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::list',
      querystring: fsListQuerySchema,
      success: { data: fsListResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
      },
      description: 'List files and directories at an absolute host path (file manager backend)',
      tags: ['workspaces'],
      operationId: 'fsList',
    },
    async (req, reply) => {
      const { path } = req.query as { path: string };
      if (!isAbsolute(path)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, req.id),
        );
        return;
      }
      const hostFs = core.accessor.get(IHostFileSystem);
      let abs: string;
      let st: HostFileStat;
      try {
        abs = await hostFs.realpath(path);
        st = await hostFs.stat(abs);
      } catch (error) {
        sendOsFsError(reply, req.id, error, path);
        return;
      }
      if (!st.isDirectory) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `path is not a directory: ${path}`, req.id),
        );
        return;
      }
      let dirEntries;
      try {
        dirEntries = await hostFs.readdir(abs);
      } catch (error) {
        sendOsFsError(reply, req.id, error, path);
        return;
      }
      const entries = await Promise.all(
        dirEntries.map(async (entry) => {
          const full = join(abs, entry.name);
          if (entry.isDirectory) {
            return { name: entry.name, path: full, is_dir: true };
          }
          try {
            const fileStat = await hostFs.stat(full);
            return {
              name: entry.name,
              path: full,
              is_dir: false,
              size: fileStat.size,
              modified_at:
                fileStat.mtimeMs === undefined
                  ? undefined
                  : new Date(fileStat.mtimeMs).toISOString(),
            };
          } catch {
            return { name: entry.name, path: full, is_dir: false };
          }
        }),
      );
      entries.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        const aDot = a.name.startsWith('.');
        const bDot = b.name.startsWith('.');
        if (aDot !== bDot) return aDot ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      const parent = dirname(abs);
      reply.send(
        okEnvelope(
          { path: abs, parent: parent === abs ? null : parent, entries },
          req.id,
        ),
      );
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
  );

  const contentRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::content',
      querystring: fsContentQuerySchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
        206: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
      },
      description:
        'Serve the raw content of any file on the host filesystem by absolute path. Supports ETag caching and single-range requests.',
      tags: ['workspaces'],
      operationId: 'fsContent',
    },
    async (req, reply) => {
      return handleFsContent(core, req, reply as unknown as FsContentReply);
    },
  );
  app.get(
    contentRoute.path,
    contentRoute.options,
    contentRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
  );

  const mkdirRoute = defineRoute(
    {
      method: 'POST',
      path: '/fs::mkdir',
      body: fsMkdirBodySchema,
      success: { data: fsMkdirResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_ALREADY_EXISTS]: {},
      },
      description:
        'Create a directory on the host filesystem by absolute path (folder-picker "new folder" backend). Non-recursive: the parent directory must already exist.',
      tags: ['workspaces'],
      operationId: 'fsMkdir',
    },
    async (req, reply) => {
      return handleFsMkdir(req, reply);
    },
  );
  app.post(
    mkdirRoute.path,
    mkdirRoute.options,
    mkdirRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['post']>[2],
  );

  const writeRoute = defineRoute(
    {
      method: 'PUT',
      path: '/fs::content',
      querystring: fsContentQuerySchema,
      success: { data: fsWriteResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.FS_TOO_LARGE]: {},
      },
      description:
        'Write the raw request body (application/octet-stream, up to 10 MiB) to a file at an absolute host path. The parent directory must already exist.',
      tags: ['workspaces'],
      operationId: 'fsWrite',
      consumes: ['application/octet-stream'],
    },
    async (req, reply) => {
      const { path } = req.query as { path: string };
      if (!isAbsolute(path)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, req.id),
        );
        return;
      }
      if (!Buffer.isBuffer(req.body)) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'request body must be raw bytes with content-type application/octet-stream',
            req.id,
          ),
        );
        return;
      }
      const hostFs = core.accessor.get(IHostFileSystem);
      const parent = dirname(path);
      let parentAbs: string;
      let parentStat: HostFileStat;
      try {
        parentAbs = await hostFs.realpath(parent);
        parentStat = await hostFs.stat(parentAbs);
      } catch (error) {
        sendOsFsError(reply, req.id, error, parent);
        return;
      }
      if (!parentStat.isDirectory) {
        reply.send(
          errEnvelope(
            ErrorCode.FS_PATH_NOT_FOUND,
            `parent path is not a directory: ${parent}`,
            req.id,
          ),
        );
        return;
      }
      const abs = join(parentAbs, basename(path));
      try {
        const existing = await hostFs.stat(abs).catch(() => undefined);
        if (existing?.isDirectory === true) {
          reply.send(
            errEnvelope(ErrorCode.FS_IS_DIRECTORY, `path is a directory: ${path}`, req.id),
          );
          return;
        }
        await hostFs.writeBytes(abs, req.body);
      } catch (error) {
        sendOsFsError(reply, req.id, error, path);
        return;
      }
      reply.send(okEnvelope({ path: abs, size: req.body.length }, req.id));
    },
  );
  app.put(
    writeRoute.path,
    writeRoute.options,
    writeRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['put']>[2],
  );
}

const fsContentQuerySchema = z.object({
  path: z.string().min(1),
});

const fsListQuerySchema = z.object({
  path: z.string().min(1),
});

const fsListEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  is_dir: z.boolean(),
  size: z.number().int().optional(),
  modified_at: z.string().optional(),
});

const fsListResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(fsListEntrySchema),
});

const fsWriteResponseSchema = z.object({
  path: z.string(),
  size: z.number().int(),
});

interface FsContentRequest {
  id: string;
  query: { path: string };
  headers: Record<string, unknown>;
}

async function handleFsContent(
  core: Scope,
  req: FsContentRequest,
  reply: FsContentReply,
): Promise<void> {
  const requestId = req.id;
  const { path } = req.query;
  if (!isAbsolute(path)) {
    reply.send(
      errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, requestId),
    );
    return;
  }

  const hostFs = core.accessor.get(IHostFileSystem);

  let abs: string;
  let st: HostFileStat;
  try {
    abs = await hostFs.realpath(path);
    st = await hostFs.stat(abs);
  } catch (error) {
    sendOsFsError(reply, requestId, error, path);
    return;
  }

  if (st.isDirectory) {
    reply.send(
      errEnvelope(ErrorCode.FS_IS_DIRECTORY, `path is a directory: ${path}`, requestId),
    );
    return;
  }
  if (!st.isFile) {
    reply.send(
      errEnvelope(
        ErrorCode.VALIDATION_FAILED,
        `path is not a regular file: ${path}`,
        requestId,
      ),
    );
    return;
  }

  let isBinary = false;
  try {
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await hostFs.readBytes(abs, sampleSize);
    const classification = classifyTextSample(sample);
    isBinary = classification.isBinary || classification.encoding !== 'utf-8';
  } catch (error) {
    sendOsFsError(reply, requestId, error, path);
    return;
  }

  const etag = buildEtag(st);
  const ifNoneMatch = pickHeader(req.headers, 'if-none-match');
  if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
    reply.code(304).header('etag', etag).send('');
    return;
  }

  reply.header('etag', etag);
  reply.header('last-modified', new Date(st.mtimeMs ?? 0).toUTCString());
  reply.type(guessMime(abs, isBinary));

  const log = requestLog(req);
  const onStreamError = (stream: ReadStream) => (error: unknown) => {
    log?.warn({ path, err: error }, 'fs content stream error');
    try {
      stream.destroy();
    } catch {
    }
  };

  const range = parseRangeHeader(pickHeader(req.headers, 'range'), st.size);
  if (range !== null) {
    reply
      .code(206)
      .header('content-length', String(range.length))
      .header('content-range', `bytes ${range.start}-${range.end}/${st.size}`);
    const stream = createReadStream(abs, { start: range.start, end: range.end });
    stream.on('error', onStreamError(stream));
    return reply.send(stream) as unknown as void;
  }

  reply.code(200).header('content-length', String(st.size));
  const stream = createReadStream(abs);
  stream.on('error', onStreamError(stream));
  return reply.send(stream) as unknown as void;
}

const fsMkdirBodySchema = z.object({
  path: z.string().min(1),
});

const fsMkdirResponseSchema = z.object({
  path: z.string(),
});

interface FsMkdirRequest {
  id: string;
  body: { path: string };
}

async function handleFsMkdir(
  req: FsMkdirRequest,
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const requestId = req.id;
  const { path } = req.body;
  if (!isAbsolute(path)) {
    reply.send(
      errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, requestId),
    );
    return;
  }

  try {
    await mkdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    switch (code) {
      case 'EEXIST':
        reply.send(
          errEnvelope(ErrorCode.FS_ALREADY_EXISTS, `path already exists: ${path}`, requestId),
        );
        return;
      case 'ENOENT':
      case 'ENOTDIR':
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `parent path not found: ${path}`, requestId),
        );
        return;
      case 'EACCES':
      case 'EPERM':
        reply.send(
          errEnvelope(ErrorCode.FS_PERMISSION_DENIED, `permission denied: ${path}`, requestId),
        );
        return;
    }
    throw error;
  }

  reply.send(okEnvelope({ path }, requestId));
}

function sendOsFsError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
  path: string,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path not found: ${path}`, requestId),
        );
        return;
      case ErrorCodes.OS_FS_PERMISSION_DENIED:
        reply.send(
          errEnvelope(ErrorCode.FS_PERMISSION_DENIED, `permission denied: ${path}`, requestId),
        );
        return;
    }
  }
  throw err;
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof HostFolderNotAbsoluteError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
    return;
  }
  if (err instanceof HostFolderNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
    return;
  }
  if (err instanceof HostFolderPermissionError) {
    reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, err.message, requestId, err.stack));
    return;
  }
  throw err;
}
