import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { readNewLines } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors transcriptParser.test.ts). */
function createTestAgent(jsonlFile: string): AgentState {
  return {
    id: 1,
    sessionId: 'test-session',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile,
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
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: 200_000,
  } as AgentState;
}

/** An assistant record shaped like Claude Code writes: a narration text block
 *  followed by a Bash tool_use whose status shows a multi-byte character. */
function bashToolUseRecord(textPadding: number, toolId: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: `Kết quả kiểm thử\n${'a'.repeat(textPadding)}` },
        {
          type: 'tool_use',
          id: toolId,
          name: 'Bash',
          input: { command: 'git commit -m "😀 nhé"' },
        },
      ],
    },
  });
}

describe('readNewLines: multi-byte UTF-8 split across reads', () => {
  let dir: string;
  let agents: AgentStateStore;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-utf8-'));
    agents = new AgentStateStore();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function watch(file: string): AgentState {
    const agent = createTestAgent(file);
    agents.set(1, agent);
    return agent;
  }

  it('re-reads a multi-byte character torn by a mid-write poll instead of decoding a replacement char', () => {
    const file = path.join(dir, 'session-torn-eof.jsonl');
    const lineBytes = Buffer.from(bashToolUseRecord(0, 'toolu_01TORN'), 'utf8');
    const emoji = Buffer.from('😀', 'utf8');
    const cut = lineBytes.indexOf(emoji);
    expect(cut).toBeGreaterThan(0);

    // The poll catches the writer between the emoji's lead byte and its
    // continuation bytes (a tail written half-way).
    fs.writeFileSync(file, lineBytes.subarray(0, cut + 1));
    const agent = watch(file);
    readNewLines(1, agents, waitingTimers, permissionTimers);
    expect(agent.lineBuffer).not.toContain('�');

    fs.appendFileSync(file, lineBytes.subarray(cut + 1));
    fs.appendFileSync(file, '\n');
    readNewLines(1, agents, waitingTimers, permissionTimers);

    expect(agent.activeToolStatuses.get('toolu_01TORN')).toBe('Running: git commit -m "😀 nhé"');
  });

  it('holds back a multi-byte character cut by the 64KB read cap', () => {
    const file = path.join(dir, 'session-cap.jsonl');
    const emoji = Buffer.from('😀', 'utf8');
    // Pad the narration text block so the emoji's lead byte lands at offset
    // 65535 -- the last byte of the first capped read.
    const probe = Buffer.from(bashToolUseRecord(0, 'toolu_01CAP'), 'utf8');
    const padding = 65535 - probe.indexOf(emoji);
    const lineBytes = Buffer.concat([
      Buffer.from(bashToolUseRecord(padding, 'toolu_01CAP'), 'utf8'),
      Buffer.from('\n'),
    ]);
    expect(lineBytes[65535]).toBe(emoji[0]);

    fs.writeFileSync(file, lineBytes);
    const agent = watch(file);
    readNewLines(1, agents, waitingTimers, permissionTimers); // first 64KB
    expect(agent.lineBuffer).not.toContain('�');

    readNewLines(1, agents, waitingTimers, permissionTimers); // remainder
    expect(agent.activeToolStatuses.get('toolu_01CAP')).toBe('Running: git commit -m "😀 nhé"');
  });
});
