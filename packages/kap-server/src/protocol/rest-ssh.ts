import { z } from 'zod';

export const sshConnectionStateSchema = z.enum(['off', 'connecting', 'on', 'error']);
export type SshConnectionStateWire = z.infer<typeof sshConnectionStateSchema>;

export const sshHostKeyDetailsSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  fingerprint: z.string().optional(),
  key_type: z.string().optional(),
  expected_fingerprint: z.string().optional(),
  known_hosts_file: z.string().optional(),
  known_hosts_line: z.number().int().optional(),
});
export type SshHostKeyDetailsWire = z.infer<typeof sshHostKeyDetailsSchema>;

export const sshConnectionStatusSchema = z.object({
  state: sshConnectionStateSchema,
  local_origin: z.string().optional(),
  error: z.string().optional(),
  needs_password: z.boolean().optional(),
  host_key: sshHostKeyDetailsSchema.optional(),
});
export type SshConnectionStatusWire = z.infer<typeof sshConnectionStatusSchema>;

export const sshConnectionSchema = z.object({
  name: z.string(),
  host: z.string(),
  user: z.string().optional(),
  port: z.number().int(),
  identity_file: z.string().optional(),
  has_password: z.boolean(),
  status: sshConnectionStatusSchema,
});
export type SshConnectionWire = z.infer<typeof sshConnectionSchema>;

export const listSshConnectionsResponseSchema = z.object({
  connections: z.array(sshConnectionSchema),
});
export type ListSshConnectionsResponse = z.infer<typeof listSshConnectionsResponseSchema>;

export const addSshConnectionRequestSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'connection name must start with a letter or digit and contain only letters, digits, dot, underscore, or dash',
    ),
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identity_file: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  save_password: z.boolean().optional(),
});
export type AddSshConnectionRequest = z.infer<typeof addSshConnectionRequestSchema>;

export const sshConnectionAuthRequestSchema = z.object({
  password: z.string().min(1).optional(),
  save_password: z.boolean().optional(),
});
export type SshConnectionAuthRequest = z.infer<typeof sshConnectionAuthRequestSchema>;

export const submitSshConnectionPasswordRequestSchema = z.object({
  password: z.string().min(1),
  save_password: z.boolean().optional(),
});
export type SubmitSshConnectionPasswordRequest = z.infer<
  typeof submitSshConnectionPasswordRequestSchema
>;

export const setSshConnectionPasswordRequestSchema = z.object({
  password: z.string().min(1),
});
export type SetSshConnectionPasswordRequest = z.infer<
  typeof setSshConnectionPasswordRequestSchema
>;

export const sshConnectionPasswordStateSchema = z.object({
  name: z.string(),
  has_password: z.boolean(),
});
export type SshConnectionPasswordStateWire = z.infer<typeof sshConnectionPasswordStateSchema>;

export const sshConnectionNameParamSchema = z.object({
  name: z.string().min(1),
});
export type SshConnectionNameParam = z.infer<typeof sshConnectionNameParamSchema>;

export const sshConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  platform: z.enum(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']).optional(),
  kimi_path: z.string().optional(),
  server_running: z.boolean().optional(),
  error: z.string().optional(),
  needs_password: z.boolean().optional(),
});
export type SshConnectionTestResultWire = z.infer<typeof sshConnectionTestResultSchema>;

export const connectSshConnectionResponseSchema = z.object({
  name: z.string(),
  state: sshConnectionStateSchema,
  local_origin: z.string(),
});
export type ConnectSshConnectionResponse = z.infer<typeof connectSshConnectionResponseSchema>;

export const disconnectSshConnectionResponseSchema = z.object({
  name: z.string(),
  state: sshConnectionStateSchema,
});
export type DisconnectSshConnectionResponse = z.infer<typeof disconnectSshConnectionResponseSchema>;

export const deleteSshConnectionResponseSchema = z.object({
  name: z.string(),
});
export type DeleteSshConnectionResponse = z.infer<typeof deleteSshConnectionResponseSchema>;

export const sshHostKeySchema = z.object({
  key_type: z.string(),
  fingerprint: z.string(),
});
export type SshHostKeyWire = z.infer<typeof sshHostKeySchema>;

export const sshHostKeyScanResponseSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  keys: z.array(sshHostKeySchema),
});
export type SshHostKeyScanResponse = z.infer<typeof sshHostKeyScanResponseSchema>;

export const forgetSshHostKeyResponseSchema = z.object({
  name: z.string(),
  forgotten: z.boolean(),
});
export type ForgetSshHostKeyResponse = z.infer<typeof forgetSshHostKeyResponseSchema>;
