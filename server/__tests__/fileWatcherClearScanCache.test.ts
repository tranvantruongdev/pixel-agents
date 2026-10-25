import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-agent /clear detection (startFileWatching's 500ms poll) used to re-read
 * the 8KB head of every unknown .jsonl in the project dir on EVERY tick of an
 * idle agent — measured 104 open+read+close/s (~27 CPU-ms/s) for one idle
 * terminal agent in a project with 50 old sessions. Transcripts are
 * append-only, so a head that held no /clear record never gains one; this
 * suite pins the cache that removes the re-reads (openSync delta must be 0 on
 * later ticks), the unchanged /clear-claim broadcast stream, and the unchanged
 * new-line detection latency.
 */
const counters = vi.hoisted(() => ({
  openSync: 0,
  readSync: 0,
  statSync: 0,
  readdirSync: 0,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const counted = new Set(['openSync', 'readSync', 'statSync', 'readdirSync']);
  const cache = new Map<string, unknown>();
  return new Proxy(actual as object, {
    get(target, prop, recv) {
      const key = String(prop);
      if (!counted.has(key)) return Reflect.get(target, prop, recv);
      if (cache.has(key)) return cache.get(key);
      const fn = Reflect.get(target, prop, recv) as (...a: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const slot = key as keyof typeof counters;
        if (slot in counters) counters[slot]++;
        return fn.apply(this, args);
      };
      cache.set(key, wrapped);
      return wrapped;
    },
  });
});

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  ensureProjectScan,
  setDismissalTracker,
  startFileWatching,
} from '../src/fileWatcher.js';

function isolateHomeEnv(tmpHome: string): () => void {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const OLD_SESSIONS = 12;

/** One ordinary conversation record — no /clear marker. */
function normalRecord(n: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: `old turn ${n} ${'x'.repeat(200)}` }],
    },
  });
}

const CLEAR_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [{ type: 'text', text: '<command>/clear</command><command-name>/clear</command-name>' }],
  },
});

const USER_PROMPT_LINE = JSON.stringify({
  type: 'user',
  message: { content: 'hello office' },
});

interface Harness {
  store: AgentStateStore;
  agentId: number;
  termFile: string;
  projectDir: string;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  fileWatchers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  projectScanTimer: { current: ReturnType<typeof setInterval> | null };
  broadcasts: string[];
  activeAgentIdRef: { current: number | null };
  knownJsonlFiles: Set<string>;
}

async function setupIdleTerminalAgent(
  hookDelivered = false,
): Promise<Harness> {
  const tmpHome = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'pa-clear-cache-'),
  );
  isolateHomeEnv(tmpHome);
  const projectDir = path.join(tmpHome, 'work-proj');
  await fsPromises.mkdir(projectDir, { recursive: true });
  const writes: Promise<unknown>[] = [];
  for (let i = 0; i < OLD_SESSIONS; i++) {
    writes.push(
      fsPromises.writeFile(
        path.join(projectDir, `old-${String(i).padStart(2, '0')}.jsonl`),
        Array.from({ length: 8 }, (_, n) => normalRecord(n)).join('\n') + '\n',
      ),
    );
  }
  // Terminal agent's own session: one record sits unread at EOF.
  const termFile = path.join(projectDir, 'term-sess.jsonl');
  writes.push(
    fsPromises.writeFile(
      termFile,
      Array.from({ length: 4 }, (_, n) => normalRecord(n)).join('\n') + '\n' + USER_PROMPT_LINE + '\n',
    ),
  );
  await Promise.all(writes);

  const store = new AgentStateStore();
  setDismissalTracker(new DismissalTracker());
  const broadcasts: string[] = [];
  store.on('broadcast', (m) => broadcasts.push(JSON.stringify(m)));

  const pollingTimers = new Map();
  const fileWatchers = new Map();
  const waitingTimers = new Map();
  const permissionTimers = new Map();
  const projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  sharedKnownJsonlFiles.clear();
  const knownJsonlFiles = sharedKnownJsonlFiles;
  const activeAgentIdRef = { current: null as number | null };
  const nextAgentIdRef = { current: 901 };

  ensureProjectScan(
    projectDir,
    knownJsonlFiles,
    projectScanTimer,
    activeAgentIdRef,
    nextAgentIdRef,
    store,
    fileWatchers as never,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    () => {},
  );

  const agentId = 900;
  const size = (await fsPromises.stat(termFile)).size;
  const agent = createAgentState({
    id: agentId,
    sessionId: 'term-sess',
    isExternal: false,
    projectDir,
    jsonlFile: termFile,
    // leave only the trailing user-prompt line unread so the first poll has
    // linesProcessed > 0 (the idle heuristic's gate for /clear scanning)
    fileOffset: size - USER_PROMPT_LINE.length - 1,
    hookDelivered,
    lastDataAt: 0,
  });
  (agent as unknown as { terminalRef: unknown }).terminalRef = { name: 'claude' };
  store.set(agentId, agent);
  knownJsonlFiles.add(termFile);
  activeAgentIdRef.current = agentId;
  startFileWatching(
    agentId,
    termFile,
    store,
    fileWatchers as never,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  return {
    store,
    agentId,
    termFile,
    projectDir,
    pollingTimers,
    fileWatchers,
    waitingTimers,
    permissionTimers,
    projectScanTimer,
    broadcasts,
    activeAgentIdRef,
    knownJsonlFiles,
  };
}

