/**
 * WebSocketTransport's offline send queue: bounded, dropping the OLDEST
 * message past the cap.
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * it pins a memory invariant, not UI internals — a background tab kept
 * offline for hours would otherwise queue without bound until the server
 * comes back (see MAX_PENDING_BROADCASTS on the extension host for the same
 * bound on the other side of the wire).
 */

import { describe, expect, it } from 'vitest';

import type { ClientMessage } from '../../core/src/messages.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

function msg(n: number): ClientMessage {
  return { type: 'setSoundEnabled', enabled: n % 2 === 0 } as ClientMessage;
}

function queueOf(transport: WebSocketTransport): ClientMessage[] {
  return (transport as unknown as { pendingMessages: ClientMessage[] }).pendingMessages;
}

describe('WebSocketTransport offline queue', () => {
  it('queues messages while not connected', () => {
    const transport = new WebSocketTransport('ws://127.0.0.1:1/ws');
    transport.send(msg(1));
    transport.send(msg(2));
    expect(queueOf(transport).map((m) => (m as { enabled: boolean }).enabled)).toEqual([
      false,
      true,
    ]);
  });

  it('drops the oldest message past MAX_PENDING_CLIENT_MESSAGES', () => {
    const transport = new WebSocketTransport('ws://127.0.0.1:1/ws');
    for (let i = 0; i < 1001; i++) transport.send(msg(i));
    const queue = queueOf(transport);
    expect(queue.length).toBe(1000);
    // The first send (msg(0), enabled=false) was dropped; msg(1) is now the
    // oldest, and the newest (msg(1000), enabled=true) survived.
    expect((queue[0] as { enabled: boolean }).enabled).toBe(false);
    expect((queue[999] as { enabled: boolean }).enabled).toBe(true);
    transport.dispose();
  });
});
