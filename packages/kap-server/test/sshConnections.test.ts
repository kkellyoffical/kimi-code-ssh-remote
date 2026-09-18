import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SshRemoteError } from '@moonshot-ai/ssh-remote';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { fakeSshConnectionManager, type FakeSshConnectionManager } from './helpers/fakeSshConnectionManager';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

interface SshConnectionWire {
  name: string;
  host: string;
  user?: string;
  port: number;
  identity_file?: string;
  has_password: boolean;
  status: {
    state: 'off' | 'connecting' | 'on' | 'error';
    local_origin?: string;
    error?: string;
    needs_password?: boolean;
    host_key?: {
      host: string;
      port: number;
      fingerprint?: string;
      key_type?: string;
      expected_fingerprint?: string;
      known_hosts_file?: string;
      known_hosts_line?: number;
    };
  };
}

describe('server-v2 /api/v1/ssh/connections', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let base: string;
  let fake: FakeSshConnectionManager;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-'));
    fake = fakeSshConnectionManager();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      sshConnectionManager: fake,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  async function postJson<T>(path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await authedFetch(server as RunningServer, base, path, {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<T>;
  }

  it('lists, adds, gets, and removes connections with snake_case wire fields', async () => {
    const initial = await authedFetch(server as RunningServer, base, '/api/v1/ssh/connections');
    const initialBody = (await initial.json()) as Envelope<{ connections: SshConnectionWire[] }>;
    expect(initialBody.code).toBe(0);
    expect(initialBody.data.connections).toEqual([]);

    const added = await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'devbox',
      host: '192.168.1.10',
      user: 'dev',
      port: 2222,
      identity_file: '~/.ssh/id_ed25519',
    });
    expect(added.code).toBe(0);
    expect(added.data).toMatchObject({
      name: 'devbox',
      host: '192.168.1.10',
      user: 'dev',
      port: 2222,
      identity_file: '~/.ssh/id_ed25519',
      status: { state: 'off' },
    });

    const fetched = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/devbox',
    );
    const fetchedBody = (await fetched.json()) as Envelope<SshConnectionWire>;
    expect(fetchedBody.code).toBe(0);
    expect(fetchedBody.data.host).toBe('192.168.1.10');

    const missing = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/ghost',
    );
    const missingBody = (await missing.json()) as Envelope<null>;
    expect(missingBody.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);

    const removed = await authedFetch(server as RunningServer, base, '/api/v1/ssh/connections/devbox', {
      method: 'DELETE',
    });
    const removedBody = (await removed.json()) as Envelope<{ name: string }>;
    expect(removedBody.code).toBe(0);
    expect(removedBody.data).toEqual({ name: 'devbox' });

    const removedAgain = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/devbox',
      { method: 'DELETE' },
    );
    const removedAgainBody = (await removedAgain.json()) as Envelope<null>;
    expect(removedAgainBody.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
  });

  it('rejects duplicate adds, invalid names, and invalid profiles', async () => {
    const added = await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'dup',
      host: 'example.com',
    });
    expect(added.code).toBe(0);
    expect(added.data.port).toBe(22);

    const duplicate = await postJson<null>('/api/v1/ssh/connections', {
      name: 'dup',
      host: 'example.com',
    });
    expect(duplicate.code).toBe(ErrorCode.SSH_CONNECTION_ALREADY_EXISTS);

    const badName = await postJson<null>('/api/v1/ssh/connections', {
      name: 'not a name',
      host: 'example.com',
    });
    expect(badName.code).toBe(ErrorCode.VALIDATION_FAILED);

    const leadingDashHost = await postJson<null>('/api/v1/ssh/connections', {
      name: 'dashy',
      host: '-oProxyCommand=evil',
    });
    expect(leadingDashHost.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('tests, connects, and disconnects connections', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'target',
      host: 'example.com',
    });

    const tested = await postJson<{
      ok: boolean;
      platform?: string;
      kimi_path?: string;
      server_running?: boolean;
    }>('/api/v1/ssh/connections/target/test');
    expect(tested.code).toBe(0);
    expect(tested.data).toMatchObject({
      ok: true,
      platform: 'linux-x64',
      kimi_path: '/home/example/.kimi-code/bin/kimi',
      server_running: true,
    });

    const connected = await postJson<{ name: string; state: string; local_origin: string }>(
      '/api/v1/ssh/connections/target/connect',
    );
    expect(connected.code).toBe(0);
    expect(connected.data).toMatchObject({ name: 'target', state: 'on' });
    expect(connected.data.local_origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const statusAfter = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/target',
    );
    const statusBody = (await statusAfter.json()) as Envelope<SshConnectionWire>;
    expect(statusBody.data.status.state).toBe('on');

    const disconnected = await postJson<{ name: string; state: string }>(
      '/api/v1/ssh/connections/target/disconnect',
    );
    expect(disconnected.code).toBe(0);
    expect(disconnected.data).toEqual({ name: 'target', state: 'off' });

    const testMissing = await postJson<null>('/api/v1/ssh/connections/ghost/test');
    expect(testMissing.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
    const connectMissing = await postJson<null>('/api/v1/ssh/connections/ghost/connect');
    expect(connectMissing.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
    const disconnectMissing = await postJson<null>('/api/v1/ssh/connections/ghost/disconnect');
    expect(disconnectMissing.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
  });

  it('maps unreachable remotes to SSH_UNREACHABLE on connect', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'down',
      host: 'example.com',
    });
    fake.setConnectError('down', new SshRemoteError('network', 'connect timed out'));

    const connected = await postJson<null>('/api/v1/ssh/connections/down/connect');
    expect(connected.code).toBe(ErrorCode.SSH_UNREACHABLE);
    expect(connected.msg).toContain('connect timed out');
  });

  it('maps auth failures to SSH_AUTH_REQUIRED and exposes needs_password status', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'locked',
      host: 'example.com',
    });
    fake.setAuthRequired('locked', true);

    const connected = await postJson<null>('/api/v1/ssh/connections/locked/connect');
    expect(connected.code).toBe(ErrorCode.SSH_AUTH_REQUIRED);
    expect(connected.code).not.toBe(ErrorCode.SSH_UNREACHABLE);

    const detail = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/locked',
    );
    const detailBody = (await detail.json()) as Envelope<SshConnectionWire>;
    expect(detailBody.data.status.needs_password).toBe(true);

    const unlocked = await postJson<{ name: string; state: string }>(
      '/api/v1/ssh/connections/locked/password',
      { password: 's3cret' },
    );
    expect(unlocked.code).toBe(0);
    expect(unlocked.data.state).toBe('on');

    const after = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/locked',
    );
    const afterBody = (await after.json()) as Envelope<SshConnectionWire>;
    expect(afterBody.data.status.needs_password).toBeUndefined();
    expect(afterBody.data.has_password).toBe(false);
  });

  it('surfaces needs_password in test results for password-protected connections', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'probe',
      host: 'example.com',
    });
    fake.setAuthRequired('probe', true);

    const tested = await postJson<{ ok: boolean; error?: string; needs_password?: boolean }>(
      '/api/v1/ssh/connections/probe/test',
    );
    expect(tested.code).toBe(0);
    expect(tested.data.ok).toBe(false);
    expect(tested.data.needs_password).toBe(true);

    const testedWithPassword = await postJson<{ ok: boolean }>(
      '/api/v1/ssh/connections/probe/test',
      { password: 's3cret' },
    );
    expect(testedWithPassword.code).toBe(0);
    expect(testedWithPassword.data.ok).toBe(true);
  });

  it('maps host-key-changed failures to SSH_HOST_KEY_CHANGED with structured details', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'rotated',
      host: 'example.com',
    });
    fake.setHostKeyChanged('rotated', {
      host: 'example.com',
      port: 22,
      fingerprint: 'SHA256:new-presented-key',
      keyType: 'ssh-ed25519',
      expectedFingerprint: 'SHA256:old-trusted-key',
      knownHostsFile: '/home/example/.ssh/known_hosts',
      knownHostsLine: 12,
    });

    const connected = await postJson<null>('/api/v1/ssh/connections/rotated/connect');
    expect(connected.code).toBe(ErrorCode.SSH_HOST_KEY_CHANGED);
    expect(connected.code).toBe(40931);
    expect(connected.msg).toContain('has changed');
    expect(connected.details).toEqual({
      host: 'example.com',
      port: 22,
      fingerprint: 'SHA256:new-presented-key',
      key_type: 'ssh-ed25519',
      expected_fingerprint: 'SHA256:old-trusted-key',
      known_hosts_file: '/home/example/.ssh/known_hosts',
      known_hosts_line: 12,
    });

    const tested = await postJson<null>('/api/v1/ssh/connections/rotated/test');
    expect(tested.code).toBe(ErrorCode.SSH_HOST_KEY_CHANGED);
    expect(tested.details).toMatchObject({
      host: 'example.com',
      fingerprint: 'SHA256:new-presented-key',
    });

    const detail = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/rotated',
    );
    const detailBody = (await detail.json()) as Envelope<SshConnectionWire>;
    expect(detailBody.data.status.host_key).toMatchObject({
      host: 'example.com',
      fingerprint: 'SHA256:new-presented-key',
      known_hosts_line: 12,
    });
  });

  it('scans and forgets host keys via the host-key endpoints', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'scanned',
      host: 'example.com',
      port: 2222,
    });

    interface HostKeyScanWire {
      name: string;
      host: string;
      port: number;
      keys: { key_type: string; fingerprint: string }[];
    }

    const scanned = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/scanned/host-key/forget',
    );
    const scannedBody = (await scanned.json()) as Envelope<HostKeyScanWire>;
    expect(scannedBody.code).toBe(0);
    expect(scannedBody.data).toEqual({
      name: 'scanned',
      host: 'example.com',
      port: 2222,
      keys: [{ key_type: 'ssh-ed25519', fingerprint: 'SHA256:fake-scanned-host-key' }],
    });

    fake.setHostKeyScan('scanned', {
      host: 'example.com',
      port: 2222,
      keys: [
        { keyType: 'ssh-ed25519', fingerprint: 'SHA256:ed25519-key' },
        { keyType: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:ecdsa-key' },
      ],
    });
    const rescanned = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/scanned/host-key/forget',
    );
    const rescannedBody = (await rescanned.json()) as Envelope<HostKeyScanWire>;
    expect(rescannedBody.data.keys).toHaveLength(2);

    const forgotten = await postJson<{ name: string; forgotten: boolean }>(
      '/api/v1/ssh/connections/scanned/host-key/forget',
    );
    expect(forgotten.code).toBe(0);
    expect(forgotten.data).toEqual({ name: 'scanned', forgotten: true });
    expect(fake.forgottenHostKeys).toContain('scanned');

    const missingScan = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/ghost/host-key/forget',
    );
    const missingScanBody = (await missingScan.json()) as Envelope<null>;
    expect(missingScanBody.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);

    const missingForget = await postJson<null>('/api/v1/ssh/connections/ghost/host-key/forget');
    expect(missingForget.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
  });

  it('recovers from host-key-changed after forgetting the old key', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'recover',
      host: 'example.com',
    });
    fake.setHostKeyChanged('recover', {
      host: 'example.com',
      port: 22,
      fingerprint: 'SHA256:new-presented-key',
    });

    const blocked = await postJson<null>('/api/v1/ssh/connections/recover/connect');
    expect(blocked.code).toBe(ErrorCode.SSH_HOST_KEY_CHANGED);
    expect(blocked.details).toEqual({
      host: 'example.com',
      port: 22,
      fingerprint: 'SHA256:new-presented-key',
    });

    const forgotten = await postJson<{ name: string; forgotten: boolean }>(
      '/api/v1/ssh/connections/recover/host-key/forget',
    );
    expect(forgotten.code).toBe(0);

    const retried = await postJson<{ name: string; state: string }>(
      '/api/v1/ssh/connections/recover/connect',
    );
    expect(retried.code).toBe(0);
    expect(retried.data.state).toBe('on');
  });

  it('serves the management page with host-key-changed warning affordances', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('40931');
    expect(body).toContain('主机密钥已变更');
    expect(body).toContain('man-in-the-middle attack');
    expect(body).toContain('移除旧密钥并重试');
    expect(body).toContain('/host-key/forget');
    expect(body).toContain('host-key-row');
    expect(body).toContain('新密钥指纹：');
  });

  it('serves the management page with a delete-connection action', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('删除');
    expect(body).toContain('已保存的密码也会一并移除');
  });

  it('never echoes passwords and persists them only with save_password', async () => {
    const rejected = await postJson<null>('/api/v1/ssh/connections', {
      name: 'nopersist',
      host: 'example.com',
      password: 's3cret',
    });
    expect(rejected.code).toBe(ErrorCode.VALIDATION_FAILED);

    const added = await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'nopersist',
      host: 'example.com',
      password: 's3cret',
      save_password: true,
    });
    expect(added.code).toBe(0);
    expect(added.data.has_password).toBe(true);
    expect(JSON.stringify(added.data)).not.toContain('s3cret');

    const listed = await authedFetch(server as RunningServer, base, '/api/v1/ssh/connections');
    const listedBody = (await listed.json()) as Envelope<{ connections: SshConnectionWire[] }>;
    expect(JSON.stringify(listedBody.data)).not.toContain('s3cret');
    const entry = listedBody.data.connections.find((conn) => conn.name === 'nopersist');
    expect(entry?.has_password).toBe(true);
  });

  it('stores, uses, and clears saved passwords via the password endpoints', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'managed',
      host: 'example.com',
    });
    fake.setAuthRequired('managed', true);

    const stored = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/managed/password',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 's3cret' }),
      },
    );
    const storedBody = (await stored.json()) as Envelope<{ name: string; has_password: boolean }>;
    expect(storedBody.code).toBe(0);
    expect(storedBody.data).toEqual({ name: 'managed', has_password: true });
    expect(fake.savedPassword('managed')).toBe('s3cret');

    const connected = await postJson<{ name: string; state: string }>(
      '/api/v1/ssh/connections/managed/connect',
    );
    expect(connected.code).toBe(0);
    expect(connected.data.state).toBe('on');

    const cleared = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/managed/password',
      { method: 'DELETE' },
    );
    const clearedBody = (await cleared.json()) as Envelope<{ name: string; has_password: boolean }>;
    expect(clearedBody.code).toBe(0);
    expect(clearedBody.data).toEqual({ name: 'managed', has_password: false });

    const lockedAgain = await postJson<null>('/api/v1/ssh/connections/managed/connect');
    expect(lockedAgain.code).toBe(ErrorCode.SSH_AUTH_REQUIRED);

    const clearedMissing = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/ghost/password',
      { method: 'DELETE' },
    );
    const clearedMissingBody = (await clearedMissing.json()) as Envelope<null>;
    expect(clearedMissingBody.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);

    const storedMissing = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/ghost/password',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 's3cret' }),
      },
    );
    const storedMissingBody = (await storedMissing.json()) as Envelope<null>;
    expect(storedMissingBody.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
  });

  it('persists a connect-time password only when save_password is true', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'oneoff',
      host: 'example.com',
    });
    fake.setAuthRequired('oneoff', true);

    const transient = await postJson<{ name: string }>(
      '/api/v1/ssh/connections/oneoff/password',
      { password: 's3cret' },
    );
    expect(transient.code).toBe(0);
    expect(fake.savedPassword('oneoff')).toBeUndefined();

    const remembered = await postJson<{ name: string }>(
      '/api/v1/ssh/connections/oneoff/password',
      { password: 's3cret', save_password: true },
    );
    expect(remembered.code).toBe(0);
    expect(fake.savedPassword('oneoff')).toBe('s3cret');
  });

  it('serves the management page with auth-method and password-prompt affordances', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="auth_method"');
    expect(body).toContain('value="identity"');
    expect(body).toContain('value="password"');
    expect(body).toContain('type="password"');
    expect(body).toContain('记住密码');
    expect(body).toContain('secrets.json');
    expect(body).toContain('需要密码');
    expect(body).toContain('/password');
    expect(body).toContain('40130');
  });

  it('serves the management page with remote console file and project sections', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Remote console');
    expect(body).toContain('console-select');
    expect(body).toContain('files-rows');
    expect(body).toContain('files-upload-input');
    expect(body).toContain('新建文件夹');
    expect(body).toContain('projects-rows');
    expect(body).toContain('/fs:home');
    expect(body).toContain('/fs:list');
    expect(body).toContain('/fs:mkdir');
    expect(body).toContain('/fs:content');
    expect(body).toContain('/workspaces');
    expect(body).toContain('kimi_origin');
  });

  it('serves the management page in the dark web-ui style with a dismissible banner', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('color-scheme: dark');
    expect(body).toContain('SSH 连接');
    expect(body).toContain('添加连接');
    expect(body).toContain('连接列表');
    expect(body).toContain('message-close');
  });

  it('serves the management page with a content-type header only when a body is present', async () => {
    const res = await authedFetch(server as RunningServer, base, '/ssh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('} else if (options && options.body !== undefined) {');
    expect(body).not.toContain('body: {}');
  });

  it('accepts bodyless mutating requests and rejects empty JSON bodies', async () => {
    await postJson<SshConnectionWire>('/api/v1/ssh/connections', {
      name: 'bodyless',
      host: 'example.com',
    });

    for (const action of ['test', 'connect', 'disconnect', 'host-key/forget']) {
      const res = await authedFetch(
        server as RunningServer,
        base,
        `/api/v1/ssh/connections/bodyless/${action}`,
        { method: 'POST' },
      );
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as Envelope<unknown>;
      expect(envelope.code).toBe(0);
    }

    const emptyJson = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/bodyless/test',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    );
    const emptyJsonBody = (await emptyJson.json()) as Envelope<null>;
    expect(emptyJsonBody.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(emptyJsonBody.msg).toContain('Body cannot be empty');

    const cleared = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/bodyless/password',
      { method: 'DELETE' },
    );
    expect(cleared.status).toBe(200);

    const removed = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/bodyless',
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
  });
});

