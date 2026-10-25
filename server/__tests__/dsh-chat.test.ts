import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { patchFilePath } from '../src/providers/hook/dsh/dsh.js';

/**
 * The chat loop writes its account patch to the tmpdir once at startup and
 * every dsh child reads it back via --patch at turn start. One fixed file
 * name shared by all loops meant one loop's rewrite could hand another loop's
 * child a torn, half-written yml — the name must be per-instance instead.
 *
 * The loop's exit behaviour (kill the running turn, delete this file) is
 * covered end-to-end by dsh-chat-exit.test.ts against the bundled script.
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
