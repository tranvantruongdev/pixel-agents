/**
 * Render-loop performance benchmark + render-equivalence gate.
 *
 * Measures the per-frame JS cost of the office renderer against the largest
 * valid layout (64×64 grid — MAX_COLS/MAX_ROWS — walls, ~150 furniture items,
 * 20 agents, 3 pets, ~1100 carpet tiles, 2 areas) with a mock canvas context:
 *
 *   - ms/frame per layer + full renderFrame + OfficeState.update
 *   - allocation churn: minor-GC count/time + heap growth over N frames
 *
 * The gate test records the full canvas-op stream (every property set and
 * call, mock canvases identified by creation order) for 3 identical frames and
 * requires every frame to hash the same. GOLDEN pins that hash: it was
 * captured before any perf change, so any fix that alters what the renderer
 * draws (pixels, op order, styles) fails here. To re-capture, set GOLDEN to
 * null, run this file, and paste the printed JSON back in.
 *
 * Run: cd webview-ui && npx vitest run test/renderPerf.test.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PerformanceObserver } from 'node:perf_hooks';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import {
  renderAreaLabels,
  renderAreaOverlay,
  renderCarpetLayer,
  renderFrame,
  renderScene,
  renderTileGrid,
} from '../src/office/engine/renderer.js';
import { setFloorSprites } from '../src/office/floorTiles.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import { mapOffset } from '../src/office/projection.js';
import { setCarpetSprites } from '../src/office/sprites/carpetTiles.js';
import { setPetTemplates } from '../src/office/sprites/petSpriteData.js';
import { setCharacterTemplates } from '../src/office/sprites/spriteData.js';
import type {
  CarpetTile,
  ColorValue,
  OfficeLayout,
  PlacedFurniture,
  SpriteData,
  TileType as TileTypeVal,
} from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';
import { getWallInstances, setWallSprites } from '../src/office/wallTiles.js';

// ── Golden render gate ─────────────────────────────────────────
// null → the gate prints the digest instead of asserting (capture mode).

interface RenderDigest {
  hash: string;
  counts: Record<string, number>;
  canvases: number;
}
/** Captured from the pre-optimization renderer — the fix must reproduce it. */
const GOLDEN: RenderDigest | null = {
  hash: '0f5b99f136415eecf8318a7712be57ead3de9c9628f82355aac6cd225798b834',
  counts: {
    clearRect: 1,
    '@fillStyle': 1742,
    fillRect: 1738,
    drawImage: 5077,
    save: 5,
    '@globalAlpha': 1319,
    restore: 5,
    '@font': 1,
    '@textAlign': 1,
    '@textBaseline': 1,
    fillText: 4,
  },
  canvases: 79,
};

// ── Mock canvas + contexts ─────────────────────────────────────

let nextCanvasId = 0;

interface MockCanvas {
  _id: number;
  width: number;
  height: number;
  getContext: () => unknown;
}

function installDocumentMock(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: (): MockCanvas => ({
      _id: nextCanvasId++,
      width: 0,
      height: 0,
      getContext: () => makeNullCtx(),
    }),
  };
}

/** No-op context: every method is a sink, every property settable. */
function makeNullCtx(): unknown {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
}

/** Recording context: every property set and method call becomes one op. */
type Op = unknown[];

