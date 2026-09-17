import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SshConnectionProfile } from '../src/profile';
import { SshClient } from '../src/ssh';
import { SshTunnel, pickFreeLocalPort, type TunnelState } from '../src/tunnel';

import { FakeProcessRunner } from './fake-runner';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const PROFILE: SshConnectionProfile = {
  name: 'devbox',
  host: 'dev.example.com',
  user: 'alice',
  port: 22,
};

function makeClient(runner: FakeProcessRunner): SshClient {
  const controlDir = mkdtempSync(join(tmpdir(), 'ssh-remote-tun-'));
  cleanups.push(() => {
    rmSync(controlDir, { recursive: true, force: true });
  });
  return new SshClient({ profile: PROFILE, runner, controlDir });
}

describe('SshTunnel', () => {
  it('spawns ssh with a loopback local forward and reports connected', async () => {
    const runner = new FakeProcessRunner();
    const states: TunnelState[] = [];
    const tunnel = new SshTunnel({
      client: makeClient(runner),
      remotePort: 58627,
      localPort: 49152,
      probeLocalPort: async () => true,
      onStateChange: (status) => states.push(status.state),
    });
    await tunnel.connect();
    expect(tunnel.status()).toMatchObject({
      state: 'connected',
      localPort: 49152,
      remotePort: 58627,
      attempts: 0,
    });
    expect(states).toEqual(['connecting', 'connected']);
    const { argv } = runner.spawns[0]!;
    expect(argv[0]).toBe('ssh');
    expect(argv).toContain('-N');
    expect(argv).toContain('-T');
    expect(argv.join(' ')).toContain('ExitOnForwardFailure=yes');
    expect(argv.join(' ')).toContain('ControlPath=');
    const forward = argv[argv.indexOf('-L') + 1];
    expect(forward).toBe('127.0.0.1:49152:127.0.0.1:58627');
    expect(argv.at(-1)).toBe('alice@dev.example.com');
  });

  it('reconnects with exponential backoff after the tunnel process drops', async () => {
    const runner = new FakeProcessRunner();
    const states: TunnelState[] = [];
    const delays: number[] = [];
    const tunnel = new SshTunnel({
      client: makeClient(runner),
      remotePort: 58627,
      localPort: 49153,
      probeLocalPort: async () => true,
      sleep: async (ms) => {
        delays.push(ms);
      },
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 1_000,
      onStateChange: (status) => states.push(status.state),
    });
    await tunnel.connect();
    runner.spawns[0]!.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(runner.spawns).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(tunnel.status().state).toBe('connected');
    });
    expect(states).toContain('reconnecting');
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThanOrEqual(10);
    expect(delays[0]).toBeLessThan(20);
    expect(tunnel.status().attempts).toBe(0);
    await tunnel.disconnect();
  });

  it('gives up after the reconnect budget is exhausted', async () => {
    const runner = new FakeProcessRunner();
    let probing = true;
    const delays: number[] = [];
    const tunnel = new SshTunnel({
      client: makeClient(runner),
      remotePort: 58627,
      localPort: 49154,
      probeLocalPort: async () => probing,
      sleep: async (ms) => {
        delays.push(ms);
      },
      readyTimeoutMs: 0,
      maxReconnectAttempts: 3,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 12,
    });
    await tunnel.connect();
    probing = false;
    runner.spawns[0]!.resolveExit({ code: 255, signal: null });
    await vi.waitFor(() => {
      expect(tunnel.status().state).toBe('failed');
    });
    expect(runner.spawns.length).toBe(1 + 3);
    expect(delays.length).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(5);
    expect(delays[0]).toBeLessThan(10);
    expect(delays[1]).toBeGreaterThanOrEqual(10);
    expect(delays[2]).toBeGreaterThanOrEqual(12);
    expect(tunnel.status().lastError).toBeDefined();
  });

  it('fails the initial connect when the tunnel process exits early', async () => {
    const runner = new FakeProcessRunner();
    const tunnel = new SshTunnel({
      client: makeClient(runner),
      remotePort: 58627,
      localPort: 49155,
      probeLocalPort: async () => false,
      sleep: async () => {},
      readyPollIntervalMs: 1,
    });
    const pending = tunnel.connect();
    runner.spawns[0]!.resolveExit({ code: 255, signal: null });
    await expect(pending).rejects.toThrow(/exited before the forward was ready/);
    expect(tunnel.status().state).toBe('failed');
  });

  it('stays stopped after disconnect and does not reconnect', async () => {
    const runner = new FakeProcessRunner();
    const tunnel = new SshTunnel({
      client: makeClient(runner),
      remotePort: 58627,
      localPort: 49156,
      probeLocalPort: async () => true,
      sleep: async () => {},
      reconnectBaseDelayMs: 1,
    });
    await tunnel.connect();
    await tunnel.disconnect();
    expect(tunnel.status().state).toBe('stopped');
    expect(runner.spawns[0]!.killed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.spawns).toHaveLength(1);
    expect(tunnel.status().state).toBe('stopped');
  });
});

describe('pickFreeLocalPort', () => {
  it('returns a bindable high port', async () => {
    const port = await pickFreeLocalPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
