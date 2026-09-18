import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Event2,
  IAgentLifecycleService,
  IEventBus,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders, authedFetch, bearerToken } from './helpers/auth';
import { fakeSshConnectionManager } from './helpers/fakeSshConnectionManager';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Frame {
  type: string;
  id?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

interface Conn {
  ws: WebSocket;
  frames: Frame[];
  send(frame: unknown): void;
  next(pred: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  close(): Promise<void>;
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function openConn(url: string, token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const frames: Frame[] = [];
    const waiters: Array<{ pred: (f: Frame) => boolean; res: (f: Frame) => void }> = [];
    ws.on('message', (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(rawToString(data)) as Frame;
      } catch {
        return;
      }
      const index = waiters.findIndex((w) => w.pred(frame));
      if (index >= 0) waiters.splice(index, 1)[0]!.res(frame);
      else frames.push(frame);
    });
    ws.once('open', () =>
      resolve({
        ws,
        frames,
        send: (frame) => ws.send(JSON.stringify(frame)),
        next: (pred, timeoutMs = 5000) =>
          new Promise<Frame>((res, rej) => {
            const index = frames.findIndex(pred);
            if (index >= 0) {
              res(frames.splice(index, 1)[0]!);
              return;
            }
            const waiter: { pred: (f: Frame) => boolean; res: (f: Frame) => void } = {
              pred,
              res: (f) => {
                clearTimeout(timer);
                res(f);
              },
            };
            const timer = setTimeout(() => {
              const i = waiters.indexOf(waiter);
              if (i >= 0) waiters.splice(i, 1);
              rej(new Error('timeout waiting for frame'));
            }, timeoutMs);
            waiters.push(waiter);
          }),
        close: () =>
          new Promise<void>((res) => {
            ws.once('close', () => res());
            ws.close();
          }),
      }),
    );
    ws.once('error', reject);
  });
}

function upgradeError(url: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('upgrade was not rejected within timeout'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error('upgrade unexpectedly succeeded'));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
  });
}

describe('server-v2 /ssh/{name} ws bridge to a real kap-server', () => {
  let remoteServer: RunningServer | undefined;
  let localServer: RunningServer | undefined;
  let remoteHome: string | undefined;
  let localHome: string | undefined;
  let workDir: string | undefined;
  let remoteBase: string;
  let wsBase: string;
  let localToken: string;
  const conns: Conn[] = [];

  beforeAll(async () => {
    remoteHome = await mkdtemp(join(tmpdir(), 'kimi-ssh-ws-bridge-remote-'));
    localHome = await mkdtemp(join(tmpdir(), 'kimi-ssh-ws-bridge-local-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-ssh-ws-bridge-work-'));
    remoteServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: remoteHome,
      logLevel: 'silent',
    });
    remoteBase = `http://127.0.0.1:${remoteServer.port}`;
    const remoteToken = bearerToken(remoteServer);
    const fake = fakeSshConnectionManager({
      handleFor: () => ({ localOrigin: remoteBase, remoteToken }),
    });
    localServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: localHome,
      logLevel: 'silent',
      sshConnectionManager: fake,
    });
    wsBase = `ws://127.0.0.1:${localServer.port}`;
    localToken = bearerToken(localServer);
    const add = await authedFetch(
      localServer,
      `http://127.0.0.1:${localServer.port}`,
      '/api/v1/ssh/connections',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'e2e', host: 'example.com' }),
      },
    );
    if (add.status !== 200) {
      throw new Error(`failed to seed e2e connection: ${add.status}`);
    }
  });

  afterAll(async () => {
    for (const conn of conns.splice(0)) {
      try {
        conn.ws.terminate();
      } catch {
      }
    }
    if (localServer !== undefined) await localServer.close();
    if (remoteServer !== undefined) await remoteServer.close();
    if (localHome !== undefined) await rm(localHome, { recursive: true, force: true });
    if (remoteHome !== undefined) await rm(remoteHome, { recursive: true, force: true });
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  async function open(url: string): Promise<Conn> {
    const conn = await openConn(url, localToken);
    conns.push(conn);
    return conn;
  }

  async function createRemoteSession(): Promise<string> {
    const res = await fetch(`${remoteBase}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(remoteServer as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: workDir } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function ensureRemoteMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(remoteServer!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.handleOf('main') === undefined) {
      await agents.create({ agentId: 'main' });
    }
  }

  function emitRemoteAgentEvent(sessionId: string, event: Event2<any>): void {
    const session = getLiveSessionById(remoteServer!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const main = agents.handleOf('main');
    expect(main).toBeDefined();
    main!.accessor.get(IEventBus).publish(event);
  }

  it('delivers server_hello as the first frame over the v1 bridge', async () => {
    const conn = await open(`${wsBase}/ssh/e2e/api/v1/ws?client_id=ssh-ws-bridge-test`);
    const first = await conn.next(() => true);
    expect(first.type).toBe('server_hello');
    expect(first.payload).toMatchObject({ protocol_version: 2 });
    await conn.close();
  });

  it('answers client_hello and delivers remote-pushed events over the v1 bridge', async () => {
    const sid = await createRemoteSession();
    await ensureRemoteMainAgent(sid);
    const conn = await open(`${wsBase}/ssh/e2e/api/v1/ws?client_id=ssh-ws-bridge-test`);
    await conn.next((f) => f.type === 'server_hello');

    conn.send({
      type: 'client_hello',
      id: 'h1',
      payload: {
        client_id: 'ssh-ws-bridge-test',
        token: bearerToken(remoteServer as RunningServer),
        subscriptions: ['session-does-not-exist'],
      },
    });
    const helloAck = await conn.next((f) => f.type === 'ack' && f.id === 'h1');
    expect(helloAck.payload).toMatchObject({ resync_required: ['session-does-not-exist'] });

    conn.send({ type: 'subscribe', id: 's1', payload: { session_ids: [sid] } });
    const subAck = await conn.next((f) => f.type === 'ack' && f.id === 's1');
    expect(subAck.payload).toMatchObject({ accepted: [sid] });

    emitRemoteAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as Event2<any>);
    const ev = await conn.next((f) => f.type === 'turn.started');
    expect(ev.session_id).toBe(sid);
    await conn.close();
  });

  it('delivers hello as the first frame over the v3 bridge', async () => {
    const conn = await open(`${wsBase}/ssh/e2e/api/v3/ws`);
    const first = await conn.next(() => true);
    expect(first as unknown as Record<string, unknown>).toMatchObject({
      type: 'hello',
      protocol_version: '3',
    });
    await conn.close();
  });

  it('rejects a bad token with 401 and an unknown connection with 404', async () => {
    const unauthorized = await upgradeError(`${wsBase}/ssh/e2e/api/v1/ws`, 'wrong-token');
    expect(unauthorized).toContain('401');
    const notFound = await upgradeError(`${wsBase}/ssh/ghost/api/v1/ws`, localToken);
    expect(notFound).toContain('404');
  });
});
