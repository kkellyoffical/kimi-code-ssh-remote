import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface BrowseEntryWire {
  name: string;
  path: string;
  is_dir: true;
}

interface BrowseWire {
  path: string;
  parent: string | null;
  entries: BrowseEntryWire[];
}

interface HomeWire {
  home: string;
  recent_roots: string[];
}

describe('server-v2 /api/v1 fs folder picker', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true });
      instancesDir = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('defaults browse to $HOME when path is omitted', async () => {
    const { status, body } = await getJson<BrowseWire>('/api/v1/fs:browse');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(homedir()));
    expect(typeof body.data.parent === 'string' || body.data.parent === null).toBe(true);
    expect(Array.isArray(body.data.entries)).toBe(true);
  });

  it('does not serve the double-colon URL (v1 parity: only /fs:browse is valid)', async () => {
    const res = await fetch(`${base}/api/v1/fs::browse`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });

  it('lists only directories and filters files', async () => {
    const root = await mkdtemp(join(home as string, 'browse-filter-'));
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'README.md'), 'hi');

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    const names = body.data.entries.map((e) => e.name).toSorted();
    expect(names).toEqual(['alpha', 'beta']);
    for (const entry of body.data.entries) {
      expect(entry.is_dir).toBe(true);
      expect(entry.path).toBe(join(await realpath(root), entry.name));
    }
  });

  it('sorts dot-directories after regular ones', async () => {
    const root = await mkdtemp(join(home as string, 'browse-dots-'));
    await mkdir(join(root, '.zeta'));
    await mkdir(join(root, 'alpha'));

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((e) => e.name)).toEqual(['alpha', '.zeta']);
  });

  it('returns parent=null for the filesystem root', async () => {
    const { body } = await getJson<BrowseWire>('/api/v1/fs:browse?path=%2F');
    expect(body.code).toBe(0);
    expect(body.data.path).toBe('/');
    expect(body.data.parent).toBeNull();
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await getJson<null>(
      `/api/v1/fs:browse?path=${encodeURIComponent('relative/path')}`,
    );
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const missing = join(home as string, 'does-not-exist');
    const { body } = await getJson<null>(`/api/v1/fs:browse?path=${encodeURIComponent(missing)}`);
    expect(body.code).toBe(40409);
  });

  it('returns an empty recent_roots when no workspaces are registered', async () => {
    const { status, body } = await getJson<HomeWire>('/api/v1/fs:home');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.home).toBe(homedir());
    expect(body.data.recent_roots).toEqual([]);
  });

  it('reflects registered workspace roots in recent_roots', async () => {
    const root = home as string;
    const created = await postJson<{ id: string }>('/api/v1/workspaces', { root });
    expect(created.body.code).toBe(0);

    const { body } = await getJson<HomeWire>('/api/v1/fs:home');
    expect(body.code).toBe(0);
    expect(body.data.recent_roots).toContain(root);
  });
});

describe('server-v2 /api/v1 fs:mkdir', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsmkdir-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsmkdir-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true });
      instancesDir = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('creates a directory that fs:browse then lists', async () => {
    const target = join(dir as string, 'fresh-folder');

    const { status, body } = await postJson<{ path: string }>('/api/v1/fs:mkdir', {
      path: target,
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(target);

    const browse = await fetch(
      `${base}/api/v1/fs:browse?path=${encodeURIComponent(dir as string)}`,
      { headers: authHeaders(server as RunningServer) } as never,
    );
    const browseBody = (await browse.json()) as Envelope<BrowseWire>;
    expect(browseBody.data.entries.map((e) => e.name)).toContain('fresh-folder');
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: 'relative/folder' });
    expect(body.code).toBe(40001);
  });

  it('rejects an existing directory (40919)', async () => {
    const target = join(dir as string, 'already-here');
    await mkdir(target);

    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: target });
    expect(body.code).toBe(40919);
  });

  it('rejects an existing file (40919)', async () => {
    const target = join(dir as string, 'file.txt');
    await writeFile(target, 'hi');

    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: target });
    expect(body.code).toBe(40919);
  });

  it('rejects a missing parent (40409)', async () => {
    const target = join(dir as string, 'no-such-parent', 'child');
    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: target });
    expect(body.code).toBe(40409);
  });

  it('does not serve the double-colon URL', async () => {
    const res = await fetch(`${base}/api/v1/fs::mkdir`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ path: join(dir as string, 'x') }),
    } as never);
    expect(res.status).toBe(404);
  });
});

