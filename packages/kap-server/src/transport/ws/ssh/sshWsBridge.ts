import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import { SshRemoteError, type SshConnectionManager } from '@moonshot-ai/ssh-remote';
import { WebSocket, WebSocketServer } from 'ws';

import { selectWsBearerProtocol } from '../bearerProtocol';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface SshWsBridge {
  handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    name: string,
    version: '1' | '3',
  ): Promise<void>;
}

export interface SshWsBridgeOptions {
  readonly service: SshConnectionManager;
  readonly handshakeTimeoutMs?: number;
}

export function createSshWsBridge(opts: SshWsBridgeOptions): SshWsBridge {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    name: string,
    version: '1' | '3',
  ): Promise<void> => {
    let handle;
    try {
      handle = await opts.service.connect(name);
    } catch (error) {
      const notFound = error instanceof SshRemoteError && error.kind === 'config';
      writeUpgradeError(socket, notFound ? 404 : 502);
      return;
    }
    let upstream: WebSocket;
    try {
      upstream = await connectUpstream(
        handle.localOrigin,
        version,
        handle.remoteToken,
        opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      );
    } catch {
      writeUpgradeError(socket, 502);
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      bridgeSockets(client, upstream);
    });
  };

  return { handleUpgrade };
}

function writeUpgradeError(socket: Socket, status: 404 | 502): void {
  const reason = status === 404 ? 'Not Found' : 'Bad Gateway';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function connectUpstream(
  localOrigin: string,
  version: '1' | '3',
  token: string,
  handshakeTimeoutMs: number,
): Promise<WebSocket> {
  const url = `${localOrigin.replace(/^http/, 'ws')}/api/v${version}/ws`;
  const protocol = `kimi-code.bearer.${token}`;
  if (isWebSocketProtocolToken(protocol)) {
    try {
      return await connectUpstreamAttempt(url, [protocol], {}, handshakeTimeoutMs);
    } catch {
    }
  }
  return connectUpstreamAttempt(
    url,
    undefined,
    { Authorization: `Bearer ${token}` },
    handshakeTimeoutMs,
  );
}

function connectUpstreamAttempt(
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string>,
  handshakeTimeoutMs: number,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { headers, handshakeTimeout: handshakeTimeoutMs });
    let settled = false;
    const cleanup = (): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(socket);
      else reject(error);
    };
    const onOpen = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number, reason: Buffer): void => {
      finish(new Error(`WebSocket closed during handshake (${code} ${reason.toString()})`));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function isWebSocketProtocolToken(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function bridgeSockets(left: WebSocket, right: WebSocket): void {
  let closed = false;
  const closeBoth = (code = 1000, reason = Buffer.alloc(0)): void => {
    if (closed) return;
    closed = true;
    const safeCode = isValidCloseCode(code) ? code : 1000;
    if (left.readyState === WebSocket.OPEN) left.close(safeCode, reason);
    if (right.readyState === WebSocket.OPEN) right.close(safeCode, reason);
  };
  left.on('message', (data, isBinary) => {
    if (right.readyState === WebSocket.OPEN) right.send(data, { binary: isBinary });
  });
  right.on('message', (data, isBinary) => {
    if (left.readyState === WebSocket.OPEN) left.send(data, { binary: isBinary });
  });
  left.once('close', closeBoth);
  right.once('close', closeBoth);
  left.once('error', () => closeBoth(1011));
  right.once('error', () => closeBoth(1011));
}

function isValidCloseCode(code: number): boolean {
  return (
    code === 1000 ||
    code === 1001 ||
    code === 1002 ||
    code === 1003 ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}
