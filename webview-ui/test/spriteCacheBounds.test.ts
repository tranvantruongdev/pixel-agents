/**
 * Bounds on the three sprite-recolor caches (colorize.ts, carpetTiles.ts,
 * spriteData.ts).
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * it pins a memory invariant the same way webSocketTransport.test.ts pins the
 * offline send queue — a long editing session, not a single gesture, is what
 * exposes it. Each cache is keyed by full color values (or a per-agent random
 * hue shift), and the colour sliders mint a fresh key per intermediate drag
 * value, so an unbounded cache grows for the whole session. The bound is
 * observed through the cache's own behavior, not its internals: once more
 * distinct keys than SPRITE_CACHE_MAX_ENTRIES have been minted, the OLDEST
 * entry must have been dropped, so asking for it again returns a fresh
 * compute (a new object), not the originally cached one.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import type { ColorValue } from '../src/components/ui/types.js';
import { CARPET_DEFAULT_ACCENT_COLOR, SPRITE_CACHE_MAX_ENTRIES } from '../src/constants.js';
import { clearColorizeCache, getColorizedSprite } from '../src/office/colorize.js';
import { getCarpetJunctionSprite, setCarpetSprites } from '../src/office/sprites/carpetTiles.js';
import { getCharacterSprites } from '../src/office/sprites/spriteData.js';
import type { SpriteData } from '../src/office/types.js';

/** Distinct keys minted past the cap — enough over to prove the oldest entry
 *  was dropped, whatever the eviction details. */
const OVER_CAP = 200;

/** Distinct key minted #i — hue plus a saturation step keeps pairs unique well
 *  past the cap (a hue alone only gives 360). */
function colorOf(i: number): ColorValue {
  return { h: i % 360, s: 40 + Math.floor(i / 360), b: 0, c: 0 };
}

describe('sprite cache bounds', () => {
  it('colorizeCache evicts the oldest entry past the cap', () => {
    clearColorizeCache();
    const sprite: SpriteData = [['#FF0000']];
    const first = getColorizedSprite('oldest', sprite, colorOf(0));
    for (let i = 0; i < SPRITE_CACHE_MAX_ENTRIES + OVER_CAP; i++) {
      getColorizedSprite(`k${String(i)}`, sprite, colorOf((i % 359) + 1));
    }
    // 'oldest' was inserted first; past the cap it must have been dropped and
    // recomputed (a new object) rather than retained for the whole session.
    expect(getColorizedSprite('oldest', sprite, colorOf(0))).not.toBe(first);
  });

  it('carpetCache evicts the oldest entry past the cap', () => {
    // One variant, one sprite per marching-squares case, two shades so the
    // palette classification yields a main and an accent layer.
    const base: SpriteData = [
      ['#111111', '#EEEEEE'],
      ['#111111', '#EEEEEE'],
    ];
    setCarpetSprites([Array.from({ length: 16 }, () => base)]);
    // A 3x3 grid whose (1,1) cell is a variant-0 carpet: junction (1,1) has a
    // non-zero case, so each call resolves (and caches) a merged sprite. The
    // junction's palette key is matched against the TILE's color, so each
    // iteration repaints the tile too — one distinct cache key per call.
    const carpetTiles: Array<{ variant: number; color: ColorValue } | null> = new Array(9).fill(
      null,
    );
    carpetTiles[4] = { variant: 0, color: colorOf(0) };
    const junction = (i: number) => {
      const color = colorOf(i);
      carpetTiles[4] = { variant: 0, color };
      return getCarpetJunctionSprite(1, 1, 0, carpetTiles, 3, 3, color, CARPET_DEFAULT_ACCENT_COLOR);
    };
    const first = junction(0);
    for (let i = 0; i < SPRITE_CACHE_MAX_ENTRIES + OVER_CAP; i++) {
      junction(i + 1);
    }
    expect(junction(0)).not.toBe(first);
  });

  it('character spriteCache evicts the oldest entry past the cap', () => {
    // Hue shift 1 is the oldest entry; later agents (each past the first
    // palette round gets a random hue) push it out.
    const first = getCharacterSprites(0, 1);
    for (let i = 0; i < SPRITE_CACHE_MAX_ENTRIES + OVER_CAP; i++) {
      getCharacterSprites(0, i + 2);
    }
    expect(getCharacterSprites(0, 1)).not.toBe(first);
  });
});
