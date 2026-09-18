/**
 * Host-key helpers for `kimi ssh`: detecting the host-key-changed failure
 * across the local manager and the REST backend, and normalizing the two
 * fingerprints the user must compare — the stored one (already recovered
 * from the offending known_hosts line by the backend) and the one the
 * remote presents now.
 */

import { SshRemoteError } from '@moonshot-ai/ssh-remote';

import {
  SSH_HOST_KEY_CHANGED_CODE,
  SshApiError,
  type SshHostKeyDetailsShape,
  type SshHostKeyScan,
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
  storedFingerprint?: string;
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

/** Wire shape of the 40931 envelope `details` (all fields best-effort). */
interface HostKeyChangedWireDetails {
  fingerprint?: string;
  key_type?: string;
  expected_fingerprint?: string;
  known_hosts_file?: string;
  known_hosts_line?: number;
}

/**
 * Pull the comparison data out of a thrown host-key-changed failure. Local
 * errors carry `hostKey`; REST errors carry the envelope `details`. Missing
 * pieces stay undefined — callers degrade or re-scan instead of failing.
 */
export function extractHostKeyChangedDetails(error: unknown): HostKeyChangedDetails {
  if (error instanceof SshApiError) {
    const details = error.details as HostKeyChangedWireDetails | undefined;
    return {
      presented:
        typeof details?.fingerprint === 'string'
          ? { keyType: details.key_type ?? 'unknown', fingerprint: details.fingerprint }
          : undefined,
      storedFingerprint:
        typeof details?.expected_fingerprint === 'string'
          ? details.expected_fingerprint
          : undefined,
      offending: offendingLocation(details?.known_hosts_file, details?.known_hosts_line),
    };
  }
  if (error instanceof SshRemoteError) {
    const hostKey = (error as SshRemoteError & { hostKey?: SshHostKeyDetailsShape }).hostKey;
    return hostKey === undefined ? {} : detailsFromHostKey(hostKey);
  }
  return {};
}

/**
 * The local manager's `test()` folds failures into the result instead of
 * throwing, so the host-key-changed case arrives as `{ ok: false, hostKey }`.
 * Returns undefined for every other failure kind.
 */
export function hostKeyChangedFromTestResult(result: {
  ok: boolean;
  hostKey?: SshHostKeyDetailsShape;
}): HostKeyChangedDetails | undefined {
  if (result.ok || result.hostKey === undefined) return undefined;
  return detailsFromHostKey(result.hostKey);
}

function detailsFromHostKey(hostKey: SshHostKeyDetailsShape): HostKeyChangedDetails {
  return {
    presented:
      hostKey.fingerprint === undefined
        ? undefined
        : { keyType: hostKey.keyType ?? 'unknown', fingerprint: hostKey.fingerprint },
    storedFingerprint: hostKey.expectedFingerprint,
    offending: offendingLocation(hostKey.knownHostsFile, hostKey.knownHostsLine),
  };
}

function offendingLocation(file: unknown, line: unknown): OffendingHostKey | undefined {
  return typeof file === 'string' && typeof line === 'number' ? { file, line } : undefined;
}

/** The target `ssh-keygen -R` expects: bare host on port 22, `[host]:port` otherwise. */
export function knownHostsRemoveTarget(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Pick the key a warning should show when a scan returned several. */
export function primaryScannedKey(scan: SshHostKeyScan): HostKeyFingerprint | undefined {
  const first = scan.keys[0];
  return first === undefined
    ? undefined
    : { keyType: first.keyType, fingerprint: first.fingerprint };
}
