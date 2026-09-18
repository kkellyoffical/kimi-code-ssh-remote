import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { WebSocketServer } from 'ws';

import { ErrorCode } from '../src/protocol/error-codes';
import { registerSshProxyRoutes } from '../src/routes/sshProxy';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch, bearerToken } from './helpers/auth';
import { fakeSshConnectionManager, type FakeSshConnectionManager } from './helpers/fakeSshConnectionManager';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const REMOTE_TOKEN = 'remote-secret-token';

interface CapturedRequest {
  method: string;
  url: string;
  rawHeaders: readonly string[];
  body: Buffer;
}

interface FakeRemote {
  origin: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function startFakeRemote(): Promise<FakeRemote> {
  const requests: CapturedRequest[] = [];
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
    ws.on('error', () => {});
  });
  const bigBody = Buffer.alloc(10000, 'x');
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        rawHeaders: req.rawHeaders.slice(),
        body,
      });
      const url = req.url ?? '';
      if (url === '/api/v1/echo') {
        const echo = {
          code: 0,
          msg: 'success',
          data: {
            authorization: req.headers['authorization'] ?? null,
            cookie: req.headers['cookie'] ?? null,
            host: req.headers['host'] ?? null,
            connection: req.headers['connection'] ?? null,
            body_length: body.length,
            content_type: req.headers['content-type'] ?? null,
          },
          request_id: 'remote-req-1',
        };
        const payload = JSON.stringify(echo);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
        return;
      }
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>remote</title></head><body><script src="/assets/app.js"></script></body></html>');
        return;
      }
      if (url === '/assets/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('var u="/assets/chunk.js";load(u);');
        return;
      }
      if (url === '/partial.html') {
        res.writeHead(206, {
          'content-type': 'text/html; charset=utf-8',
          'content-range': 'bytes 0-59/120',
        });
        res.end('<html><head></head><body><script src="/assets/app.js"></s');
        return;
      }
      if (url === '/big.bin') {
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers['range'] ?? '');
        if (range !== null) {
          const start = Number(range[1]);
          const end = Number(range[2]);
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${bigBody.length}`,
            'accept-ranges': 'bytes',
          });
          res.end(bigBody.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
        });
        res.end(bigBody);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 40401, msg: 'not found', data: null, request_id: 'r' }));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

describe('server-v2 /ssh/{name} proxy', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let remote: FakeRemote;
  let fake: FakeSshConnectionManager;
  let base: string;

  beforeAll(async () => {
    remote = await startFakeRemote();
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-proxy-'));
    fake = fakeSshConnectionManager({
      handleFor: (name) =>
        name === 'dead'
          ? { localOrigin: 'http://127.0.0.1:1', remoteToken: REMOTE_TOKEN }
          : { localOrigin: remote.origin, remoteToken: REMOTE_TOKEN },
    });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      sshConnectionManager: fake,
    });
    base = `http://127.0.0.1:${server.port}`;
    const add = async (name: string): Promise<void> => {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/ssh/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, host: 'example.com' }),
      });
      expect(res.status).toBe(200);
    };
    await add('alpha');
    await add('dead');
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    await remote.close();
  });

  function lastRemoteRequest(): CapturedRequest {
    const captured = remote.requests.at(-1);
    expect(captured).toBeDefined();
    return captured as CapturedRequest;
  }

  it('serves the management page at /ssh without auth', async () => {
    const res = await fetch(`${base}/ssh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('SSH 连接');
  });

  it('lazily connects and forwards requests, replacing auth and stripping cookie/host', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/api/v1/echo', {
      headers: { cookie: 'session=secret', connection: 'keep-alive, x-hop' },
    });
    expect(res.status).toBe(200);
    expect(fake.connectCalls).toContain('alpha');

    const envelope = (await res.json()) as {
      code: number;
      data: {
        authorization: string | null;
        cookie: string | null;
        host: string | null;
        connection: string | null;
      };
    };
    expect(envelope.code).toBe(0);
    expect(envelope.data.authorization).toBe(`Bearer ${REMOTE_TOKEN}`);
    expect(envelope.data.cookie).toBeNull();
    expect(envelope.data.host).toBe(new URL(remote.origin).host);
    expect(envelope.data.connection ?? '').not.toContain('x-hop');
  });

  it('returns 404 with SSH_CONNECTION_NOT_FOUND for unknown connections', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/ghost/api/v1/echo');
    expect(res.status).toBe(404);
    const envelope = (await res.json()) as { code: number };
    expect(envelope.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
  });

  it('returns 502 with SSH_UNREACHABLE when the tunnel endpoint is down', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/dead/api/v1/echo');
    expect(res.status).toBe(502);
    const envelope = (await res.json()) as { code: number };
    expect(envelope.code).toBe(ErrorCode.SSH_UNREACHABLE);
  });

  it('passes JSON envelopes through byte-identical', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/api/v1/echo');
    const text = await res.text();
    const parsed = JSON.parse(text) as { request_id: string };
    expect(parsed.request_id).toBe('remote-req-1');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('rewrites HTML responses under the /ssh/{name} prefix', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('src="/ssh/alpha/assets/app.js"');
    expect(body).toContain('kimi-desktop-server-origin');
    expect(body).not.toContain('src="/assets/app.js"');
  });

  it('rewrites javascript asset references', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/assets/app.js');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"/ssh/alpha/assets/chunk.js"');
  });

  it('forwards Range requests and 206 responses untouched', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/big.bin', {
      headers: { range: 'bytes=100-199' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/10000');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body.toString()).toBe('x'.repeat(100));
  });

  it('streams 206 html responses with content-range through without rewriting', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/partial.html', {
      headers: { range: 'bytes=0-59' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-59/120');
    const body = await res.text();
    expect(body).toContain('src="/assets/app.js"');
    expect(body).not.toContain('/ssh/alpha/assets');
  });

  it('streams full downloads without rewriting', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/big.bin');
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(10000);
  });

  it('passes multipart uploads larger than 1MiB through byte-identical', async () => {
    const boundary = '----kimitestboundary0123456789';
    const filler = Buffer.alloc(1536 * 1024, 'y');
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="blob.bin"\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      filler,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await authedFetch(server as RunningServer, base, '/ssh/alpha/api/v1/echo', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: multipart as unknown as string,
    });
    expect(res.status).toBe(200);
    const captured = lastRemoteRequest();
    expect(captured.method).toBe('POST');
    expect(captured.body.equals(multipart)).toBe(true);
    const envelope = (await res.json()) as { data: { body_length: number; content_type: string } };
    expect(envelope.data.body_length).toBe(multipart.length);
    expect(envelope.data.content_type).toContain('multipart/form-data');
  });

  it('rejects proxy requests without a token', async () => {
    const res = await fetch(`${base}/ssh/alpha/api/v1/echo`);
    expect(res.status).toBe(401);
  });
});

describe('server-v2 /ssh/{name} proxy upstream timeout', () => {
  it('maps a stalled tunnel endpoint to 502 SSH_UNREACHABLE after the upstream timeout', async () => {
    const stall = createServer(() => {});
    const stallPort = await new Promise<number>((resolve, reject) => {
      stall.once('error', reject);
      stall.listen(0, '127.0.0.1', () => {
        const address = stall.address();
        if (address === null || typeof address === 'string') reject(new Error('missing address'));
        else resolve(address.port);
      });
    });
    const fake = fakeSshConnectionManager({
      handleFor: () => ({
        localOrigin: `http://127.0.0.1:${stallPort}`,
        remoteToken: REMOTE_TOKEN,
      }),
    });
    await fake.add({ name: 'alpha', host: 'example.com' });
    const app = Fastify({ logger: false });
    await registerSshProxyRoutes(app, { service: fake, upstreamTimeoutMs: 200 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ssh/alpha/api/v1/echo`);
      expect(res.status).toBe(502);
      const envelope = (await res.json()) as { code: number; msg: string };
      expect(envelope.code).toBe(ErrorCode.SSH_UNREACHABLE);
      expect(envelope.msg).toContain('timed out');
    } finally {
      await app.close();
      stall.closeAllConnections();
      await new Promise<void>((resolve) => stall.close(() => resolve()));
    }
  });
});

describe('server-v2 /ssh page entry url', () => {
  it('builds kimi_origin entry urls usable by the local web bundle', () => {
    const origin = 'http://127.0.0.1:58627';
    const name = 'alpha';
    const url = `${origin}/?kimi_origin=${encodeURIComponent(`${origin}/ssh/${name}`)}#token=local-token`;
    expect(url).toBe(
      'http://127.0.0.1:58627/?kimi_origin=http%3A%2F%2F127.0.0.1%3A58627%2Fssh%2Falpha#token=local-token',
    );
  });
});


