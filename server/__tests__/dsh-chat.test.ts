import { spawn } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { killRunningTurn, patchFilePath } from '../src/providers/hook/dsh/dsh.js';

/**
 * dsh-chat.ts is a top-level script (a readline loop with its own
 * process.exit), so it cannot be imported under vitest. The exit path's logic
 * lives in this exported helper instead: /exit and Ctrl+D close the loop even
 * while a headless turn is mid-run, and the close handler must kill that turn
 * — otherwise the dsh child outlives the chat loop as an orphan that keeps
 * spending account credit. The Ctrl+C path already killed it; close did not.
 */
describe('dsh-chat -- closing the loop kills a running headless turn', () => {
  it('kills a child that is still running', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => child.once('spawn', resolve));

    killRunningTurn(child);

    // Never resolves when the kill is missing; the test timeout then fails it.
    await exited;
  });

  it('is a no-op when no turn is running', () => {
    expect(() => killRunningTurn(undefined)).not.toThrow();
  });

  it('tolerates a second call on a dying child (Ctrl+C mid-turn, then /exit)', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => child.once('spawn', resolve));

    killRunningTurn(child);
    expect(() => killRunningTurn(child)).not.toThrow();
    await exited;
  });
});

/**
 * The chat loop writes its account patch to the tmpdir once at startup and
 * every dsh child reads it back via --patch at turn start. One fixed file
 * name shared by all loops meant one loop's rewrite could hand another loop's
 * child a torn, half-written yml — the name must be per-instance instead.
 */
describe('dsh-chat -- account patch file is per-instance', () => {
  it('two simultaneous loops never share one patch file path', () => {
    const tmp = path.join('T', 'mp');
    expect(patchFilePath(tmp, 111)).not.toBe(patchFilePath(tmp, 222));
  });

  it('keeps a stable name within one instance', () => {
    const tmp = path.join('T', 'mp');
    expect(patchFilePath(tmp, 42)).toBe(path.join(tmp, 'pixel-agents-dsh-account-42.yml'));
    expect(patchFilePath(tmp, 42)).toBe(patchFilePath(tmp, 42));
  });
});
