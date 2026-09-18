import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSshPageRoute } from '../src/routes/sshPage';
import { registerWebAssetRoutes } from '../src/routes/webAssets';

const INDEX_HTML = '<!doctype html><html><body><main>Kimi</main></body></html>';

describe('web asset cache policy', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await mkdir(join(assetsDir, 'assets'));
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>'),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};'),
      writeFile(join(assetsDir, 'assets', 'application-configuration.json'), '{}'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
    ]);
    app = Fastify();
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('caches content-hashed assets as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each([
    '/index.html',
    '/sessions/active',
    '/favicon.svg',
    '/assets/application-configuration.json',
  ])(
    'requires revalidation for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    },
  );
});

describe('ssh entry injection', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await mkdir(join(assetsDir, 'assets'));
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), INDEX_HTML),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
    ]);
    app = Fastify();
    registerSshPageRoute(app);
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('injects the ssh entry with token pass-through into index.html', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('kimi-ssh-entry');
    expect(response.body).toContain("entry.textContent = 'SSH'");
    expect(response.body).toContain("new URLSearchParams(location.hash.replace(/^#/, '')).get('token')");
    expect(response.body).toContain("'/ssh#token='");
    expect(response.body).not.toContain('innerHTML');
    expect(response.body.indexOf('</body>')).toBeGreaterThan(response.body.indexOf('kimi-ssh-entry'));
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('injects the ssh entry into the SPA fallback', async () => {
    const response = await app.inject({ method: 'GET', url: '/sessions/active' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('kimi-ssh-entry');
  });

  it('returns index.html unchanged when the body marker is missing', async () => {
    const markerless = '<!doctype html><html><main>Kimi</main></html>';
    await writeFile(join(assetsDir, 'index.html'), markerless);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(markerless);
  });

  it('does not inject twice when the entry marker is already present', async () => {
    const preInjected = INDEX_HTML.replace('</body>', '<div id="kimi-ssh-entry"></div></body>');
    await writeFile(join(assetsDir, 'index.html'), preInjected);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(preInjected);
  });

  it('leaves other assets untouched', async () => {
    const script = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });
    const favicon = await app.inject({ method: 'GET', url: '/favicon.svg' });

    expect(script.statusCode).toBe(200);
    expect(script.body).toBe('export {};');
    expect(favicon.statusCode).toBe(200);
    expect(favicon.body).toBe('<svg></svg>');
  });

  it('does not inject into the /ssh page itself', async () => {
    const response = await app.inject({ method: 'GET', url: '/ssh' });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('kimi-ssh-entry');
  });
});