function makeRecordingCtx(ops: Op[]): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  const fmt = (value: unknown): unknown => {
    if (typeof value === 'number') return Math.round(value * 1000) / 1000;
    if (value && typeof value === 'object' && '_id' in (value as object)) {
      return `c${(value as { _id: number })._id}`;
    }
    return value;
  };
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      return (...args: unknown[]): void => {
        ops.push([prop, ...args.map(fmt)]);
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      ops.push([`@${prop}`, fmt(value)]);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function digestFrame(ops: Op[]): RenderDigest {
  const counts: Record<string, number> = {};
  const hash = createHash('sha256');
  for (const op of ops) {
    const name = String(op[0]);
    counts[name] = (counts[name] ?? 0) + 1;
    hash.update(op.map(String).join('\u0001'));
    hash.update('\u0002');
  }
  return { hash: hash.digest('hex'), counts, canvases: nextCanvasId };
}

// ── Deterministic scenario ─────────────────────────────────────

const COLS = 64;
const ROWS = 64;
const ZOOM = 2;
const CANVAS_W = 1600;
const CANVAS_H = 1200;

let seed = 0;
function seededRandom(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function makeSprite(w: number, h: number, base: string, accent: string): SpriteData {
  const rows: SpriteData = [];
  for (let r = 0; r < h; r++) {
    const row: string[] = [];
    for (let c = 0; c < w; c++) {
      row.push((r + c) % 2 === 0 ? base : accent);
    }
    rows.push(row);
  }
  return rows;
}

function loadSyntheticAssets(): void {
  // Floors: 3 grayscale 16×16 patterns (colorize does real per-pixel work once).
  setFloorSprites([
    makeSprite(16, 16, '#9a9a9a', '#8a8a8a'),
    makeSprite(16, 16, '#b4b4b4', '#a0a0a0'),
    makeSprite(16, 16, '#7c7c7c', '#6c6c6c'),
  ]);
  // Walls: 16 sprites, one per 4-bit neighbor mask.
  setWallSprites(
    Array.from({ length: 16 }, (_, mask) => makeSprite(16, 16, `#${(0x88 + mask).toString(16)}9090`, '#707070')),
  );
  // Carpets: 1 variant × 16 marching-squares cases, two-tone.
  setCarpetSprites([
    Array.from({ length: 16 }, () => makeSprite(16, 16, '#202020', '#e0e0e0')),
  ]);
  // Characters: 2 palettes × down/up/right × 7 frames (walk 0-2, type 3-4, read 5-6).
  setCharacterTemplates(
    [0, 1].map((p) => ({
      down: Array.from({ length: 7 }, () => makeSprite(16, 24, `#${(0x30 + p * 16).toString(16)}a0c0`, '#f0d0b0')),
      up: Array.from({ length: 7 }, () => makeSprite(16, 24, `#${(0x28 + p * 16).toString(16)}90b0`, '#e8c8a8')),
      right: Array.from({ length: 7 }, () => makeSprite(16, 24, `#${(0x38 + p * 16).toString(16)}a8c8`, '#f0d0b0')),
    })),
  );
  // Pets: 2 types × 3 frames per direction.
  setPetTemplates(
    [0, 1].map((p) => ({
      walkDown: Array.from({ length: 3 }, () => [makeSprite(12, 12, `#c0${p ? '60' : '80'}40`, '#504030')]),
      idleDown: Array.from({ length: 3 }, () => [makeSprite(12, 12, `#c0${p ? '60' : '80'}40`, '#504030')]),
      walkUp: Array.from({ length: 3 }, () => [makeSprite(12, 12, `#b0${p ? '50' : '70'}30`, '#403020')]),
      idleUp: Array.from({ length: 3 }, () => [makeSprite(12, 12, `#b0${p ? '50' : '70'}30`, '#403020')]),
      walkRight: Array.from({ length: 3 }, () => [makeSprite(12, 12, `#a0${p ? '40' : '60'}20`, '#302010')]),
    })),
  );
  // Furniture catalog: desk, chair, plant, shelf, monitor off/on (animated on-state).
  buildDynamicCatalog({
    catalog: [
      { id: 'desk', label: 'Desk', category: 'desks', width: 32, height: 16, footprintW: 2, footprintH: 1, isDesk: true },
      { id: 'chair', label: 'Chair', category: 'chairs', width: 16, height: 16, footprintW: 1, footprintH: 1, isDesk: false },
      { id: 'plant', label: 'Plant', category: 'decor', width: 16, height: 16, footprintW: 1, footprintH: 1, isDesk: false },
      { id: 'shelf', label: 'Shelf', category: 'storage', width: 32, height: 32, footprintW: 2, footprintH: 2, isDesk: false },
      { id: 'monitor_off', label: 'Monitor', category: 'electronics', width: 16, height: 16, footprintW: 1, footprintH: 1, isDesk: false, groupId: 'mon', orientation: 'front', state: 'off' },
      { id: 'monitor_on', label: 'Monitor on', category: 'electronics', width: 16, height: 16, footprintW: 1, footprintH: 1, isDesk: false, groupId: 'mon', orientation: 'front', state: 'on', animationGroup: 'mon-anim', frame: 0 },
      { id: 'monitor_on_2', label: 'Monitor on 2', category: 'electronics', width: 16, height: 16, footprintW: 1, footprintH: 1, isDesk: false, groupId: 'mon', orientation: 'front', state: 'on', animationGroup: 'mon-anim', frame: 1 },
    ],
    sprites: {
      desk: makeSprite(32, 16, '#8a6a4a', '#6a4a2a'),
      chair: makeSprite(16, 16, '#4a6a8a', '#2a4a6a'),
      plant: makeSprite(16, 16, '#3a7a3a', '#2a5a2a'),
      shelf: makeSprite(32, 32, '#7a5a3a', '#5a3a1a'),
      monitor_off: makeSprite(16, 16, '#404040', '#202020'),
      monitor_on: makeSprite(16, 16, '#60a060', '#204020'),
      monitor_on_2: makeSprite(16, 16, '#70b070', '#305030'),
    },
  });
}

function buildLayout(): OfficeLayout {
  const tiles: TileTypeVal[] = new Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      tiles[r * COLS + c] = ((((r * 7 + c * 3) % 3) + 1) as TileTypeVal);
    }
  }
  for (let c = 0; c < COLS; c++) {
    tiles[c] = TileType.WALL;
    tiles[(ROWS - 1) * COLS + c] = TileType.WALL;
  }
  for (let r = 0; r < ROWS; r++) {
    tiles[r * COLS] = TileType.WALL;
    tiles[r * COLS + COLS - 1] = TileType.WALL;
  }
  // Interior wall segments (mid-room dividers)
  for (let r = 2; r <= 20; r++) tiles[r * COLS + 32] = TileType.WALL;
  for (let r = 44; r <= 62; r++) tiles[r * COLS + 32] = TileType.WALL;
  for (let c = 2; c <= 20; c++) tiles[32 * COLS + c] = TileType.WALL;
  for (let c = 44; c <= 62; c++) tiles[32 * COLS + c] = TileType.WALL;
  // VOID corner block
  for (let r = 56; r <= 62; r++) {
    for (let c = 2; c <= 10; c++) tiles[r * COLS + c] = TileType.VOID;
  }

  const tileColors: Array<ColorValue | null> = tiles.map((t, idx) => {
    if (t === TileType.WALL) return { h: (idx % 2) * 200 + 10, s: 30, b: 0, c: 0 };
    if (idx % 5 === 0) return { h: 210, s: 40, b: 5, c: 0 };
    if (idx % 9 === 0) return { h: 120, s: 25, b: -5, c: 0 };
    return null;
  });

  const furniture: PlacedFurniture[] = [];
  let uid = 0;
  const add = (type: string, col: number, row: number): void => {
    furniture.push({ uid: `f${uid++}`, type, col, row });
  };
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      const x = 3 + gx * 9;
      const y = 4 + gy * 13;
      add('desk', x, y);
      add('chair', x, y + 1);
      add('monitor_off', x + 3, y);
      add('plant', x + 5, y + 2);
      if (gy % 2 === 0) add('shelf', x + 6, y + 4);
    }
  }

  const carpetTiles: Array<CarpetTile | null> = new Array(COLS * ROWS).fill(null);
  for (let r = 8; r <= 20; r++) {
    for (let c = 2; c <= 30; c++) {
      carpetTiles[r * COLS + c] = { variant: 0, color: { h: 200, s: 50, b: 0, c: 0 }, accentColor: { h: 45, s: 70, b: 10, c: 0 } };
    }
  }
  for (let r = 8; r <= 20; r++) {
    for (let c = 36; c <= 60; c++) {
      carpetTiles[r * COLS + c] = { variant: 0, color: { h: 0, s: 60, b: -10, c: 0 }, accentColor: { h: 0, s: 0, b: 60, c: 0 }, order: 1 };
    }
  }
  for (let r = 44; r <= 50; r++) {
    for (let c = 36; c <= 50; c++) {
      carpetTiles[r * COLS + c] = { variant: 0, color: { h: 280, s: 30, b: 0, c: 0 }, accentColor: { h: 90, s: 40, b: 5, c: 0 } };
    }
  }

  const areaTiles: Array<string | null> = new Array(COLS * ROWS).fill(null);
  for (let r = 3; r <= 24; r++) {
    for (let c = 1; c <= 31; c++) areaTiles[r * COLS + c] = 'A';
  }
  for (let r = 40; r <= 60; r++) {
    for (let c = 33; c <= 62; c++) areaTiles[r * COLS + c] = 'B';
  }

  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles,
    furniture,
    tileColors,
    carpetTiles,
    areas: [
      { label: 'A', color: '#ff8800' },
      { label: 'B', color: '#33ccff' },
    ],
    areaTiles,
    pets: [
      { id: 'p1', petType: 0 },
      { id: 'p2', petType: 1 },
      { id: 'p3', petType: 0 },
    ],
  };
}

