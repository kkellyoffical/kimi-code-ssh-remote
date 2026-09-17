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
    options?: { stderr?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'SshRemoteError';
    this.stderr = options?.stderr;
  }

  readonly stderr?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
