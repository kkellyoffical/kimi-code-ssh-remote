export type SshErrorKind =
  | 'auth'
  | 'host-unreachable'
  | 'network'
  | 'remote-missing-binary'
  | 'local-missing-binary'
  | 'config'
  | 'unknown';

export class SshRemoteError extends Error {
  constructor(
    readonly kind: SshErrorKind,
    message: string,
    options?: { stderr?: string; cause?: unknown; needsPassword?: boolean },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'SshRemoteError';
    this.stderr = options?.stderr;
    this.needsPassword = options?.needsPassword ?? false;
  }

  readonly stderr?: string;
  readonly needsPassword: boolean;
}

export function isNeedsPasswordError(error: unknown): boolean {
  return error instanceof SshRemoteError && error.needsPassword;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
