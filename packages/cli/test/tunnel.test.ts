import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { type SpawnFn, startTunnel, type TunnelProcess } from '../src/tunnel.js';

/** A minimal stand-in for a cloudflared ChildProcess (see {@link TunnelProcess}). */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const spawnReturning =
  (child: FakeChild): SpawnFn =>
  () =>
    child as unknown as TunnelProcess;
const LOCAL_ORIGIN = 'http://127.0.0.1:5051';
const LOCAL_MCP = `${LOCAL_ORIGIN}/o/local/app/dev/mcp`;

describe('startTunnel', () => {
  it('parses the trycloudflare URL and rebuilds the public MCP URL on the tenant path', async () => {
    const child = new FakeChild();
    const pending = startTunnel({
      localOrigin: LOCAL_ORIGIN,
      localMcpUrl: LOCAL_MCP,
      spawn: spawnReturning(child),
    });
    child.stderr.emit(
      'data',
      Buffer.from('Your quick Tunnel: https://blue-cat-1234.trycloudflare.com\n'),
    );
    const handle = await pending;
    expect(handle.publicOrigin).toBe('https://blue-cat-1234.trycloudflare.com');
    expect(handle.publicMcpUrl).toBe('https://blue-cat-1234.trycloudflare.com/o/local/app/dev/mcp');
  });

  it('rejects with install guidance when cloudflared is missing', async () => {
    const child = new FakeChild();
    const pending = startTunnel({
      localOrigin: LOCAL_ORIGIN,
      localMcpUrl: LOCAL_MCP,
      spawn: spawnReturning(child),
    });
    child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
    await expect(pending).rejects.toThrow(/cloudflared not found/i);
  });

  it('rejects when cloudflared exits before opening a tunnel', async () => {
    const child = new FakeChild();
    const pending = startTunnel({
      localOrigin: LOCAL_ORIGIN,
      localMcpUrl: LOCAL_MCP,
      spawn: spawnReturning(child),
    });
    child.emit('exit', 1);
    await expect(pending).rejects.toThrow(/exited .* before opening a tunnel/i);
  });

  it('kills the cloudflared process on close', async () => {
    const child = new FakeChild();
    const pending = startTunnel({
      localOrigin: LOCAL_ORIGIN,
      localMcpUrl: LOCAL_MCP,
      spawn: spawnReturning(child),
    });
    child.stderr.emit('data', Buffer.from('https://x-y-z.trycloudflare.com'));
    const handle = await pending;
    await handle.close();
    expect(child.killed).toBe(true);
  });

  it('never echoes raw cloudflared output (no token passthrough)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = new FakeChild();
    const pending = startTunnel({
      localOrigin: LOCAL_ORIGIN,
      localMcpUrl: LOCAL_MCP,
      spawn: spawnReturning(child),
    });
    child.stderr.emit('data', Buffer.from('Authorization: Bearer SECRET-TOKEN-123\n'));
    child.stderr.emit('data', Buffer.from('https://a-b-c.trycloudflare.com\n'));
    await pending;
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');
    expect(printed).not.toContain('SECRET-TOKEN-123');
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
