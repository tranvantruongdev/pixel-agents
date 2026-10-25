import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// resolveWebviewView runs on every (re)open of the Pixel Agents view — VS Code
// destroys the old webview and calls the provider again. Each call registers
// window-level terminal listeners plus the webview message listener; those
// registrations must not outlive the view instance that created them.

const { onChangeActive, onCloseTerminal } = vi.hoisted(() => {
  const makeRegistrar = () => {
    const registrations: { disposed: boolean }[] = [];
    const fn = vi.fn((_cb: unknown) => {
      const reg = { disposed: false };
      registrations.push(reg);
      return {
        dispose: () => {
          reg.disposed = true;
        },
      };
    });
    return { fn, registrations };
  };
  return { onChangeActive: makeRegistrar(), onCloseTerminal: makeRegistrar() };
});

// Mock the `vscode` module so PixelAgentsViewProvider is importable from a
// non-VS Code test env (same pattern as migrateVsCodeState.test.ts).
vi.mock('vscode', async () => {
  const nodePath = await vi.importActual<typeof import('path')>('path');
  return {
    window: {
      onDidChangeActiveTerminal: onChangeActive.fn,
      onDidCloseTerminal: onCloseTerminal.fn,
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      terminals: [] as unknown[],
    },
    workspace: {
      workspaceFolders: undefined,
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: () => {} })),
    },
    Uri: {
      joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
        fsPath: nodePath.join(base.fsPath, ...segs),
      }),
    },
  };
});

import { PixelAgentsViewProvider } from '../../adapters/vscode/PixelAgentsViewProvider.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';

let provider: InstanceType<typeof PixelAgentsViewProvider>;
let extDir: string;

/** Minimal WebviewView double: only what resolveWebviewView touches before it
 *  returns. Message-listener disposables are tracked like the window ones. */
function makeWebviewView() {
  const registrations: { disposed: boolean }[] = [];
  return {
    registrations,
    webview: {
      onDidReceiveMessage: vi.fn(() => {
        const reg = { disposed: false };
        registrations.push(reg);
        return {
          dispose: () => {
            reg.disposed = true;
          },
        };
      }),
      postMessage: vi.fn(() => Promise.resolve(true)),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => `vscode-webview://fake${uri.fsPath}`),
      cspSource: 'https://fake.vscode-cdn.net',
    },
  };
}

beforeEach(() => {
  onChangeActive.registrations.length = 0;
  onCloseTerminal.registrations.length = 0;
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ext-'));
  fs.mkdirSync(path.join(extDir, 'dist', 'webview'), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'dist', 'webview', 'index.html'),
    '<!doctype html><html><head><title>t</title></head>' +
      '<body><script type="module" src="./main.js"></script></body></html>',
    'utf-8',
  );
  provider = new PixelAgentsViewProvider(
    {
      subscriptions: { push: vi.fn() },
      extensionPath: extDir,
      extensionUri: { fsPath: extDir },
    } as never,
    new FileStateAdapter({ namespace: 'vscode' }),
  );
});

afterEach(() => {
  provider.dispose();
  fs.rmSync(extDir, { recursive: true, force: true });
});

describe('PixelAgentsViewProvider view listener lifetime', () => {
  it('disposes the previous view listeners when the view is re-resolved', () => {
    const view1 = makeWebviewView();
    const view2 = makeWebviewView();

    provider.resolveWebviewView(view1 as never);
    provider.resolveWebviewView(view2 as never);

    // One live window-level registration each — the first view's copies
    // held its destroyed webview in closure and were never disposed.
    expect(onChangeActive.registrations.filter((r) => !r.disposed)).toHaveLength(1);
    expect(onCloseTerminal.registrations.filter((r) => !r.disposed)).toHaveLength(1);
    expect(view1.registrations.filter((r) => !r.disposed)).toHaveLength(0);
  });

  it('disposes all view listeners when the provider is disposed', () => {
    provider.resolveWebviewView(makeWebviewView() as never);

    provider.dispose();

    expect(onChangeActive.registrations.filter((r) => !r.disposed)).toHaveLength(0);
    expect(onCloseTerminal.registrations.filter((r) => !r.disposed)).toHaveLength(0);
  });
});