describe('server-v2 /ssh remote console end-to-end', () => {
  let homeLocal: string | undefined;
  let homeRemote: string | undefined;
  let localServer: RunningServer | undefined;
  let remoteServer: RunningServer | undefined;
  let base: string;

  beforeAll(async () => {
    homeRemote = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-e2e-remote-'));
    remoteServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: homeRemote,
      logLevel: 'silent',
    });
    const remoteOrigin = `http://127.0.0.1:${remoteServer.port}`;
    const remoteToken = remoteServer.authTokenService.getToken();
    const fake = fakeSshConnectionManager({
      handleFor: () => ({ localOrigin: remoteOrigin, remoteToken }),
    });
    homeLocal = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-e2e-local-'));
    localServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: homeLocal,
      logLevel: 'silent',
      sshConnectionManager: fake,
    });
    base = `http://127.0.0.1:${localServer.port}`;
  });

  afterAll(async () => {
    if (localServer !== undefined) await localServer.close();
    if (remoteServer !== undefined) await remoteServer.close();
    if (homeLocal !== undefined) await rm(homeLocal, { recursive: true, force: true });
    if (homeRemote !== undefined) await rm(homeRemote, { recursive: true, force: true });
  });

  it('browses remote files through the proxy: home, list, mkdir, upload, download', async () => {
    const added = await postJsonVia(
      '/api/v1/ssh/connections',
      { name: 'e2e', host: 'example.com' },
    );
    expect(added.code).toBe(0);

    const connected = await postJsonVia('/api/v1/ssh/connections/e2e/connect');
    expect(connected.code).toBe(0);

    const homeRes = await authedFetch(localServer as RunningServer, base, '/ssh/e2e/api/v1/fs:home');
    const home = (await homeRes.json()) as Envelope<{ home: string }>;
    expect(home.code).toBe(0);
    expect(typeof home.data.home).toBe('string');

    const listedRes = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:list?path=${encodeURIComponent(homeRemote as string)}`,
    );
    const listed = (await listedRes.json()) as Envelope<{
      path: string;
      parent: string | null;
      entries: { name: string; is_dir: boolean }[];
    }>;
    expect(listed.code).toBe(0);
    expect(Array.isArray(listed.data.entries)).toBe(true);

    const made = await postJsonVia('/ssh/e2e/api/v1/fs:mkdir', {
      path: join(homeRemote as string, 'e2e-folder'),
    });
    expect(made.code).toBe(0);

    const uploaded = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:content?path=${encodeURIComponent(join(homeRemote as string, 'e2e-folder', 'hello.txt'))}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'hello ssh e2e',
      },
    );
    const uploadedBody = (await uploaded.json()) as Envelope<unknown>;
    expect(uploadedBody.code).toBe(0);

    const downloaded = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:content?path=${encodeURIComponent(join(homeRemote as string, 'e2e-folder', 'hello.txt'))}`,
    );
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('hello ssh e2e');

    const relistedRes = await authedFetch(
      localServer as RunningServer,
      base,
      `/ssh/e2e/api/v1/fs:list?path=${encodeURIComponent(join(homeRemote as string, 'e2e-folder'))}`,
    );
    const relisted = (await relistedRes.json()) as Envelope<{
      parent: string | null;
      entries: { name: string; is_dir: boolean }[];
    }>;
    expect(relisted.code).toBe(0);
    expect(relisted.data.parent).toBe(await realpath(homeRemote as string));
    expect(
      relisted.data.entries.some((entry) => entry.name === 'hello.txt' && !entry.is_dir),
    ).toBe(true);
  });

  it('lists and creates remote projects through the proxy', async () => {
    const created = await postJsonVia('/ssh/e2e/api/v1/workspaces', {
      root: homeRemote as string,
      name: 'e2e-ws',
    });
    expect(created.code).toBe(0);

    const res = await authedFetch(localServer as RunningServer, base, '/ssh/e2e/api/v1/workspaces');
    const body = (await res.json()) as Envelope<{
      items: { name: string; root: string; session_count: number }[];
    }>;
    expect(body.code).toBe(0);
    const ws = body.data.items.find((item) => item.name === 'e2e-ws');
    expect(ws?.root).toBe(homeRemote);
    expect(typeof ws?.session_count).toBe('number');
  });

  it('supports bodyless disconnect, host-key forget, password delete, and delete', async () => {
    const disconnected = await postJsonVia('/api/v1/ssh/connections/e2e/disconnect');
    expect(disconnected.code).toBe(0);

    const forgotten = await postJsonVia('/api/v1/ssh/connections/e2e/host-key/forget');
    expect(forgotten.code).toBe(0);

    const cleared = await authedFetch(
      localServer as RunningServer,
      base,
      '/api/v1/ssh/connections/e2e/password',
      { method: 'DELETE' },
    );
    const clearedBody = (await cleared.json()) as Envelope<unknown>;
    expect(clearedBody.code).toBe(0);

    const removed = await authedFetch(
      localServer as RunningServer,
      base,
      '/api/v1/ssh/connections/e2e',
      { method: 'DELETE' },
    );
    const removedBody = (await removed.json()) as Envelope<{ name: string }>;
    expect(removedBody.code).toBe(0);
    expect(removedBody.data).toEqual({ name: 'e2e' });

    const after = await authedFetch(localServer as RunningServer, base, '/api/v1/ssh/connections/e2e');
    const afterBody = (await after.json()) as Envelope<null>;
    expect(afterBody.code).toBe(ErrorCode.SSH_CONNECTION_NOT_FOUND);
  });

  async function postJsonVia(path: string, body?: unknown): Promise<Envelope<never>> {
    const res = await authedFetch(localServer as RunningServer, base, path, {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<never>;
  }
});

