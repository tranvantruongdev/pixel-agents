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
import { getCharacterSprites, setCharacterTemplates } from '../src/office/sprites/spriteData.js';
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

/**
 * A layout's live working set (per-cell floor/wall colors, carpet palettes,
 * per-instance furniture colors) can exceed half the cap, and those keys are
 * asked for again every frame while colour sliders mint a fresh key per
 * intermediate drag value. Eviction must follow recency of USE, not of
 * insertion (LRU): a key re-hit between churn batches keeps its cached
 * identity, while the never-reused churn keys are the ones dropped —
 * otherwise a working set near the cap is deleted and recomputed every frame.
 */
describe('sprite cache LRU', () => {
  const HALF_CAP = SPRITE_CACHE_MAX_ENTRIES / 2;

  it('colorizeCache keeps a re-hit entry when churn mints more keys than the cap', () => {
    clearColorizeCache();
    const sprite: SpriteData = [['#FF0000']];
    const live = (i: number) => getColorizedSprite(`live${i}`, sprite, colorOf(i));
    for (let i = 0; i < HALF_CAP; i++) live(i);
    const hot = live(0);
    // Slider drag: one fresh key per intermediate value, more than the whole
    // cap, with the working set still rendered between the batches.
    for (let i = 0; i < SPRITE_CACHE_MAX_ENTRIES + 1; i++) {
      getColorizedSprite(`churn${i}`, sprite, colorOf((i % 300) + 20));
      live(0);
    }
    expect(live(0)).toBe(hot);
  });

  it('carpetCache keeps a re-hit entry when colour churn exceeds the cap', () => {
    const base: SpriteData = [
      ['#111111', '#EEEEEE'],
      ['#111111', '#EEEEEE'],
    ];
    setCarpetSprites([Array.from({ length: 16 }, () => base)]);
    const carpetTiles: Array<{ variant: number; color: ColorValue } | null> = new Array(9).fill(
      null,
    );
    const junction = (i: number) => {
      const color = colorOf(i);
      carpetTiles[4] = { variant: 0, color };
      return getCarpetJunctionSprite(1, 1, 0, carpetTiles, 3, 3, color, CARPET_DEFAULT_ACCENT_COLOR);
    };
    for (let i = 0; i < HALF_CAP; i++) junction(i);
    const hot = junction(0);
    for (let i = 0; i < SPRITE_CACHE_MAX_ENTRIES + 1; i++) {
      junction(i + SPRITE_CACHE_MAX_ENTRIES);
      junction(0);
    }
    expect(junction(0)).toBe(hot);
  });

  it('character spriteCache keeps a re-hit agent when churn mints more keys than the cap', () => {
    // Synthetic 1x1 templates keep the misses cheap (7 frames per direction:
    // 3 walk + 2 typing + 2 reading); distinct palette indexes mint distinct
    // keys through the same public API as live agents.
    const frames = () => Array.from({ length: 7 }, () => [['#FF0000']] as SpriteData);
    setCharacterTemplates([{ down: frames(), up: frames(), right: frames() }]);
    const hot = getCharacterSprites(0, 0);
    for (let i = 0; i < SPRITE_CACHE_MAX_ENTRIES + 1; i++) {
      getCharacterSprites(i + 1, 0);
      getCharacterSprites(0, 0);
    }
    expect(getCharacterSprites(0, 0)).toBe(hot);
  });
});
