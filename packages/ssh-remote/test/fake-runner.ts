import type {
  ProcessRunner,
  RunOptions,
  RunResult,
  SpawnOptions,
  SpawnedProcess,
} from '../src/runner';

export interface RecordedRun {
  readonly argv: readonly string[];
  readonly env?: Record<string, string>;
}

export class FakeSpawnedProcess implements SpawnedProcess {
  killed = false;

  private resolveExited!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(readonly argv: readonly string[]) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
  }

  kill(): void {
    this.killed = true;
    this.resolveExit({ code: null, signal: 'SIGTERM' });
  }

  resolveExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.resolveExited(info);
  }
}

type RunHandler = (argv: readonly string[]) => RunResult | Promise<RunResult>;

export class FakeProcessRunner implements ProcessRunner {
  readonly runs: RecordedRun[] = [];
  readonly spawns: FakeSpawnedProcess[] = [];

  private readonly handlers: { match: RegExp; respond: RunHandler }[] = [];
  defaultResult: RunResult = { code: 0, stdout: '', stderr: '' };

  onRun(match: RegExp, respond: RunHandler): void {
    this.handlers.unshift({ match, respond });
  }

  async run(argv: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.runs.push({ argv, env: options?.env });
    const joined = argv.join(' ');
    for (const handler of this.handlers) {
      if (handler.match.test(joined)) {
        return handler.respond(argv);
      }
    }
    return this.defaultResult;
  }

  spawn(argv: readonly string[], _options?: SpawnOptions): FakeSpawnedProcess {
    const child = new FakeSpawnedProcess(argv);
    this.spawns.push(child);
    return child;
  }

  lastRun(): RecordedRun {
    const run = this.runs.at(-1);
    if (run === undefined) throw new Error('no runs recorded');
    return run;
  }
}

export function remoteCommand(run: RecordedRun): string {
  return run.argv.at(-1) ?? '';
}
