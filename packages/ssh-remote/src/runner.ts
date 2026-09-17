import { execFile, spawn } from 'node:child_process';

import { SshRemoteError } from './errors';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
}

export interface SpawnedProcess {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

export interface SpawnOptions {
  readonly onStderr?: (chunk: string) => void;
  readonly onStdout?: (chunk: string) => void;
}

export interface ProcessRunner {
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>;
  spawn(argv: readonly string[], options?: SpawnOptions): SpawnedProcess;
}

export function createSystemProcessRunner(): ProcessRunner {
  return {
    run(argv, options = {}) {
      return new Promise<RunResult>((resolve, reject) => {
        const [command, ...args] = argv;
        if (command === undefined) {
          reject(new SshRemoteError('unknown', 'empty argv passed to process runner'));
          return;
        }
        execFile(
          command,
          args,
          { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(
                new SshRemoteError(
                  'local-missing-binary',
                  `executable "${command}" was not found on this machine; install an OpenSSH client`,
                  { cause: error },
                ),
              );
              return;
            }
            if (error !== null && error.killed === true) {
              reject(
                new SshRemoteError('network', `"${command}" timed out and was killed`, {
                  stderr,
                  cause: error,
                }),
              );
              return;
            }
            const code =
              error !== null && typeof error.code === 'number' ? error.code : 0;
            resolve({ code, stdout, stderr });
          },
        );
      });
    },
    spawn(argv, options = {}) {
      const [command, ...args] = argv;
      if (command === undefined) {
        throw new SshRemoteError('unknown', 'empty argv passed to process runner');
      }
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => options.onStdout?.(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => options.onStderr?.(chunk.toString('utf8')));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('error', () => {
            resolve({ code: null, signal: null });
          });
          child.on('exit', (code, signal) => {
            resolve({ code, signal });
          });
        },
      );
      return {
        exited,
        kill() {
          child.kill('SIGTERM');
        },
      };
    },
  };
}
