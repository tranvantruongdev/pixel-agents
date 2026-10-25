import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';

import { killRunningTurn } from '../src/providers/hook/dsh/dsh.js';

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
