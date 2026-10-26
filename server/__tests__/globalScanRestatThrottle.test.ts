import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Watch All Sessions scans every session root (~/.claude/projects) every 3s.
 * Past-session transcripts are static until resumed, yet the scan used to
 * stat every file on every tick — measured 510 stat/s + 10.7 readdir/s and
 * ~30 CPU-ms/s idle on a real-world tree (30 projects x 50 old sessions).
 * The throttle re-states a file seen stale at most every
 * GLOBAL_SCAN_STALE_RESTAT_MS: this suite pins the stat drop (tick 2+ does
 * no stats), and — via fake timers — that a resumed old session is still
 * adopted once its restat window passes, with the same agentAdded event.
 */
const counters = vi.hoisted(() => ({
  statSync: 0,
  readdirSync: 0,
  openSync: 0,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const counted = new Set(['statSync', 'readdirSync', 'openSync']);
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

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  setHookProvider,
  startExternalSessionScanning,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

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

const OLD_SESSIONS_PER_PROJECT = 4;

function transcriptChunk(lines: number): string {
  return (
    Array.from(
      { length: lines },
      (_, n) =>
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `old ${n} ${'y'.repeat(300)}` }] },
        }),
    ).join('\n') + '\n'
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('global scan stale restat throttle (Watch All Sessions)', () => {
  let tmpHome: string;
  let restoreHome: () => void;
  let scanTimer: ReturnType<typeof setInterval> | null = null;

  beforeEach(() => {
    setHookProvider(claudeProvider);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    restoreHome();
    await fsPromises.rm(tmpHome, { recursive: true, force: true });
  });

  async function buildProjectsRoot(projects: number): Promise<void> {
    tmpHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pa-global-scan-'));
    restoreHome = isolateHomeEnv(tmpHome);
    const root = path.join(tmpHome, '.claude', 'projects');
    for (let p = 0; p < projects; p++) {
      const dir = path.join(root, `proj-${p}`);
      await fsPromises.mkdir(dir, { recursive: true });
      for (let f = 0; f < OLD_SESSIONS_PER_PROJECT; f++) {
        const file = path.join(dir, `old-${f}.jsonl`);
        // > GLOBAL_SCAN_ACTIVE_MIN_SIZE so a resumed one passes the size gate
        await fsPromises.writeFile(file, transcriptChunk(12));
        const mtime = new Date(Date.now() - (30 + f) * 86_400_000);
        await fsPromises.utimes(file, mtime, mtime);
      }
    }
  }

  function startScan(store: AgentStateStore, watchAll: { current: boolean }): void {
    scanTimer = startExternalSessionScanning(
      tmpHome,
      new Set<string>(),
      store.nextAgentId,
      store,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      () => {},
      watchAll,
      { current: true },
    );
  }

  it('does no stats on ticks inside the restat window', { timeout: 20_000 }, async () => {
    await buildProjectsRoot(2); // 2 projects x 4 stale files
    const store = new AgentStateStore();
    startScan(store, { current: true });

    await sleep(3500); // tick 1 stats every stale file once
    const afterFirstTick = { ...counters };
    expect(afterFirstTick.statSync).toBeGreaterThanOrEqual(2 * OLD_SESSIONS_PER_PROJECT);

    await sleep(3300); // tick 2, still inside the 30s window: no re-stats
    expect(counters.statSync - afterFirstTick.statSync).toBe(0);
    // directory listings must keep flowing (that is how a NEW file is seen)
    expect(counters.readdirSync - afterFirstTick.readdirSync).toBeGreaterThan(0);
  });

  it('re-adopts a resumed old session once its restat window passes', {
    timeout: 20_000,
  }, async () => {
    await buildProjectsRoot(1);
    const store = new AgentStateStore();
    const added: Array<{ id: number; file: string }> = [];
    store.on('agentAdded', (id, agent) => added.push({ id, file: agent.jsonlFile }));
    // fake first, THEN start the scan, so advanceTimersByTimeAsync drives both
    // the 3s ticks and Date.now (the throttle's clock)
    vi.useFakeTimers({ now: Date.now() });
    startScan(store, { current: true });
    // tick 1 (t+3s): every stale file is stated and cached
    await vi.advanceTimersByTimeAsync(3200);
    expect(added).toEqual([]);

    const resumedFile = path.join(tmpHome, '.claude', 'projects', 'proj-0', 'old-0.jsonl');
    const newMtime = new Date();
    await fsPromises.utimes(resumedFile, newMtime, newMtime);

    // advance past the 30s restat window (ticks every 3s along the way)
    await vi.advanceTimersByTimeAsync(35_000);
    vi.useRealTimers();

    expect(added).toHaveLength(1);
    expect(added[0]!.file).toBe(resumedFile);
    const agent = store.get(added[0]!.id)!;
    expect(agent.isExternal).toBe(true);
    // an old session is adopted with skip-to-end (its birthtime is stale)
    expect(agent.fileOffset).toBe((await fsPromises.stat(resumedFile)).size);
  });

  it('adopts a brand-new active file on first sight, unthrottled', {
    timeout: 20_000,
  }, async () => {
    await buildProjectsRoot(1);
    const store = new AgentStateStore();
    startScan(store, { current: true });

    const fresh = path.join(tmpHome, '.claude', 'projects', 'proj-0', 'new-sess.jsonl');
    await fsPromises.writeFile(fresh, transcriptChunk(20)); // > 3KB, mtime now

    await sleep(3500);
    expect(store.size).toBe(1);
    const agent = [...store.values()][0]!;
    expect(agent.jsonlFile).toBe(fresh);
    // born inside the scan window -> replayed from the start (the adoption
    // readNewLines consumes the whole transcript: linesProcessed > 0; a
    // skip-to-end adoption of an old session would leave it at 0)
    expect(agent.linesProcessed).toBe(20);
  });

  it('adopts a new file that starts under the size gate on the next tick', {
    timeout: 20_000,
  }, async () => {
    await buildProjectsRoot(1);
    const store = new AgentStateStore();
    startScan(store, { current: true });

    const fresh = path.join(tmpHome, '.claude', 'projects', 'proj-0', 'new-sess.jsonl');
    await fsPromises.writeFile(fresh, transcriptChunk(1)); // < 3KB, mtime now
    await sleep(3500); // tick 1 sees it too small
    expect(store.size).toBe(0);

    await fsPromises.appendFile(fresh, transcriptChunk(20)); // now > 3KB
    await sleep(3300); // tick 2 must re-stat it: it is fresh, not stale
    expect(store.size).toBe(1);
  });
});
