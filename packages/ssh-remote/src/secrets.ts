import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { SshRemoteError, errorMessage } from './errors';
import { SSH_CONNECTIONS_DIR } from './store';

export const SSH_SECRETS_FILE = 'secrets.json';

const secretsFileSchema = z.object({
  version: z.literal(1),
  passwords: z.record(z.string(), z.string()),
});

export class SecretsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly homeDir: string) {}

  get filePath(): string {
    return join(this.homeDir, SSH_CONNECTIONS_DIR, SSH_SECRETS_FILE);
  }

  async hasPassword(name: string): Promise<boolean> {
    return (await this.readFile()).passwords[name] !== undefined;
  }

  async getPassword(name: string): Promise<string | undefined> {
    return (await this.readFile()).passwords[name];
  }

  async setPassword(name: string, password: string): Promise<void> {
    if (name.length === 0 || password.length === 0) {
      throw new SshRemoteError('config', 'connection name and password must not be empty');
    }
    await this.withWriteLock(async () => {
      const data = await this.readFile();
      data.passwords[name] = password;
      await this.writeFile(data);
    });
  }

  async removePassword(name: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const data = await this.readFile();
      if (data.passwords[name] === undefined) return false;
      delete data.passwords[name];
      await this.writeFile(data);
      return true;
    });
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release = (): void => {};
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readFile(): Promise<z.output<typeof secretsFileSchema>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, passwords: {} };
      }
      throw error;
    }
    try {
      return secretsFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new SshRemoteError(
        'config',
        `ssh secrets file ${this.filePath} is unreadable: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async writeFile(data: z.output<typeof secretsFileSchema>): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${this.filePath}.tmp.${randomBytes(8).toString('hex')}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, 'w', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}
