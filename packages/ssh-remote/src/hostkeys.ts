import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SshRemoteError } from './errors';
import { DEFAULT_SSH_PORT, type SshConnectionProfile } from './profile';
import type { ProcessRunner } from './runner';

export interface ScannedHostKey {
  readonly keyType: string;
  readonly fingerprint: string;
}

export interface SshHostKeyScan {
  readonly host: string;
  readonly port: number;
  readonly keys: readonly ScannedHostKey[];
}

const SCAN_TIMEOUT_SECONDS = 10;

export function knownHostsTarget(host: string, port: number): string {
  return port === DEFAULT_SSH_PORT ? host : `[${host}]:${port}`;
}

export function parseHostKeyScan(stdout: string): ScannedHostKey[] {
  const keys: ScannedHostKey[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    const typeIndex = fields.findIndex((field) => isKeyTypeField(field));
    const blob = typeIndex >= 0 ? fields[typeIndex + 1] : undefined;
    if (typeIndex < 0 || blob === undefined) continue;
    keys.push({ keyType: fields[typeIndex] ?? '', fingerprint: fingerprintOf(blob) });
  }
  return keys;
}

export async function readStoredHostKeyFingerprint(
  knownHostsFile: string,
  line: number,
): Promise<string | undefined> {
  try {
    const content = await readFile(knownHostsFile, 'utf8');
    const entry = content.split('\n')[line - 1]?.trim();
    if (entry === undefined || entry.length === 0 || entry.startsWith('#')) return undefined;
    const fields = entry.split(/\s+/);
    const typeIndex = fields.findIndex((field) => isKeyTypeField(field));
    const blob = typeIndex >= 0 ? fields[typeIndex + 1] : undefined;
    if (typeIndex < 0 || blob === undefined) return undefined;
    return fingerprintOf(blob);
  } catch {
    return undefined;
  }
}

export async function scanRemoteHostKey(
  profile: SshConnectionProfile,
  runner: ProcessRunner,
): Promise<SshHostKeyScan> {
  const target = knownHostsTarget(profile.host, profile.port);
  const result = await runner.run(
    ['ssh-keyscan', '-T', String(SCAN_TIMEOUT_SECONDS), '-p', String(profile.port), profile.host],
    { timeoutMs: (SCAN_TIMEOUT_SECONDS + 5) * 1000 },
  );
  const keys = parseHostKeyScan(result.stdout);
  if (result.code !== 0 || keys.length === 0) {
    const detail = result.stderr.trim();
    throw new SshRemoteError(
      'host-unreachable',
      `cannot scan host key for ${target}${detail.length > 0 ? `: ${detail}` : ''}`,
      { stderr: result.stderr },
    );
  }
  return { host: profile.host, port: profile.port, keys };
}

export async function forgetRemoteHostKey(
  profile: SshConnectionProfile,
  runner: ProcessRunner,
): Promise<void> {
  const target = knownHostsTarget(profile.host, profile.port);
  const result = await runner.run(['ssh-keygen', '-R', target], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new SshRemoteError(
      'unknown',
      `cannot remove stored host key for ${target}${detail.length > 0 ? `: ${detail}` : ''}`,
      { stderr: result.stderr },
    );
  }
}

function isKeyTypeField(field: string): boolean {
  return /^(ssh-|ecdsa-|sk-)/.test(field);
}

function fingerprintOf(blob: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(blob, 'base64'))
    .digest('base64')
    .replace(/=+$/, '');
  return `SHA256:${digest}`;
}
