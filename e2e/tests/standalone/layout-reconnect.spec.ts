import type { Frame } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import {
  enterEditMode,
  paintTile,
  selectWallTool,
  type TestHooksWindow,
  TILE,
} from '../../helpers/editor';

// WebSocketTransport reconnects with capped exponential backoff (up to 4s);
// allow a couple of retry cycles for the drop and the reconnection to settle.
const CONNECTION_STATE_TIMEOUT_MS = 15_000;

async function readTile(frame: Frame, col: number, row: number): Promise<number | undefined> {
  return await frame.evaluate(
    ([c, r]) => {
      const t = (window as unknown as TestHooksWindow).__pixelAgentsTestHooks?.getTiles?.();
      return t?.tiles[r * t.cols + c];
    },
    [col, row] as const,
  );
}

test.describe('Standalone / layout reconnect', () => {
  /**
   * The message effect in useExtensionMessages registers its handler once, so
   * the `isEditDirty` callback it captured at mount always reports a clean
   * editor. A WebSocket reconnect replays layoutLoaded (the transport
   * re-sends webviewReady on CONNECTED), and the stale callback lets that
   * replay clobber a layout with unsaved edits. Reproduce exactly that: paint
   * a tile in the editor (dirty, unsaved), drop the socket by stopping the
   * host, restart it, and require the painted tile to still be there after
   * the replay was processed.
   *
   * The host is stopped immediately after the paint so the 500ms save debounce
   * cannot persist the edit first — and even a debounced send that fires while
   * offline only joins the pending queue, which onopen flushes AFTER the
   * CONNECTED notification sends webviewReady, so the replayed layout is
   * always the pre-edit one the server holds.
   */
  test('an unsaved layout edit survives a WebSocket reconnect @area:standalone', async ({
    page,
    standalone,
  }) => {
    const frame = page.mainFrame();
    await standalone.drainMessages();

    await enterEditMode(frame);
    await selectWallTool(frame);

    // Paint over the first plain floor tile away from the borders, so the
    // before/after values are unambiguous regardless of the default layout.
    const target = await frame.evaluate((floor: number) => {
      const t = (window as unknown as TestHooksWindow).__pixelAgentsTestHooks?.getTiles?.();
      if (!t) return null;
      for (let r = 2; r < t.rows - 2; r++) {
        for (let c = 2; c < t.cols - 2; c++) {
          if (t.tiles[r * t.cols + c] === floor) return { col: c, row: r };
        }
      }
      return null;
    }, TILE.FLOOR_1);
    expect(target, 'a plain floor tile to paint over').not.toBeNull();
    const { col, row } = target!;

    await paintTile(frame, col, row);
    await expect.poll(() => readTile(frame, col, row)).toBe(TILE.WALL);

    // Drop the socket from the server side (context.setOffline does not
    // reliably close an open WebSocket on this Chromium build) and bring the
    // host back on the same port so the page's reconnect ladder re-attaches.
    await standalone.stopHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toBeVisible({
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });
    await standalone.startHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toHaveCount(0, {
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });

    // Wait until the replayed layoutLoaded has actually arrived, so the
    // assertion below runs after the clobber would have landed.
    await expect
      .poll(async () => (await standalone.drainMessages()).some((m) => m.type === 'layoutLoaded'), {
        timeout: CONNECTION_STATE_TIMEOUT_MS,
      })
      .toBe(true);

    await expect
      .poll(() => readTile(frame, col, row), { timeout: CONNECTION_STATE_TIMEOUT_MS })
      .toBe(TILE.WALL);
  });
});
