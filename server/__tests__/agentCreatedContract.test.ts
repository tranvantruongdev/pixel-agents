import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AgentState } from '../src/types.js';

// Isolated temp HOME: the server writes ~/.pixel-agents/{server.json,servers/}.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');

/**
 * The AgentCreated schema of record, extracted from core/asyncapi.yaml.
 * The block's shape is stable (hand-maintained, fixed indentation): property
 * names are the 8-space keys under `properties:`, plus `required` and
 * `additionalProperties` on the block itself.
 */
function extractAgentCreatedSchema(): {
  required: string[];
  additionalProperties: boolean;
  properties: Set<string>;
} {
  const yaml = fs.readFileSync(
    new URL('../../core/asyncapi.yaml', import.meta.url),
    'utf-8',
  ) as string;
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === '    AgentCreated:');
  expect(start, 'AgentCreated block not found in core/asyncapi.yaml').toBeGreaterThanOrEqual(0);
  const schema: { required: string[]; additionalProperties: boolean; properties: Set<string> } = {
    required: [],
    additionalProperties: true,
    properties: new Set(),
  };
  let inProperties = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^    \S/.test(line)) break; // next top-level schema key
    const req = line.match(/^      required: \[(.*)\]/);
    if (req) {
      schema.required = req[1].split(',').map((s) => s.trim());
      continue;
    }
    if (/^      additionalProperties: false/.test(line)) schema.additionalProperties = false;
    if (/^      properties:/.test(line)) {
      inProperties = true;
      continue;
    }
    const prop = line.match(/^        (\w+):/);
    if (prop && inProperties) schema.properties.add(prop[1]);
  }
  return schema;
}

/**
 * Contract: every field the server actually emits on `agentCreated` must be
 * declared by the AgentCreated schema. Both hosts (httpServer.ts onAgentAdded
 * and the VS Code adapter) send the teammate fields; the webview reads them.
 * A schema missing them makes a strict AsyncAPI consumer reject a message the
 * server legitimately sends (additionalProperties: false).
 */
describe('agentCreated wire payload conforms to the AgentCreated schema', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];
  let store: InstanceType<typeof AgentStateStore>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-contract-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
    store = new AgentStateStore();
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

  /** Minimal store agent; identity + team fields are what onAgentAdded reads. */
  function makeTeammateAgent(id: number): AgentState {
    return {
      id,
      sessionId: `session-${id}`,
      isExternal: false,
      projectDir: path.join(tmpBase, 'proj'),
      jsonlFile: path.join(tmpBase, 'proj', `session-${id}.jsonl`),
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: 200_000,
      providerId: 'claude',
      directoryName: 'pixel-agents',
      // Team fields: leadAgentId is what flips isTeammate on the wire.
      leadAgentId: 999,
      teamName: 'fix-squad',
      agentName: 'worker',
      hooksOnly: true,
      palette: 2,
      hueShift: 90,
    };
  }

  it('emits only schema-declared properties', async () => {
    const config = await server.start({ embedded: false, store });

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${config.port}/ws?token=${encodeURIComponent(config.token)}`,
        { headers: { Origin: `http://127.0.0.1:${config.port}` } },
      );
      const failTimer = setTimeout(() => reject(new Error('handshake timed out')), 5_000);
      ws.on('open', () => {
        clearTimeout(failTimer);
        resolve(ws);
      });
      ws.on('error', () => {
        /* surfaced via the timeout */
      });
    });
    sockets.push(socket);

    const received = new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg.type === 'agentCreated') resolve(msg);
        } catch {
          /* ignore non-JSON frames */
        }
      });
    });

    store.set(1, makeTeammateAgent(1));

    const msg = await received;
    // Sanity: the wire payload really carries the teammate fields the webview
    // reads (useExtensionMessages.ts agentCreated handler) — the test below is
    // about the SCHEMA, not about the server forgetting to send them.
    expect(msg).toMatchObject({
      type: 'agentCreated',
      id: 1,
      directoryName: 'pixel-agents',
      isTeammate: true,
      teammateName: 'worker',
      parentAgentId: 999,
      teamName: 'fix-squad',
      hooksOnly: true,
      palette: 2,
      hueShift: 90,
    });

    const schema = extractAgentCreatedSchema();
    expect(schema.additionalProperties, 'test premise: the schema is closed').toBe(false);
    const undeclared = Object.keys(msg).filter((key) => !schema.properties.has(key));
    for (const key of schema.required) {
      expect(msg, `required property "${key}" missing from the wire payload`).toHaveProperty(key);
    }
    expect(undeclared, 'properties the schema does not declare').toEqual([]);
  });
});