interface Scenario {
  state: OfficeState;
  layout: OfficeLayout;
  selection: {
    selectedAgentId: number | null;
    hoveredAgentId: number | null;
    hoveredTile: { col: number; row: number } | null;
    seats: OfficeState['seats'];
    characters: OfficeState['characters'];
  };
}

function buildScenario(): Scenario {
  const layout = buildLayout();
  const state = new OfficeState(layout);
  for (let i = 0; i < 20; i++) {
    state.addAgent(i, i % 2, i < 2 ? 0 : (i * 47) % 360, undefined, true);
  }
  const chars = Array.from(state.characters.values());
  assert.equal(chars.length, 20);
  // Variety: walker, reader, idle, inactive, one active matrix spawn effect.
  chars[3].state = CharacterState.WALK;
  chars[3].dir = Direction.RIGHT;
  chars[3].frame = 2;
  chars[3].path = [
    { col: 10, row: 10 },
    { col: 11, row: 10 },
  ];
  chars[3].moveProgress = 0.5;
  chars[5].currentTool = 'Read';
  chars[7].state = CharacterState.IDLE;
  chars[9].isActive = false;
  const m = chars[19];
  m.matrixEffect = 'spawn';
  m.matrixEffectTimer = 0.06;
  m.matrixEffectSeeds = Array.from({ length: 16 }, (_, k) => k * 0.0625);
  const seat = chars[3].seatId ? state.seats.get(chars[3].seatId)! : null;
  state.selectedAgentId = 3;
  state.hoveredAgentId = 7;
  return {
    state,
    layout,
    selection: {
      selectedAgentId: 3,
      hoveredAgentId: 7,
      hoveredTile: seat ? { col: seat.seatCol, row: seat.seatRow } : { col: 10, row: 11 },
      seats: state.seats,
      characters: state.characters,
    },
  };
}

