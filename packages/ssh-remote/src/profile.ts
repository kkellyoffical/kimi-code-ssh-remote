import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

export const DEFAULT_SSH_PORT = 22;

export const sshConnectionProfileSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'connection name must start with a letter or digit and contain only letters, digits, dot, underscore, or dash',
    ),
  host: z.string().min(1, 'host is required'),
  user: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
  identityFile: z.string().min(1).optional(),
});

export type SshConnectionProfile = z.output<typeof sshConnectionProfileSchema>;
export type SshConnectionProfileInput = z.input<typeof sshConnectionProfileSchema>;

export function sshDestination(profile: SshConnectionProfile): string {
  return profile.user === undefined ? profile.host : `${profile.user}@${profile.host}`;
}

export function resolveKimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KIMI_CODE_HOME'];
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.kimi-code');
}
