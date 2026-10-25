/**
 * Bounds on what one WebSocket frame may make the server do.
 *
 * A /ws socket is open to more than the operator: a page the user merely
 * visited can reach it once its DNS rebinding resolves to 127.0.0.1 (its
 * Origin then equals the Host it typed, passing the connection gate), and it
 * needs no token — the frame is JSON.parse'd and its `type` logged BEFORE the
 * privilege gate runs. Without a transport-level size cap, every frame is
 * buffered and parsed up to ws's own default (100 MiB), and an attacker-sized
 * `type` rides into stdout one full copy per message — a read-only connection
 * is enough to burn CPU and fill the log. These tests pin both bounds.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { MAX_WS_MESSAGE_BYTES } from '../src/constants.js';

// Isolated temp HOME: the server writes ~/.pixel-agents/{server.json,servers/}.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', (err) => reject(err));
  });
}

/** Resolve the close code, or null when the socket is still open after `ms`. */
function closeCode(socket: WebSocket, ms = 2_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.on('error', () => {
      /* a server-side close surfaces as 'close' */
    });
  });
}

/** Open a same-origin, TOKENLESS /ws socket — the connection shape a
 * DNS-rebound page presents, and the least privilege that still reaches the
 * parser and the log line. */
async function connectReadOnly(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`, {
    headers: { Origin: `http://127.0.0.1:${port.toString()}` },
  });
  await opened(socket);
  return socket;
}

describe('WebSocket frame and log bounds', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-limits-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startStandalone(): Promise<{ port: number }> {
    const config = await server.start({
      embedded: false,
      store: new AgentStateStore(),
    });
    return { port: config.port };
  }

  it('closes the socket on a frame larger than MAX_WS_MESSAGE_BYTES', async () => {
    const { port } = await startStandalone();

    const socket = await connectReadOnly(port);
    sockets.push(socket);

    // Content is irrelevant: the receiver enforces the cap on the wire length
    // before any handler parses it. ws closes with 1009 (too big).
    socket.send(Buffer.alloc(MAX_WS_MESSAGE_BYTES + 4096, 0x78));

    expect(await closeCode(socket)).toBe(1009);
  });

  it('accepts a frame just under the cap', async () => {
    const { port } = await startStandalone();

    const socket = await connectReadOnly(port);
    sockets.push(socket);

    // A padded webviewReady (the biggest legitimate client message shape) at
    // cap-minus-one must survive: the cap bounds the attacker, not the office.
    socket.send(
      JSON.stringify({ type: 'webviewReady', pad: 'x'.repeat(MAX_WS_MESSAGE_BYTES - 4096) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('bounds the client-controlled type before it reaches a log line', async () => {
    const { port } = await startStandalone();

    const socket = await connectReadOnly(port);
    sockets.push(socket);

    // Suppress output while capturing every argument, so the assertion reads
    // the logged copy, and a failure does not paste 50KB into the report.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      socket.send(JSON.stringify({ type: 't'.repeat(50_000) }));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const logged = logSpy.mock.calls
        .filter(([first]) => String(first).includes('WS client message'))
        .map(([, second]) => String(second));
      expect(logged).toHaveLength(1);
      expect(logged[0].length).toBeLessThanOrEqual(65); // 64 + the '…' marker

      const warned = warnSpy.mock.calls
        .filter(([first]) => String(first).includes('Ignoring'))
        .map(([first]) => String(first));
      expect(warned).toHaveLength(1);
      expect(warned[0].length).toBeLessThanOrEqual(300);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
