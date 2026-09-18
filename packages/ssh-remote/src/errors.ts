export type SshErrorKind =
  | 'auth'
  | 'host-key-changed'
  | 'host-unreachable'
  | 'network'
  | 'remote-missing-binary'
  | 'local-missing-binary'
  | 'config'
  | 'unknown';

export interface OffendingHostKey {
  readonly file: string;
  readonly line: number;
}

export class SshRemoteError extends Error {
  constructor(
    readonly kind: SshErrorKind,
    message: string,
    options?: {
      stderr?: string;
      cause?: unknown;
      needsPassword?: boolean;
      offendingHostKey?: OffendingHostKey;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'SshRemoteError';
    this.stderr = options?.stderr;
    this.needsPassword = options?.needsPassword ?? false;
    this.offendingHostKey = options?.offendingHostKey;
  }

  readonly stderr?: string;
  readonly needsPassword: boolean;
  readonly offendingHostKey?: OffendingHostKey;
}

export function isNeedsPasswordError(error: unknown): boolean {
  return error instanceof SshRemoteError && error.needsPassword;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