describe('server-v2 /api/v1/ssh/connections write gate', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ssh-gate-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '0.0.0.0',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      bindClass: 'lan',
      insecureNoTls: true,
      sshConnectionManager: fakeSshConnectionManager(),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('keeps read routes and registry writes available on non-loopback binds', async () => {
    const listed = await authedFetch(server as RunningServer, base, '/api/v1/ssh/connections');
    expect(listed.status).toBe(200);

    const added = await authedFetch(server as RunningServer, base, '/api/v1/ssh/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lanbox', host: 'example.com' }),
    });
    expect(added.status).toBe(200);

    const detail = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/lanbox',
    );
    expect(detail.status).toBe(200);
  });

  it('returns 404 for test/connect/disconnect and password submission on non-loopback binds', async () => {
    for (const action of ['test', 'connect', 'disconnect', 'password']) {
      const res = await authedFetch(
        server as RunningServer,
        base,
        `/api/v1/ssh/connections/lanbox/${action}`,
        { method: 'POST' },
      );
      expect(res.status).toBe(404);
    }
  });

  it('returns 404 for host-key scan and forget on non-loopback binds', async () => {
    const scanned = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/lanbox/host-key/forget',
    );
    expect(scanned.status).toBe(404);

    const forgotten = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/lanbox/host-key/forget',
      { method: 'POST' },
    );
    expect(forgotten.status).toBe(404);
  });

  it('keeps password store and clear available on non-loopback binds', async () => {
    const stored = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/lanbox/password',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 's3cret' }),
      },
    );
    expect(stored.status).toBe(200);

    const cleared = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/ssh/connections/lanbox/password',
      { method: 'DELETE' },
    );
    expect(cleared.status).toBe(200);
  });
});
