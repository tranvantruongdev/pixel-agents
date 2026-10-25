/**
 * The clipboard wiring on a terminal pane (rules in clipboardKeys.ts),
 * through a structural Terminal: "Copy as text" must feed flowCopy the
 * selection's TRUE starting column. xterm's selection position columns are
 * 0-based (same cells select() takes and the touch path's CellRange uses),
 * so the boundary wrap decision has to key off start.x as-is.
 */

import type { Terminal } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { writeClipboardText } from '../src/terminal/clipboard.js';
import { attachClipboardInput } from '../src/terminal/clipboardInput.js';

vi.mock('../src/terminal/clipboard.js', () => ({
  writeClipboardText: vi.fn(async () => true),
}));

interface FakeTermOptions {
  cols: number;
  selection: string;
  /** 0-based column the selection starts at (getSelectionPosition().start.x). */
  startX: number;
}

/** The slice of Terminal attachClipboardInput touches, structurally. */
function fakeTerm({ cols, selection, startX }: FakeTermOptions): {
  term: Terminal;
  press: (ev: Record<string, unknown>) => boolean | void;
} {
  let handler: ((ev: Record<string, unknown>) => boolean | void) | null = null;
  const term = {
    cols,
    hasSelection: () => true,
    getSelection: () => selection,
    getSelectionPosition: () => ({ start: { x: startX, y: 10 }, end: { x: 3, y: 11 } }),
    clearSelection: () => {},
    attachCustomKeyEventHandler: (fn: (ev: Record<string, unknown>) => boolean | void) => {
      handler = fn;
    },
    parser: { registerOscHandler: () => ({ dispose: () => {} }) },
  } as unknown as Terminal;
  return { term, press: (ev) => handler?.(ev) };
}

const ALT_C_KEYDOWN = {
  type: 'keydown',
  key: 'c',
  code: 'KeyC',
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  cancelable: true,
  preventDefault: () => {},
};

/** One macrotask: the clipboard write's promise chain settles within it. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('clipboardInput: Copy as text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('joins a wrap whose first word lands exactly at the flow boundary', async () => {
    // cols 40 -> flowWidth 36. The first line fills 33 cells starting at
    // column 2 (row width 35), so the 1-char first word of "  x more" does
    // NOT fit (35 + 1 + 1 > 36): the rows were soft-wrapped and must join.
    // Reading the column as 1-based (startX - 1) measures 34, fits exactly,
    // and wrongly keeps the newline -- the regression this pins.
    const { term, press } = fakeTerm({
      cols: 40,
      selection: `${'A'.repeat(33)}\n  x more`,
      startX: 2,
    });
    const detach = attachClipboardInput(term, { isActive: () => true });
    press(ALT_C_KEYDOWN);
    await flush();
    detach();

    expect(vi.mocked(writeClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeClipboardText).mock.calls[0]?.[0]).toBe(`${'A'.repeat(33)} x more`);
  });

  it('copies verbatim selections untouched', async () => {
    const { term, press } = fakeTerm({
      cols: 40,
      selection: 'raw\n  selection',
      startX: 4,
    });
    const detach = attachClipboardInput(term, { isActive: () => true });
    press({ ...ALT_C_KEYDOWN, altKey: false, ctrlKey: true, shiftKey: true });
    await flush();
    detach();

    expect(vi.mocked(writeClipboardText).mock.calls[0]?.[0]).toBe('raw\n  selection');
  });
});
