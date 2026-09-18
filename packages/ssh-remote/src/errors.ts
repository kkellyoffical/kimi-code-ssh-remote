export type SshErrorKind =
  | 'auth'
  | 'host-key-changed'
  | 'host-unreachable'
  | 'network'
  | 'remote-missing-binary'
  | 'local-missing-binary'
  | 'config'
  | 'unknown';

export interface SshHostKeyDetails {
  readonly host: string;
  readonly port: number;
  readonly fingerprint?: string;
  readonly keyType?: string;
  readonly expectedFingerprint?: string;
  readonly knownHostsFile?: string;
  readonly knownHostsLine?: number;
}

export class SshRemoteError extends Error {
  constructor(
    readonly kind: SshErrorKind,
    message: string,
    options?: {
      stderr?: string;
      cause?: unknown;
      needsPassword?: boolean;
      hostKey?: SshHostKeyDetails;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'SshRemoteError';
    this.stderr = options?.stderr;
    this.needsPassword = options?.needsPassword ?? false;
    this.hostKey = options?.hostKey;
  }

  readonly stderr?: string;
  readonly needsPassword: boolean;
  readonly hostKey?: SshHostKeyDetails;
}

export function isNeedsPasswordError(error: unknown): boolean {
  return error instanceof SshRemoteError && error.needsPassword;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