describe('server-v2 /ssh/{name} proxy to a real kap-server', () => {
  let remoteServer: RunningServer | undefined;
  let localServer: RunningServer | undefined;
  let remoteHome: string | undefined;
  let localHome: string | undefined;
  let workDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    remoteHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-e2e-remote-'));
    localHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-e2e-local-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-e2e-work-'));
    remoteServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: remoteHome,
      logLevel: 'silent',
    });
    const remoteOrigin = `http://127.0.0.1:${remoteServer.port}`;
    const remoteToken = bearerToken(remoteServer);
    const fake = fakeSshConnectionManager({
      handleFor: () => ({ localOrigin: remoteOrigin, remoteToken }),
    });
    localServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: localHome,
      logLevel: 'silent',
      sshConnectionManager: fake,
    });
    base = `http://127.0.0.1:${localServer.port}`;
    const add = await authedFetch(localServer, base, '/api/v1/ssh/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e', host: 'example.com' }),
    });
    if (add.status !== 200) {
      throw new Error(`failed to seed e2e connection: ${add.status}`);
    }
  });

  afterAll(async () => {
    if (localServer !== undefined) await localServer.close();
    if (remoteServer !== undefined) await remoteServer.close();
    if (localHome !== undefined) await rm(localHome, { recursive: true, force: true });
    if (remoteHome !== undefined) await rm(remoteHome, { recursive: true, force: true });
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  it('writes, lists, and downloads remote files through the tunnel', async () => {
    const target = join(workDir as string, 'through-tunnel.txt');
    const payload = Buffer.from('proxied content ✅');

    const written = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:content?path=${encodeURIComponent(target)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(payload) as unknown as string,
      },
    );
    expect(written.status).toBe(200);
    const writtenBody = (await written.json()) as { code: number; data: { size: number } };
    expect(writtenBody.code).toBe(0);
    expect(writtenBody.data.size).toBe(payload.length);

    const listed = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:list?path=${encodeURIComponent(workDir as string)}`,
    );
    const listedBody = (await listed.json()) as {
      code: number;
      data: { entries: { name: string; is_dir: boolean; size?: number }[] };
    };
    expect(listedBody.code).toBe(0);
    const entry = listedBody.data.entries.find((item) => item.name === 'through-tunnel.txt');
    expect(entry?.is_dir).toBe(false);
    expect(entry?.size).toBe(payload.length);

    const downloaded = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:content?path=${encodeURIComponent(target)}`,
    );
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(payload)).toBe(true);
  });

  it('creates a remote directory and lists remote workspaces through the tunnel', async () => {
    const mkdirRes = await authedFetch(
      localServer as RunningServer,
      base,
      '/ssh/e2e/api/v1/fs:mkdir',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: join(workDir as string, 'made-remotely') }),
      },
    );
    const mkdirBody = (await mkdirRes.json()) as { code: number };
    expect(mkdirBody.code).toBe(0);

    const created = await authedFetch(
      remoteServer as RunningServer,
      `http://127.0.0.1:${remoteServer!.port}`,
      '/api/v1/workspaces',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: workDir }),
      },
    );
    expect(created.status).toBe(200);

    const listed = await authedFetch(
      localServer as RunningServer,
      base,
      '/ssh/e2e/api/v1/workspaces',
    );
    const listedBody = (await listed.json()) as {
      code: number;
      data: { items: { id: string; root: string; name: string }[] };
    };
    expect(listedBody.code).toBe(0);
    expect(listedBody.data.items.some((ws) => ws.root === workDir)).toBe(true);
  });
});