function renderFrameOnce(s: Scenario, ctx: CanvasRenderingContext2D): void {
  renderFrame(
    ctx,
    CANVAS_W,
    CANVAS_H,
    s.state.tileMap,
    s.state.furniture,
    s.state.getCharacters(),
    ZOOM,
    0,
    0,
    s.selection,
    undefined,
    s.layout.tileColors,
    s.layout.cols,
    s.layout.rows,
    s.layout.carpetTiles,
    s.layout.areas,
    s.layout.areaTiles,
    true,
    'A',
    s.state.pets,
  );
}

// ── Benchmark helpers ──────────────────────────────────────────

function bench(label: string, fn: () => void, frames = 80, warmup = 20): number {
  for (let i = 0; i < warmup; i++) fn();
  let best = Infinity;
  for (let batch = 0; batch < 5; batch++) {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) fn();
    best = Math.min(best, (performance.now() - t0) / frames);
  }
  console.log(`  ${label}: ${best.toFixed(3)} ms/frame`);
  return best;
}

interface AllocProfile {
  /** Minor (scavenger) GCs per 100 frames — proxy for per-frame allocation churn. */
  minorGcPer100: number;
  minorGcMsPer100: number;
  heapGrowthMB: number;
}

/**
 * Node's inspector HeapProfiler sampling barely fires under vitest (verified:
 * ~6 KB sampled of ~3 MB allocated), so allocation churn is measured by
 * counting minor GCs over N frames — proportional to allocation rate.
 */
function allocProfile(fn: () => void, frames: number): AllocProfile {
  let minorCount = 0;
  let minorMs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind;
      if (kind === 1) {
        minorCount++;
        minorMs += entry.duration;
      }
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) fn();
  const h1 = process.memoryUsage().heapUsed;
  obs.disconnect();
  return {
    minorGcPer100: (minorCount / frames) * 100,
    minorGcMsPer100: (minorMs / frames) * 100,
    heapGrowthMB: (h1 - h0) / 1048576,
  };
}

// ── Tests ──────────────────────────────────────────────────────

let ctxNull: CanvasRenderingContext2D;

beforeAll(() => {
  installDocumentMock();
  loadSyntheticAssets();
  ctxNull = makeNullCtx() as CanvasRenderingContext2D;
});

