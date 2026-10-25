import { expect, test } from '../../fixtures/standalone';
import {
  enterEditMode,
  readAreas,
  selectAreaTool,
  undo,
} from '../../helpers/editor';
import { buildSeedLayout } from '../../helpers/layout-seed';

const AREA = 'Engineering';
const ORIGINAL = '#ff6b6b';
const SEEDED_LAYOUT = buildSeedLayout({
  areas: [{ label: AREA, color: ORIGINAL }],
  areaTiles: [{ col: 1, row: 1, label: AREA }],
});

test.describe('Standalone / area color undo', () => {
  test.use({ standaloneOptions: { seedLayout: SEEDED_LAYOUT } });

  /**
   * The native color input streams an `input` event per picker adjustment
   * while it is open, so one drag arrives as a run of onChange calls. Like the
   * wall color slider (commitLayout session 'wallColor') and a selected
   * furniture item's sliders (session `color:<uid>`), the whole run must
   * collapse into ONE undo entry — otherwise Ctrl+Z after picking a color
   * steps back through every intermediate color instead of restoring the one
   * the run started from.
   */
  test('a color-picker run collapses into one undo entry @area:standalone', async ({
    page,
    standalone,
  }) => {
    const frame = page.mainFrame();
    await enterEditMode(frame);
    await selectAreaTool(frame);

    const color = async () => (await readAreas(frame)).find((a) => a.label === AREA)?.color;
    expect(await color()).toBe(ORIGINAL);

    // Two streamed input events from the OS picker stand in for one drag.
    const input = frame.locator('input[type="color"]');
    await input.fill('#00ff00');
    await input.fill('#0000ff');
    await expect.poll(color).toBe('#0000ff');

    await undo(frame);

    // One undo restores the color the run started from.
    await expect.poll(color).toBe(ORIGINAL);
  });
});
