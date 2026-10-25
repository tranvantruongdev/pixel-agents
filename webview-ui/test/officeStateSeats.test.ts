/**
 * Seat-lifecycle tests for OfficeState.rebuildFromLayout.
 *
 * removeAgent() frees the character's seat immediately but keeps the character
 * in the map for the 0.3s matrix despawn. Every editor stroke tile commits a
 * rebuildFromLayout, so a rebuild landing inside that window must not hand the
 * seat back to the leaving character: nobody would free it again once the
 * despawn completes, and the seat would stay assigned forever.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

beforeAll(() => {
  const catalog: CatalogAsset[] = [
    {
      id: 'CHAIR_FRONT',
      label: 'Chair',
      category: 'chairs',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 2,
      isDesk: false,
      backgroundTiles: 1,
    },
  ];
  const sprites = Object.fromEntries(catalog.map((a) => [a.id, [['']]]));
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

/** All-floor layout with a single 1x2 chair — one seat at (4, 4). */
function chairLayout(): OfficeLayout {
  const cols = 9;
  const rows = 7;
  const furniture: PlacedFurniture[] = [{ uid: 'chair1', type: 'CHAIR_FRONT', col: 4, row: 3 }];
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
}

test('a rebuild inside the despawn window does not re-claim the freed seat', () => {
  const os = new OfficeState(chairLayout());
  assert.equal(os.seats.size, 1, 'the chair provides exactly one seat');
  os.addAgent(1);
  assert.equal(os.characters.get(1)!.seatId, 'chair1');

  os.removeAgent(1); // frees the seat, character despawns over 0.3s
  assert.equal(os.seats.get('chair1')!.assigned, false);

  // One tile of an editor stroke — the rebuild every edit commits.
  os.rebuildFromLayout(chairLayout());
  assert.equal(
    os.seats.get('chair1')!.assigned,
    false,
    'the leaving character must not re-claim its seat',
  );

  // Despawn completes and the character is gone…
  for (let i = 0; i < 12; i++) os.update(0.05);
  assert.equal(os.characters.size, 0);

  // …so the next agent can sit there instead of standing forever.
  os.addAgent(2);
  assert.equal(os.characters.get(2)!.seatId, 'chair1');
});
