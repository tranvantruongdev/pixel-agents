import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PersistedAgent } from '../src/types.js';

function createMockAdapter(initial: PersistedAgent[] = []): StateAdapter & {
  saved: PersistedAgent[][];
} {
  let current = initial;
  const saved: PersistedAgent[][] = [];
  return {
    saved,
    loadAgents: () => current,
    saveAgents: (agents) => {
      current = agents;
      saved.push(agents);
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
}

/**
 * The persisted state file is external input: FileStateAdapter.loadAgents()
 * casts its rows to PersistedAgent without validating them, so a hand-edited
 * or corrupted ~/.pixel-agents/<ns>-state.json reaches restoreExternalAgents()
 * as-is. A malformed row must be skipped, not throw: the throw used to escape
 * through handleClientMessage into the /ws message handler's catch-all, which
 * silently ended the webviewReady handshake — an empty office with no error.
 *
 * Same harness as agentRuntime.restorePalette.test.ts: mock adapter, one empty
 * JSONL on disk for the existence gate, no state-file I/O.
 */
describe('AgentRuntime -- restore skips malformed persisted entries', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-bad-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(jsonlPath, '');
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function validEntry(id: number): PersistedAgent {
    return {
      id,
      sessionId: `sess-${id}`,
      terminalName: '',
      isExternal: true,
      jsonlFile: jsonlPath,
      projectDir: tmpDir,
    };
  }

  it('a non-array backgroundAgentToolIds degrades to no tool ids instead of throwing', () => {
    const persisted: PersistedAgent[] = [
      { ...validEntry(1), backgroundAgentToolIds: 42 as unknown as string[] },
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    const rt = new AgentRuntime(store, claudeProvider);
    runtime = rt;

    expect(() => rt.restoreExternalAgents()).not.toThrow();

    const agent = store.get(1);
    expect(agent).toBeDefined();
    expect(agent?.backgroundAgentToolIds.size).toBe(0);
  });

  it('a null or non-identified row is skipped and later rows still restore', () => {
    const persisted: PersistedAgent[] = [
      null as unknown as PersistedAgent,
      validEntry(2),
      { ...validEntry(3), id: 'not-a-number' as unknown as number },
      validEntry(4),
    ];
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter(persisted));
    const rt = new AgentRuntime(store, claudeProvider);
    runtime = rt;

    expect(() => rt.restoreExternalAgents()).not.toThrow();

    expect(store.has(2)).toBe(true);
    expect(store.has(4)).toBe(true);
    // nextAgentId must move past the restored ids so the next launch cannot
    // collide with either of them.
    expect(store.nextAgentId.current).toBeGreaterThan(4);
  });
});
