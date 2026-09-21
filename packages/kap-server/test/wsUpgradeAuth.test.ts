import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IModelCatalog } from '@moonshot-ai/agent-core-v2';
import { createActor, setup } from '@moonshot-ai/agent-core-v2/human/xstate2';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { startServer } from '../src/start';
import { fakeModelCatalog } from './helpers/fakeModelCatalog';
import { fakeSshConnectionManager } from './helpers/fakeSshConnectionManager';
import { fixedTokenAuth } from './helpers/fixedAuth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { sharedServer } from './helpers/sharedServer';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface ConnectOptions {
  readonly protocols?: string[];
  readonly headers?: Record<string, string>;
}

function openConn(url: string, opts?: ConnectOptions): Promise<{ ws: WebSocket; firstFrame: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    ws.once('message', (data) => {
      try {
        resolve({ ws, firstFrame: JSON.parse(rawToString(data)) });
      } catch {
        resolve({ ws, firstFrame: null });
      }
    });
    ws.once('error', reject);
  });
}

function expectRejected(url: string, opts?: ConnectOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
      }
      if (err !== undefined) reject(err);
      else resolve();
    };
    const t = setTimeout(
      () => done(new Error('connection was not rejected within timeout')),
      1500,
    );
    ws.once('open', () => done(new Error('connection unexpectedly opened')));
    ws.once('error', () => done());
    ws.once('close', () => done());
  });
}

describe('WS upgrade auth', () => {
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
  });

  function v1Url(): string {
    return `${sharedServer().base.replace(/^http/, 'ws')}/api/v1/ws`;
  }

  function token(): string {
    return sharedServer().token;
  }

  describe('/api/v1/ws', () => {
    const firstType = 'server_hello';
    const url = (): string => v1Url();

    it('accepts a valid bearer subprotocol and echoes it', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        protocols: [`kimi-code.bearer.${token()}`],
      });
      sockets.push(ws);
      expect(ws.protocol).toBe(`kimi-code.bearer.${token()}`);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('rejects a wrong bearer token', async () => {
      await expectRejected(url(), { protocols: ['kimi-code.bearer.wrong'] });
    });

    it('rejects a connection with no token', async () => {
      await expectRejected(url());
    });
  });

  describe('/api/v1/debug/ws', () => {
    it('streams xstate inspection envelopes to an authorized client', async () => {
      const home = await mkdtemp(join(tmpdir(), 'kimi-kap-debug-ws-'));
      const server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        debugEndpoints: true,
        authTokenService: fixedTokenAuth(),
        seeds: [[IModelCatalog, fakeModelCatalog()]],
      });
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/debug/ws`, {
        headers: { Authorization: 'Bearer test-token' },
      });
      sockets.push(ws);
      try {
        const envelope = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('no inspection envelope within timeout')),
            5000,
          );
          ws.on('message', (data) => {
            const frame = JSON.parse(rawToString(data)) as Record<string, unknown>;
            if (frame['eventType'] === 'debug.probe') {
              clearTimeout(timer);
              resolve(frame);
            }
          });
          ws.on('error', reject);
          ws.once('open', () => {
            const machine = setup({}).createMachine({
              id: 'debugWsProbe',
              initial: 'idle',
              states: { idle: { on: { 'debug.probe': 'done' } }, done: {} },
            });
            const actor = createActor(machine);
            actor.start();
            actor.send({ type: 'debug.probe' });
          });
        });
        expect(envelope['type']).toBe('@xstate.event');
        expect(envelope['logicId']).toBe('debugWsProbe');
        expect(typeof envelope['actorSessionId']).toBe('string');
        expect(typeof envelope['timestamp']).toBe('number');
      } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  it('rejects upgrades to a non-WS path', async () => {
    const badUrl = `${v1Url().replace('/api/v1/ws', '/api/v1/other')}`;
    await expectRejected(badUrl, { protocols: [`kimi-code.bearer.${token()}`] });
    const debugUrl = `${v1Url().replace('/api/v1/ws', '/api/v1/debug/ws')}`;
    await expectRejected(debugUrl, { protocols: [`kimi-code.bearer.${token()}`] });
  });

  describe('/ssh/{name} ws bridge', () => {
    async function startWsEchoRemote(): Promise<{
      port: number;
      protocols: (string | undefined)[];
      close(): Promise<void>;
    }> {
      const protocols: (string | undefined)[] = [];
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (ws) => {
        ws.on('message', (data, isBinary) => {
          ws.send(data, { binary: isBinary });
        });
        ws.on('error', () => {});
      });
      const server: Server = createServer();
      server.on('upgrade', (req, socket, head) => {
        protocols.push(req.headers['sec-websocket-protocol']);
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
        port,
        protocols,
        close: () =>
          new Promise((resolve, reject) => {
            for (const client of wss.clients) client.terminate();
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      };
    }

    function openBridged(url: string, protocols?: string[]): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, protocols);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error('bridge open timed out'));
        }, 5000);
        ws.once('open', () => {
          clearTimeout(timer);
          resolve(ws);
        });
        ws.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    }

    function nextMessage(ws: WebSocket): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge echo timed out')), 5000);
        ws.once('message', (data) => {
          clearTimeout(timer);
          resolve(rawToString(data));
        });
      });
    }

    it('rejects without a token, bridges v1 with a valid token, and destroys unknown paths', async () => {
      const remote = await startWsEchoRemote();
      const home = await mkdtemp(join(tmpdir(), 'kimi-kap-ssh-ws-'));
      const server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        authTokenService: fixedTokenAuth(),
        seeds: [[IModelCatalog, fakeModelCatalog()]],
        sshConnectionManager: fakeSshConnectionManager({
          handleFor: () => ({
            localOrigin: `http://127.0.0.1:${remote.port}`,
            remoteToken: 'remote-secret',
          }),
        }),
      });
      try {
        const added = await fetch(`http://127.0.0.1:${server.port}/api/v1/ssh/connections`, {
          method: 'POST',
          headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'alpha', host: 'example.com' }),
        } as never);
        expect(added.status).toBe(200);

        const wsBase = `ws://127.0.0.1:${server.port}`;
        await expectRejected(`${wsBase}/ssh/alpha/api/v1/ws`);
        await expectRejected(`${wsBase}/ssh/alpha/api/v2/ws`, {
          protocols: ['kimi-code.bearer.test-token'],
        });
        await expectRejected(`${wsBase}/ssh/alpha/other`, {
          protocols: ['kimi-code.bearer.test-token'],
        });
        await expectRejected(`${wsBase}/ssh/ghost/api/v1/ws`, {
          protocols: ['kimi-code.bearer.test-token'],
        });

        for (const version of ['v1'] as const) {
          const ws = await openBridged(`${wsBase}/ssh/alpha/api/${version}/ws`, [
            'kimi-code.bearer.test-token',
          ]);
          sockets.push(ws);
          expect(ws.protocol).toBe('kimi-code.bearer.test-token');
          const echoed = nextMessage(ws);
          ws.send(`hello-${version}`);
          expect(await echoed).toBe(`hello-${version}`);
          ws.close();
        }
        expect(remote.protocols).toEqual(['kimi-code.bearer.remote-secret']);
      } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
        await remote.close();
      }
    });
  });
});
