import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { SshRemoteError, errorMessage } from './errors';
import {
  sshConnectionProfileSchema,
  type SshConnectionProfile,
  type SshConnectionProfileInput,
} from './profile';

export const SSH_CONNECTIONS_FILE = 'ssh-connections.json';

const storeFileSchema = z.object({
  version: z.literal(1),
  connections: z.array(sshConnectionProfileSchema),
});

export class ConnectionStore {
  constructor(readonly homeDir: string) {}

  get filePath(): string {
    return join(this.homeDir, SSH_CONNECTIONS_FILE);
  }

  async list(): Promise<SshConnectionProfile[]> {
    return (await this.readFile()).connections;
  }

  async get(name: string): Promise<SshConnectionProfile | undefined> {
    return (await this.list()).find((profile) => profile.name === name);
  }

  async add(input: SshConnectionProfileInput): Promise<SshConnectionProfile> {
    const profile = parseProfile(input);
    const data = await this.readFile();
    if (data.connections.some((existing) => existing.name === profile.name)) {
      throw new SshRemoteError('config', `ssh connection "${profile.name}" already exists`);
    }
    data.connections.push(profile);
    await this.writeFile(data);
    return profile;
  }

  async remove(name: string): Promise<boolean> {
    const data = await this.readFile();
    const next = data.connections.filter((profile) => profile.name !== name);
    if (next.length === data.connections.length) return false;
    await this.writeFile({ version: 1, connections: next });
    return true;
  }

  private async readFile(): Promise<z.output<typeof storeFileSchema>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, connections: [] };
      }
      throw error;
    }
    try {
      return storeFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new SshRemoteError(
        'config',
        `ssh connections file ${this.filePath} is unreadable: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async writeFile(data: z.output<typeof storeFileSchema>): Promise<void> {
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

function parseProfile(input: SshConnectionProfileInput): SshConnectionProfile {
  const result = sshConnectionProfileSchema.safeParse(input);
  if (!result.success) {
    throw new SshRemoteError('config', `invalid ssh connection profile: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}
