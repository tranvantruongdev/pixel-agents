import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import { loadFurnitureAssets } from '../src/assetLoader.js';

// Manifest width/height arrive untyped from JSON.parse. A zero/non-number
// dimension decodes to a 0-row sprite that crashes the webview outline pass
// (sprite[0].length), and an oversized one allocates width×height cells in the
// decoder. Both paths must skip the asset instead of loading it.

let fixtureRoot: string;

function baseManifest(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'asset',
    id,
    name: id,
    category: 'misc',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    footprintW: 1,
    footprintH: 1,
    width: 16,
    height: 16,
    ...overrides,
  };
}

function writeFurnitureDir(
  name: string,
  manifest: Record<string, unknown>,
  png: Buffer = PNG.sync.write(new PNG({ width: 16, height: 16 })),
): void {
  const dir = path.join(fixtureRoot, 'assets', 'furniture', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  fs.writeFileSync(path.join(dir, `${manifest.id}.png`), png);
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-manifest-dims-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('furniture manifest dimension validation', () => {
  it('loadFurnitureAssets skips assets with zero, mistyped or oversized dimensions', async () => {
    writeFurnitureDir('ok_16', baseManifest('ok_16', {}));
    writeFurnitureDir('zero', baseManifest('zero', { width: 0, height: 0 }));
    writeFurnitureDir('string', baseManifest('string', { width: '16', height: 16 }));
    writeFurnitureDir('oversized', baseManifest('oversized', { width: 4000, height: 4000 }));

    const loaded = await loadFurnitureAssets(fixtureRoot);

    expect(loaded?.catalog.map((a) => a.id)).toEqual(['ok_16']);
    expect(loaded?.sprites.has('ok_16')).toBe(true);
    expect(loaded?.sprites.has('zero')).toBe(false);
    expect(loaded?.sprites.has('string')).toBe(false);
    expect(loaded?.sprites.has('oversized')).toBe(false);
  });

  it('buildFurnitureCatalog skips invalid dimensions (single assets and group members)', () => {
    writeFurnitureDir('cat_ok', baseManifest('cat_ok', {}));
    writeFurnitureDir('cat_zero', baseManifest('cat_zero', { width: 0, height: 0 }));
    writeFurnitureDir('cat_huge', baseManifest('cat_huge', { width: 4000, height: 4000 }));
    writeFurnitureDir('cat_group', {
      type: 'group',
      groupType: 'rotation',
      id: 'cat_group',
      name: 'cat_group',
      category: 'misc',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
      members: [
        {
          type: 'asset',
          id: 'gm_bad',
          file: 'gm_bad.png',
          width: 4000,
          height: 16,
          footprintW: 1,
          footprintH: 1,
        },
        {
          type: 'asset',
          id: 'gm_ok',
          file: 'gm_ok.png',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
        },
      ],
    });

    const catalog = buildFurnitureCatalog(path.join(fixtureRoot, 'assets'));

    expect(catalog.map((e) => e.id).sort()).toEqual(['cat_ok', 'gm_ok']);
  });
});