function teardown(h: Harness | undefined): void {
  if (!h) return;
  const pt = h.pollingTimers.get(h.agentId);
  if (pt) clearInterval(pt);
  h.pollingTimers.delete(h.agentId);
  const st = h.projectScanTimer.current;
  if (st) clearInterval(st);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fileWatcher's clearDetectionDeps latches the FIRST knownJsonlFiles Set it
 *  is handed (module-global, set once per test file) — share one Set across
 *  the file's tests so every test sees the same claim state. */
const sharedKnownJsonlFiles = new Set<string>();

describe('per-agent /clear scan cache (idle terminal agent, hooks off)', () => {
  let harness: Harness | undefined;
  let savedHome: { HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  });

  afterEach(() => {
    teardown(harness);
    for (const [name, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('stops re-reading non-clear heads: openSync delta is 0 on later ticks', {
    timeout: 15_000,
  }, async () => {
    harness = await setupIdleTerminalAgent();
    const { projectDir } = harness;

    // First ~3.2s: the trailing prompt is parsed, then the idle threshold
    // (2s) passes and ONE /clear scan tick reads all 12 old heads.
    await sleep(3200);
    const afterFirstScan = { ...counters };

    // Three more ticks: every old head is cached, nothing may be re-opened.
    await sleep(1600);
    expect(counters.openSync - afterFirstScan.openSync).toBe(0);
    expect(counters.readSync - afterFirstScan.readSync).toBe(0);

    // A NEW session file appearing later must still be read once, then cached.
    await fsPromises.writeFile(
      path.join(projectDir, 'old-later.jsonl'),
      normalRecord(0) + '\n',
    );
    await sleep(1200);
    const laterOpens = counters.openSync - afterFirstScan.openSync;
    expect(laterOpens).toBeGreaterThanOrEqual(1);
    const afterLaterScan = { ...counters };
    await sleep(1200);
    expect(counters.openSync - afterLaterScan.openSync).toBe(0);
  });

  it('still claims a real /clear file with the unchanged broadcast stream', {
    timeout: 15_000,
  }, async () => {
    harness = await setupIdleTerminalAgent();
    const { projectDir, store, agentId, knownJsonlFiles } = harness;

    await sleep(3200); // first poll parsed the prompt; idle threshold passed
    const beforeClaim = harness.broadcasts.length;

    await fsPromises.writeFile(
      path.join(projectDir, 'fresh-sess.jsonl'),
      CLEAR_LINE + '\n',
    );

    // Wait until the 500ms scan claims it (content check on first sight).
    const deadline = Date.now() + 4000;
    while (store.get(agentId)?.jsonlFile !== path.join(projectDir, 'fresh-sess.jsonl')) {
      if (Date.now() > deadline) throw new Error('clear file was never claimed');
      await sleep(100);
    }

    // Reassignment restarts the watcher on the /clear file and replays it.
    await sleep(600);
    const stream = harness.broadcasts.slice(beforeClaim).map((s) => (JSON.parse(s) as { type: string }).type);
    // reassignAgentToFile → clearAgentActivity, replayed /clear prompt → clearAgentActivity
    expect(stream).toEqual(['agentToolsClear', 'agentStatus', 'agentToolsClear', 'agentStatus']);
    const agent = store.get(agentId)!;
    expect(agent.sessionId).toBe('fresh-sess');
    expect(knownJsonlFiles.has(path.join(projectDir, 'fresh-sess.jsonl'))).toBe(true);
    expect(agent.fileOffset).toBeGreaterThan(0);
  });

  it('keeps new-line detection latency inside one 500ms poll', {
    timeout: 15_000,
  }, async () => {
    harness = await setupIdleTerminalAgent(false);
    const { termFile, broadcasts } = harness;

    await sleep(1000); // first poll consumed the seed line
    const seen: number[] = [];
    const waitToolStart = new Promise<void>((resolve) => {
      const check = (): void => {
        for (const s of broadcasts.slice(seen.length)) {
          seen.push(1);
          const m = JSON.parse(s) as { type: string; toolId?: string };
          if (m.type === 'agentToolStart' && m.toolId === 'lat_probe') resolve();
        }
      };
      check();
      const iv = setInterval(check, 20);
      setTimeout(() => {
        clearInterval(iv);
        resolve();
      }, 1200);
    });

    const t0 = Date.now();
    await fsPromises.appendFile(
      termFile,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'lat_probe', name: 'Bash', input: { command: 'x' } }],
        },
      }) + '\n',
    );
    await waitToolStart;
    expect(Date.now() - t0).toBeLessThan(1100);
  });
});
