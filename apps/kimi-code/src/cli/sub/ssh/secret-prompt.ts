/**
 * Hidden-echo secret entry for `kimi ssh` password prompts. Reads one line in
 * raw mode with nothing written back, so the password never appears on screen,
 * in argv, or in shell history. Injected through `SshCommandDeps.promptSecret`
 * so tests never touch a real TTY.
 */

import { emitKeypressEvents } from 'node:readline';

export interface SecretPromptStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export function readSecretLine(
  streams: SecretPromptStreams,
  question: string,
): Promise<string> {
  const { input, output } = streams;
  if (typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new Error('password entry requires an interactive terminal (hidden prompt)'),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let secret = '';
    const hadRawMode = 'isRaw' in input ? input.isRaw : false;

    const cleanup = (): void => {
      input.off('keypress', onKeypress);
      input.setRawMode(hadRawMode);
      input.pause();
      output.write('\n');
    };

    const onKeypress = (
      chunk: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ): void => {
      if (key.ctrl === true && key.name === 'c') {
        cleanup();
        reject(new Error('password entry aborted'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(secret);
        return;
      }
      if (key.name === 'backspace') {
        secret = secret.slice(0, -1);
        return;
      }
      if (key.ctrl === true && key.name === 'u') {
        secret = '';
        return;
      }
      if (key.ctrl === true || key.meta === true) return;
      if (chunk !== undefined && chunk.length > 0) {
        secret += chunk;
      }
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(question);
    input.on('keypress', onKeypress);
  });
}
