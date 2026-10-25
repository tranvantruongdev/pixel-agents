/**
 * DeepSeek Harness (dsh) provider.
 *
 * dsh has no terminal UI and no hooks API, only `dsh headless`, which answers
 * one task per run and can stream run events as JSON. So "+ Agent" launches our
 * own small chat loop (hooks/dsh-chat.ts) in the PTY: it runs one headless turn
 * per line typed, continues the same dsh Session each turn, and posts the run
 * events here in the same Claude-shaped envelope the Codex hook uses — which is
 * why this provider reuses the Codex normalizer instead of a copy of it.
 *
 * Nothing is installed into dsh: the chat loop posts directly, so the hook
 * install surface is a no-op that reports itself installed (no consent ask).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../../../../core/src/provider.js';
import { codexProvider } from '../codex/codex.js';

export const DSH_PROVIDER_ID = 'dsh';

/** Electron binary of the DeepSeek Harness desktop install. Its bundled CLI is
 *  run with ELECTRON_RUN_AS_NODE, exactly as the shipped dsh.cmd does.
 *  ponytail: Windows per-user install only; add other platforms when someone
 *  runs dsh there. */
export function dshAppPath(): string {
  return path.join(
    process.env['LOCALAPPDATA'] ?? '',
    'Programs',
    'DeepSeek Harness',
    'DeepSeek Harness.exe',
  );
}

/** Path the chat loop writes its account patch to — one file per running
 *  loop (keyed by pid): with one shared fixed name, one loop's rewrite could
 *  hand another loop's dsh child a torn, half-written yml. */
export function patchFilePath(tmpdir: string, pid: number): string {
  return path.join(tmpdir, `pixel-agents-dsh-account-${pid}.yml`);
}

const READING_TOOLS: ReadonlySet<string> = new Set(['read', 'fs_search', 'session_query']);

export const dshProvider: HookProvider = {
  kind: 'hook',
  id: DSH_PROVIDER_ID,
  displayName: 'DeepSeek',
  protocolVersion: 1,

  normalizeHookEvent: codexProvider.normalizeHookEvent,

  installHooks: async () => {},
  uninstallHooks: async () => {},
  areHooksInstalled: async () => true,
  consentDisclosure: () => ({
    headline: 'DeepSeek Harness',
    disclosure:
      'Nothing is installed: agents launched from + Agent report their activity to this server directly.',
  }),

  formatToolStatus: (toolName, input) => {
    const file = (input as { file_path?: unknown } | undefined)?.file_path;
    return typeof file === 'string' ? `${toolName} ${path.basename(file)}` : `Using ${toolName}`;
  },
  permissionExemptTools: READING_TOOLS,
  subagentToolNames: new Set<string>(),
  readingTools: READING_TOOLS,

  isPresent: () => process.platform === 'win32' && fs.existsSync(dshAppPath()),
  buildLaunchCommand: () => ({
    // dist/cli.js bundles this file, so the chat loop sits beside it in dist/hooks.
    command: process.execPath,
    args: [path.join(__dirname, 'hooks', 'dsh-chat.js')],
  }),
};
