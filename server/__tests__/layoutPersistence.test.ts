import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap renameSync so the shared-tmp interleaving below can be simulated
// without spying on an unconfigurable ESM namespace; every other export
// stays the real fs.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import {
  loadLayout,
  readLayoutFromFile,
  writeLayoutToFile,
} from '../src/layoutPersistence.js';

function isolateHomeEnv(tmpHome: string): () => void {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe('layoutPersistence', () => {
  let tempHome: string;
  let restoreHomeEnv: () => void;
  let layoutPath: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-layout-test-'));
    restoreHomeEnv = isolateHomeEnv(tempHome);
    layoutPath = path.join(tempHome, '.pixel-agents', 'layout.json');
  });

  afterEach(() => {
    restoreHomeEnv();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('writeLayoutToFile', () => {
    it('keeps layout.json valid when another process is mid-write into the shared tmp path', () => {
      const sharedTmp = `${layoutPath}.tmp`;
      const renameMock = vi.mocked(fs.renameSync);
      const realRename = renameMock.getMockImplementation()!;
      renameMock.mockImplementation((from, to) => {
        if (String(from) === sharedTmp) {
          // Window B truncated the shared tmp and is partway through
          // rewriting it when our rename moves it into place.
          fs.writeFileSync(sharedTmp, '{"tiles":[{"x"', 'utf-8');
        }
        realRename(from, to);
      });
      try {
        const layoutA = { layoutRevision: 1, tiles: ['floor'] };
        writeLayoutToFile(layoutA);

        expect(readLayoutFromFile()).toEqual(layoutA);
      } finally {
        renameMock.mockImplementation(realRename);
      }
    });
  });

  describe('loadLayout', () => {
    it('returns null when no file exists and no default is given', () => {
      expect(loadLayout(null)).toBeNull();
    });

    it('writes the bundled default when no file exists', () => {
      const defaultLayout = { layoutRevision: 1, tiles: ['default'] };

      const result = loadLayout(defaultLayout);

      expect(result).toEqual({ layout: defaultLayout, wasReset: false });
      expect(readLayoutFromFile()).toEqual(defaultLayout);
    });

    it('returns the saved layout untouched when its revision is current', () => {
      const saved = { layoutRevision: 3, tiles: ['mine'] };
      fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
      fs.writeFileSync(layoutPath, JSON.stringify(saved), 'utf-8');

      const result = loadLayout({ layoutRevision: 3, tiles: ['default'] });

      expect(result).toEqual({ layout: saved, wasReset: false });
    });

    it('resets to the bundled default when the saved revision is older', () => {
      const saved = { layoutRevision: 1, tiles: ['mine'] };
      fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
      fs.writeFileSync(layoutPath, JSON.stringify(saved), 'utf-8');
      const defaultLayout = { layoutRevision: 2, tiles: ['default'] };

      const result = loadLayout(defaultLayout);

      expect(result).toEqual({ layout: defaultLayout, wasReset: true });
      expect(readLayoutFromFile()).toEqual(defaultLayout);
    });

    it('does not overwrite a corrupt layout file with the bundled default', () => {
      const corrupt = '{ "tiles": [ truncated';
      fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
      fs.writeFileSync(layoutPath, corrupt, 'utf-8');
      const defaultLayout = { layoutRevision: 5, tiles: ['default'] };

      const result = loadLayout(defaultLayout);

      expect(result).toEqual({ layout: defaultLayout, wasReset: false });
      expect(fs.readFileSync(layoutPath, 'utf-8')).toBe(corrupt);
    });

    it('does not overwrite an empty layout file with the bundled default', () => {
      fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
      fs.writeFileSync(layoutPath, '', 'utf-8');
      const defaultLayout = { layoutRevision: 5, tiles: ['default'] };

      const result = loadLayout(defaultLayout);

      expect(result).toEqual({ layout: defaultLayout, wasReset: false });
      expect(fs.readFileSync(layoutPath, 'utf-8')).toBe('');
    });
  });
});