describe('server-v2 /api/v1 fs:content', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true });
      instancesDir = undefined;
    }
  });

  function contentUrl(path: string): string {
    return `${base}/api/v1/fs:content?path=${encodeURIComponent(path)}`;
  }

  async function getContent(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(contentUrl(path), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer), ...headers },
    } as never);
  }

  it('serves a text file raw with mime, etag, and length headers', async () => {
    const file = join(dir as string, 'hello.md');
    await writeFile(file, '# hi\n');

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-length')).toBe('5');
    expect(typeof res.headers.get('etag')).toBe('string');
    expect(typeof res.headers.get('last-modified')).toBe('string');
    expect(await res.text()).toBe('# hi\n');
  });

  it('serves an unknown-extension text file as text/plain', async () => {
    const file = join(dir as string, 'notes.weird');
    await writeFile(file, 'just text');

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('serves a UTF-8 Chinese .log file as text/plain', async () => {
    const file = join(dir as string, 'server.log');
    const log = '2026-08-16 INFO 启动完成 ✅\n'.repeat(100);
    await writeFile(file, log);

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(log);
  });

  it('serves binary files byte-for-byte with an octet-stream fallback mime', async () => {
    const file = join(dir as string, 'blob.bin');
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x80]);
    await writeFile(file, original);

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
  });

  it('guesses image mime from the extension', async () => {
    const file = join(dir as string, 'pic.png');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
  });

  it('answers If-None-Match with 304 when the etag matches', async () => {
    const file = join(dir as string, 'cached.txt');
    await writeFile(file, 'cache me');

    const first = await getContent(file);
    const etag = first.headers.get('etag') as string;

    const res = await getContent(file, { 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(await res.text()).toBe('');
  });

  it('honors single-range requests with 206', async () => {
    const file = join(dir as string, 'long.txt');
    await writeFile(file, '0123456789');

    const res = await getContent(file, { range: 'bytes=2-5' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('rejects a relative path (40001)', async () => {
    const res = await getContent('relative/path.txt');
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const res = await getContent(join(dir as string, 'does-not-exist.txt'));
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40409);
  });

  it('rejects a directory path (40906)', async () => {
    const res = await getContent(dir as string);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40906);
  });

  it.skipIf(process.platform === 'win32')('rejects non-regular files (40001)', async () => {
    const res = await getContent('/dev/null');
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('does not serve the double-colon URL', async () => {
    const res = await fetch(`${base}/api/v1/fs::content?path=%2Ftmp`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });
});

describe('server-v2 /api/v1 fs:list', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fslist-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fslist-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    if (instancesDir !== undefined) await rm(instancesDir, { recursive: true, force: true });
  });

  interface ListEntryWire {
    name: string;
    path: string;
    is_dir: boolean;
    size?: number;
    modified_at?: string;
  }

  interface ListWire {
    path: string;
    parent: string | null;
    entries: ListEntryWire[];
  }

  async function getList(path: string): Promise<Envelope<ListWire>> {
    const res = await fetch(`${base}/api/v1/fs:list?path=${encodeURIComponent(path)}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<ListWire>;
  }

  it('lists files and directories with metadata, directories first', async () => {
    const root = await mkdtemp(join(dir as string, 'list-'));
    await mkdir(join(root, 'subdir'));
    await mkdir(join(root, '.hiddendir'));
    await writeFile(join(root, 'notes.txt'), 'hello');

    const body = await getList(root);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    expect(body.data.parent).toBe(await realpath(dir as string));
    const names = body.data.entries.map((entry) => entry.name);
    expect(names).toEqual(['subdir', '.hiddendir', 'notes.txt']);
    const file = body.data.entries.find((entry) => entry.name === 'notes.txt');
    expect(file?.is_dir).toBe(false);
    expect(file?.size).toBe(5);
    expect(typeof file?.modified_at).toBe('string');
    const subdir = body.data.entries.find((entry) => entry.name === 'subdir');
    expect(subdir?.is_dir).toBe(true);
    expect(subdir?.path).toBe(join(await realpath(root), 'subdir'));
  });

  it('rejects a relative path (40001)', async () => {
    const body = await getList('relative/path');
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const body = await getList(join(dir as string, 'does-not-exist'));
    expect(body.code).toBe(40409);
  });

  it('rejects a regular file path (40001)', async () => {
    const file = join(dir as string, 'plain.txt');
    await writeFile(file, 'hi');
    const body = await getList(file);
    expect(body.code).toBe(40001);
  });
});

describe('server-v2 /api/v1 fs:content write (PUT)', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fswrite-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fswrite-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    if (instancesDir !== undefined) await rm(instancesDir, { recursive: true, force: true });
  });

  async function putContent(path: string, body: Buffer): Promise<Response> {
    return fetch(`${base}/api/v1/fs:content?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/octet-stream',
      }),
      body: new Uint8Array(body),
    } as never);
  }

  it('writes a new file byte-for-byte and serves it back', async () => {
    const target = join(dir as string, 'upload.bin');
    const payload = Buffer.from([0x00, 0x89, 0xff, 0x10, 0x7f, 0x00, 0x42]);

    const res = await putContent(target, payload);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{ path: string; size: number }>;
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ path: await realpath(dir as string).then((d) => join(d, 'upload.bin')), size: payload.length });

    const readBack = await fetch(
      `${base}/api/v1/fs:content?path=${encodeURIComponent(target)}`,
      { headers: authHeaders(server as RunningServer) } as never,
    );
    expect(readBack.status).toBe(200);
    expect(Buffer.from(await readBack.arrayBuffer()).equals(payload)).toBe(true);
  });

  it('overwrites an existing file', async () => {
    const target = join(dir as string, 'overwrite.txt');
    await writeFile(target, 'old content');

    const res = await putContent(target, Buffer.from('new content'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{ path: string; size: number }>;
    expect(body.code).toBe(0);
    expect(body.data.size).toBe(11);

    expect(await readFile(target, 'utf8')).toBe('new content');
  });

  it('rejects a relative path (40001)', async () => {
    const res = await putContent('relative/file.txt', Buffer.from('x'));
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('rejects a missing parent directory (40409)', async () => {
    const res = await putContent(join(dir as string, 'no-such-dir', 'file.txt'), Buffer.from('x'));
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40409);
  });

  it('rejects a directory target (40906)', async () => {
    const res = await putContent(dir as string, Buffer.from('x'));
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40906);
  });

  it('rejects bodies over the 10 MiB limit (41302)', async () => {
    const res = await putContent(
      join(dir as string, 'too-large.bin'),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(41302);
  });

  it.skipIf(process.platform === 'win32')('rejects writes into a read-only directory (40411)', async () => {
    const locked = join(dir as string, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o555);
    try {
      const res = await putContent(join(locked, 'file.txt'), Buffer.from('x'));
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(40411);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
