/**
 * Host-key helpers for `kimi ssh`: detecting the host-key-changed failure
 * across the local manager and the REST backend, and recovering the two
 * fingerprints the user must compare — the stored one (from the offending
 * known_hosts line) and the presented one (from the ssh stderr, or a fresh
 * `ssh-keyscan` when the stderr is unavailable).
 */

import { createHash } from 'node:crypto';

import { SshRemoteError } from '@moonshot-ai/ssh-remote';

import {
  SSH_HOST_KEY_CHANGED_CODE,
  SshApiError,
  type SshScannedHostKey,
} from './client';

/** One host key reduced to what the user compares: algorithm + fingerprint. */
export interface HostKeyFingerprint {
  keyType: string;
  fingerprint: string;
}

/** Where the stale key lives in known_hosts (parsed from the ssh stderr). */
export interface OffendingHostKey {
  file: string;
  line: number;
}

export interface HostKeyChangedDetails {
  presented?: HostKeyFingerprint;
  offending?: OffendingHostKey;
}

/** Unified host-key-changed detection across the REST and local backends. */
export function isHostKeyChangedError(error: unknown): boolean {
  if (error instanceof SshApiError) return error.code === SSH_HOST_KEY_CHANGED_CODE;
  return (
    error instanceof SshRemoteError &&
    (error.kind as string) === 'host-key-changed'
  );
}

/**
 * Pull the presented fingerprint and the offending known_hosts location out
 * of a host-key-changed failure. Local errors carry the ssh stderr (parsed
 * here) and the offending location; REST errors carry whatever the server
 * parsed into the envelope data. Missing pieces are left undefined — callers
 * degrade or re-scan instead of failing.
 */
export function extractHostKeyChangedDetails(error: unknown): HostKeyChangedDetails {
  if (error instanceof SshApiError) {
    const data = error.data as
      | {
          host_key?: { key_type?: string; fingerprint?: string };
          offending?: { file?: string; line?: number };
        }
      | undefined;
    const presented =
      typeof data?.host_key?.fingerprint === 'string'
        ? { keyType: data.host_key.key_type ?? 'unknown', fingerprint: data.host_key.fingerprint }
        : undefined;
    const offending =
      typeof data?.offending?.file === 'string' && typeof data.offending.line === 'number'
        ? { file: data.offending.file, line: data.offending.line }
        : undefined;
    return { presented, offending };
  }
  if (error instanceof SshRemoteError) {
    const offending = (
      error as SshRemoteError & { offendingHostKey?: OffendingHostKey }
    ).offendingHostKey;
    return {
      presented: parsePresentedHostKey(error.stderr ?? ''),
      offending,
    };
  }
  return {};
}

/**
 * The fingerprint ssh itself prints on a changed-key refusal:
 * `The fingerprint for the ED25519 key sent by the remote host is SHA256:….`
 */
export function parsePresentedHostKey(stderr: string): HostKeyFingerprint | undefined {
  const match =
    /The fingerprint for the (\S+) key sent by the remote host is\s*(SHA256:[A-Za-z0-9+/=]+)/.exec(
      stderr,
    );
  if (match === null) return undefined;
  return { keyType: match[1] ?? 'unknown', fingerprint: match[2] ?? '' };
}

/**
 * Recompute the stored fingerprint from a known_hosts file: the offending
 * line holds the base64 key blob, whose SHA256 (base64, padding stripped) is
 * exactly the `SHA256:…` fingerprint `ssh-keygen -l` prints. Best-effort —
 * returns undefined for unreadable or malformed lines.
 */
export function storedHostKeyFingerprint(
  knownHostsContent: string,
  line: number,
): HostKeyFingerprint | undefined {
  const row = knownHostsContent.split('\n')[line - 1]?.trim();
  if (row === undefined || row.length === 0 || row.startsWith('#')) return undefined;
  const fields = row.split(/\s+/);
  const blobIndex = fields.findIndex((field) => field.startsWith('AAAA'));
  if (blobIndex < 1) return undefined;
  try {
    const digest = createHash('sha256')
      .update(Buffer.from(fields[blobIndex] ?? '', 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
    return { keyType: fields[blobIndex - 1] ?? 'unknown', fingerprint: `SHA256:${digest}` };
  } catch {
    return undefined;
  }
}

/** The target `ssh-keygen -R` expects: bare host on port 22, `[host]:port` otherwise. */
export function knownHostsRemoveTarget(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Pick the key a warning should show when a scan returned several. */
export function primaryScannedKey(
  keys: readonly SshScannedHostKey[],
): HostKeyFingerprint | undefined {
  const first = keys[0];
  return first === undefined
    ? undefined
    : { keyType: first.keyType, fingerprint: first.fingerprint };
}
