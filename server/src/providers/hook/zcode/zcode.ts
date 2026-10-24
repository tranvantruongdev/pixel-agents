/**
 * ZCode provider, report-only.
 *
 * ZCode's own CLI cannot run on a Start Plan account, so work reaches ZCode
 * through the desktop app's scheduler (~/.claude/scripts/dispatch.mjs). No
 * process of ours runs ZCode and it has no hooks we can install, so the
 * dispatcher posts the run here in the Claude-shaped envelope the Codex hook
 * uses — hence the reused Codex normalizer. Nothing is installed and nothing
 * is launched from + Agent (no buildLaunchCommand).
 */

import type { HookProvider } from '../../../../../core/src/provider.js';
import { codexProvider } from '../codex/codex.js';

export const zcodeProvider: HookProvider = {
  kind: 'hook',
  id: 'zcode',
  displayName: 'ZCode',
  protocolVersion: 1,

  normalizeHookEvent: codexProvider.normalizeHookEvent,

  installHooks: async () => {},
  uninstallHooks: async () => {},
  areHooksInstalled: async () => true,
  consentDisclosure: () => ({
    headline: 'ZCode',
    disclosure: 'Nothing is installed: dispatched ZCode runs report to this server directly.',
  }),

  formatToolStatus: (toolName) => `Using ${toolName}`,
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set<string>(),
};
