import type { Frame } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import {
  enterEditMode,
  paintTile,
  readFurniture,
  selectWallTool,
  TILE,
  undo,
  type TestHooksWindow,
} from '../../helpers/editor';

interface GridSnapshot {
  cols: number;
  rows: number;
  tiles: number[];
}async function readGrid(frame: Frame): Promise<GridSnapshot> {
  return await frame.evaluate(() => {
    const t = (window as unknown as TestHooksWindow).__pixelAgentsTestHooks?.getTiles?.();
    return { cols: t?.cols ?? 0, rows: t?.rows ?? 0, tiles: t ? [...t.tiles] : [] };
  });
}

test.describe('Standalone / layout expand undo', () => {
  /**
   * The first tile of a paint stroke on the ghost border expands the grid by
   * one column/row. That expansion used to be committed with a direct
   * `os.rebuildFromLayout` BEFORE the stroke's commitLayout ran, so the undo
   * entry the stroke pushed captured the already-expanded layout: Ctrl+Z
   * reverted the painted tile but the grid stayed big. The expansion must ride
   * the same undo entry as the paint (one gesture = one entry, the stroke
   * convention), so one undo restores both the tile and the grid bounds — and
   * redo restores both again.
   */
  test('one undo reverts a ghost-border paint together with the grid expansion @area:standalone', async ({
    page,
    standalone,
  }) => {
    const frame = page.mainFrame();
    await standalone.drainMessages();

    await enterEditMode(frame);
    await selectWallTool(frame);

    const before = {
      grid: await readGrid(frame),
      furniture: await readFurniture(frame),
    };
    expect(before.grid.cols).toBeGreaterThan(0);

    // Paint one tile LEFT of the grid — a ghost-border cell. Expanding left
    // shifts existing content right by one column, so the wall lands on
    // shifted coordinate col 0.
    const targetRow = Math.floor(before.grid.rows / 2);
    await paintTile(frame, -1, targetRow);

    await expect.poll(async () => (await readGrid(frame)).cols).toBe(before.grid.cols + 1);
    const afterPaint = {
      grid: await readGrid(frame),
      furniture: await readFurniture(frame),
    };
    expect(afterPaint.grid.tiles[targetRow * afterPaint.grid.cols]).toBe(TILE.WALL);

    await undo(frame);

    await expect.poll(() => readGrid(frame)).toEqual(before.grid);
    await expect.poll(() => readFurniture(frame)).toEqual(before.furniture);

    // Redo must restore the expansion and the wall together, exactly as they
    // were right after the stroke.
    await frame.locator('button', { hasText: 'Redo' }).click();

    await expect.poll(() => readGrid(frame)).toEqual(afterPaint.grid);
    await expect.poll(() => readFurniture(frame)).toEqual(afterPaint.furniture);
  });
});