test('render gate: 3 identical frames, op stream matches golden', () => {
  const savedRandom = Math.random;
  Math.random = seededRandom;
  try {
    const s = buildScenario();
    const digests: RenderDigest[] = [];
    for (let frame = 0; frame < 3; frame++) {
      const ops: Op[] = [];
      renderFrameOnce(s, makeRecordingCtx(ops));
      digests.push(digestFrame(ops));
    }
    assert.equal(digests[0].hash, digests[1].hash, 'frame 1 vs 2 op streams differ');
    assert.equal(digests[1].hash, digests[2].hash, 'frame 2 vs 3 op streams differ');
    if (GOLDEN) {
      assert.equal(digests[0].hash, GOLDEN.hash, 'op-stream hash diverged from golden (render changed)');
      assert.deepEqual(digests[0].counts, GOLDEN.counts, 'op counts diverged from golden');
      assert.equal(digests[0].canvases, GOLDEN.canvases, 'sprite-canvas creation count diverged');
    } else {
      console.log('GOLDEN=' + JSON.stringify(digests[0]));
    }
  } finally {
    Math.random = savedRandom;
  }
});

test('benchmark: ms/frame per layer + full frame + update', () => {
  const savedRandom = Math.random;
  Math.random = seededRandom;
  try {
    const s = buildScenario();
    const { offsetX, offsetY } = mapOffset(CANVAS_W, CANVAS_H, COLS, ROWS, ZOOM, 0, 0);

    console.log('── ms/frame (mock ctx, min of 5×%d frames) ──', 80);
    bench('renderTileGrid ', () =>
      renderTileGrid(ctxNull, s.state.tileMap, offsetX, offsetY, ZOOM, s.layout.tileColors, COLS),
    );
    let wallInstances: ReturnType<typeof getWallInstances> = [];
    bench('getWallInstances', () => {
      wallInstances = getWallInstances(s.state.tileMap, s.layout.tileColors, COLS);
    });
    bench('renderCarpetLayer', () =>
      renderCarpetLayer(ctxNull, s.layout.carpetTiles!, COLS, ROWS, offsetX, offsetY, ZOOM),
    );
    bench('renderAreaOverlay', () =>
      renderAreaOverlay(ctxNull, s.layout.areaTiles, s.layout.areas, COLS, ROWS, offsetX, offsetY, ZOOM, 'A'),
    );
    bench('renderAreaLabels', () =>
      renderAreaLabels(ctxNull, s.layout.areaTiles, s.layout.areas, COLS, ROWS, offsetX, offsetY, ZOOM),
    );
    const sceneFurniture = wallInstances.concat(s.state.furniture);
    bench('renderScene(+walls)', () =>
      renderScene(
        ctxNull,
        sceneFurniture,
        s.state.getCharacters(),
        offsetX,
        offsetY,
        ZOOM,
        3,
        7,
        s.state.pets,
      ),
    );
    const total = bench('renderFrame TOTAL', () => renderFrameOnce(s, ctxNull));

    const update = bench('OfficeState.update', () => s.state.update(1 / 60), 200, 40);
    console.log(`  render+update budget: ${(total + update).toFixed(3)} ms/frame`);

    console.log('── allocation churn (400 frames) ──');
    const pTotal = allocProfile(() => renderFrameOnce(s, ctxNull), 400);
    console.log(
      `  renderFrame TOTAL: ${pTotal.minorGcPer100.toFixed(1)} minor GC/100f, ` +
        `${pTotal.minorGcMsPer100.toFixed(2)} ms GC/100f, heap ${pTotal.heapGrowthMB.toFixed(2)} MB`,
    );
    const pCarpet = allocProfile(
      () => renderCarpetLayer(ctxNull, s.layout.carpetTiles!, COLS, ROWS, offsetX, offsetY, ZOOM),
      400,
    );
    console.log(
      `  renderCarpetLayer: ${pCarpet.minorGcPer100.toFixed(1)} minor GC/100f, ` +
        `${pCarpet.minorGcMsPer100.toFixed(2)} ms GC/100f, heap ${pCarpet.heapGrowthMB.toFixed(2)} MB`,
    );
    const pTiles = allocProfile(
      () => renderTileGrid(ctxNull, s.state.tileMap, offsetX, offsetY, ZOOM, s.layout.tileColors, COLS),
      400,
    );
    console.log(
      `  renderTileGrid: ${pTiles.minorGcPer100.toFixed(1)} minor GC/100f, ` +
        `${pTiles.minorGcMsPer100.toFixed(2)} ms GC/100f, heap ${pTiles.heapGrowthMB.toFixed(2)} MB`,
    );
  } finally {
    Math.random = savedRandom;
  }
});
