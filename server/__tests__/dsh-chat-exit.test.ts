import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The real exit path, exercised as a subprocess: dsh-chat runs bundled in the
 * PTY (a readline loop with process.exit, so it cannot be imported here). The
 * dsh app is swapped for a fake via LOCALAPPDATA — dshAppPath() resolves to a
 * copy of node running a script that parks forever — and exiting the loop
 * must leave nothing behind: exit code 0 (no crash from the mid-turn kill
 * racing the child's pipes) and no account patch file in the tmpdir.
 *
 * What is NOT asserted, deliberately: that the close handler's kill() is what
 * kills the fake child. On Windows a child spawned with stdio pipes is
 * terminated by the OS when its parent exits even when the parent never calls
 * kill() (verified against the pre-kill build: the fake dies together with
 * the loop and without running its own exit handler), so a "fake is dead"
 * assertion stays green even if running?.kill() is deleted — a formal test.
 * The kill stays as the loop's own guarantee; only observable outcomes here.
 *
 * A /exit typed after the turn started stays buffered while the readline is
 * paused, so it is sent in the same write as the task line; stdin-close
 * (Ctrl+D) is driven as a second case after the turn has really begun.
 */
const CHAT_SCRIPT = path.join(__dirname, '../../dist/hooks/dsh-chat.js');

/** The fake dsh "cli.js": park forever, report the pid so the test can wait
 *  for the turn to have really started (and clean up if a route fails). */
const FAKE_CLI_JS = `const m = process.env.PIXEL_AGENTS_TEST_TURN_PID;
if (m) require('fs').writeFileSync(m, String(process.pid));
setInterval(() => {}, 1000);
`;

// These tests spawn the BUNDLED chat loop, so they need `npm run compile` to
// have run; skipped loudly rather than silently passing on a stale dist.
const notBuilt = !fs.existsSync(CHAT_SCRIPT);
const itBuilt = it.skipIf(notBuilt);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFile(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(50);
  }
  return fs.existsSync(file);
}

function readFakePid(marker: string): number | null {
  try {
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

type ExitRoute = '/exit buffered with the task line' | 'stdin closed (Ctrl+D)';

interface ChatRun {
  chatCode: number | null | 'still running';
  /** Account patch files left in the loop's tmpdir after it exited. */
  patchLeftovers: string[];
  out: string;
  /** Kills the fake child and the chat loop if either is still alive. Call
   *  from the test's finally so a red run never leaves an orphan behind. */
  cleanup: () => Promise<void>;
}

async function runChatLoopExit(route: ExitRoute): Promise<ChatRun> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-dsh-exit-'));
  // Fake app tree: LOCALAPPDATA override makes dshAppPath() point at a node
  // copy whose cli.js is the fake above.
  const appDir = path.join(tmp, 'localappdata', 'Programs', 'DeepSeek Harness');
  fs.mkdirSync(appDir, { recursive: true });
  const exe = path.join(appDir, 'DeepSeek Harness.exe');
  try {
    fs.linkSync(process.execPath, exe);
  } catch {
    fs.copyFileSync(process.execPath, exe);
  }
  const cliJs = path.join(
    appDir,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  fs.mkdirSync(path.dirname(cliJs), { recursive: true });
  fs.writeFileSync(cliJs, FAKE_CLI_JS);

  const marker = path.join(tmp, 'fake-turn.pid');
  const chat = spawn(process.execPath, [CHAT_SCRIPT], {
    // HOME and USERPROFILE both point at tmp so the loop's server discovery
    // finds nothing and no real office is ever contacted.
    env: {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      LOCALAPPDATA: path.join(tmp, 'localappdata'),
      TMP: tmp,
      TEMP: tmp,
      PIXEL_AGENTS_TEST_TURN_PID: marker,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let chatCode: number | null | 'still running' = 'still running';
  chat.once('exit', (code) => {
    chatCode = code;
  });
  let out = '';
  chat.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  chat.stderr?.on('data', (d: Buffer) => (out += d.toString()));

  const cleanup = async (): Promise<void> => {
    const pid = readFakePid(marker);
    if (pid !== null && alive(pid)) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    if (chatCode === 'still running') chat.kill('SIGKILL');
    await sleep(100); // let kills land before the tree goes away
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    if (route === '/exit buffered with the task line') {
      chat.stdin?.write('hello\n/exit\n');
    } else {
      chat.stdin?.write('hello\n');
      const started = await waitFile(marker, 8000);
      if (!started) throw new Error(`fake dsh child never started; chat output: ${out}`);
      chat.stdin?.end();
    }
    const deadline = Date.now() + 6000;
    while (chatCode === 'still running' && Date.now() < deadline) await sleep(50);
  } catch (err) {
    await cleanup();
    throw err;
  }

  // Snapshot the exit state before any cleanup could disturb it.
  return {
    chatCode,
    patchLeftovers: fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith('pixel-agents-dsh-account')),
    out,
    cleanup,
  };
}

describe('dsh-chat -- exiting mid-turn leaves nothing behind', () => {
  itBuilt(
    'buffered /exit exits cleanly with the account patch file deleted',
    async () => {
      const r = await runChatLoopExit('/exit buffered with the task line');
      try {
        expect(r.chatCode, `chat output: ${r.out}`).toBe(0);
        expect(r.patchLeftovers, `chat output: ${r.out}`).toEqual([]);
      } finally {
        await r.cleanup();
      }
    },
    20000,
  );

  itBuilt('Ctrl+D (stdin closed) mid-turn exits cleanly with the patch file deleted', async () => {
    const r = await runChatLoopExit('stdin closed (Ctrl+D)');
    try {
      expect(r.chatCode, `chat output: ${r.out}`).toBe(0);
      expect(r.patchLeftovers, `chat output: ${r.out}`).toEqual([]);
    } finally {
      await r.cleanup();
    }
  }, 20000);
});
