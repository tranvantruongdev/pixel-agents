/**
 * DeepSeek Harness chat loop, run in the PTY when "+ Agent" launches DeepSeek.
 *
 * dsh ships no interactive terminal app, only `dsh headless` (one task per run,
 * JSON run events on stdout). This loop reads a line, runs one headless turn on
 * it — continuing the same dsh Session from the second turn on — prints the
 * answer, and posts the run as Claude-shaped hook events to every live Pixel
 * Agents server so the character works while dsh does.
 *
 * Safety, same contract as the hook scripts: the user's text goes to dsh on
 * stdin, never in argv or a shell; posts go to 127.0.0.1 only and every failure
 * is swallowed so a stopped office can never break the chat.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVERS_DIR } from '../../../../constants.js';
import type { ServerConfig } from '../../../../serverConfig.js';
import { isServerConfig } from '../../../../serverConfig.js';
import { DSH_PROVIDER_ID, dshAppPath } from '../dsh.js';

/** The headless profile ships with the DeepSeek account sign-in switched off
 *  (API key only). This overlay turns it back on and selects the account
 *  model, so the desktop app's signed-in account (and its free credit) is
 *  used. It is passed per run; the user's own profiles are never edited. */
const ACCOUNT_PATCH = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: authorization
  name: "@deepseek-ai/dsh-authorization"
  disabled: false
- id: credentials
  name: "@deepseek-ai/dsh-credentials-local"
  disabled: false
- id: deepseek-account
  name: "@deepseek-ai/dsh-deepseek-account-platform"
  disabled: false
`;

/** Pixel Agents' id for this terminal (set by the launcher). Used as the hook
 *  session id, so events land on the agent that owns this PTY. */
const launchId = process.env['PIXEL_AGENTS_LAUNCH_ID'] ?? `dsh-${process.pid}`;

function liveServers(): ServerConfig[] {
  const dir = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);
  const out: ServerConfig[] = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as unknown;
        if (!isServerConfig(entry)) continue;
        process.kill(entry.pid, 0); // throws when the server is gone
        out.push(entry);
      } catch {
        /* malformed or dead entry: skip */
      }
    }
  } catch {
    /* no registry: no office running */
  }
  return out;
}

function post(event: Record<string, unknown>): void {
  const body = JSON.stringify({ ...event, session_id: launchId });
  for (const server of liveServers()) {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: `${HOOK_API_PREFIX}/${DSH_PROVIDER_ID}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${server.token}`,
      },
      timeout: 2000,
    });
    req.on('response', (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  }
}

const patchFile = path.join(os.tmpdir(), 'pixel-agents-dsh-account.yml');
fs.writeFileSync(patchFile, ACCOUNT_PATCH);

let dshSessionId: string | undefined;
let running: ReturnType<typeof spawn> | undefined;

function runTurn(task: string, done: () => void): void {
  const cliJs = path.join(
    path.dirname(dshAppPath()),
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  const args = ['--expose-internals', cliJs, 'headless', '--patch', patchFile, '--json'];
  if (dshSessionId) args.push('--session-id', dshSessionId);
  args.push('-');
  const child = spawn(dshAppPath(), args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running = child;
  child.stdin.end(task);

  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // plugin chatter on stdout, not a run event
    }
    switch (ev['type']) {
      case 'session':
        dshSessionId = ev['sessionId'] as string;
        break;
      case 'tool_call':
        process.stdout.write(`\x1b[2m• ${String(ev['tool'])}\x1b[0m\n`);
        post({
          hook_event_name: 'PreToolUse',
          tool_name: ev['tool'],
          tool_input: ev['input'],
          tool_use_id: ev['callId'],
        });
        break;
      case 'tool_result':
        post({ hook_event_name: 'PostToolUse', tool_use_id: ev['callId'] });
        break;
      case 'text':
        process.stdout.write(`${String(ev['text'])}\n`);
        break;
      case 'status': {
        const reason = ev['reason'] as { kind?: string; error?: { message?: string } } | undefined;
        if (ev['phase'] === 'turn_end' && reason?.kind === 'error') {
          process.stdout.write(`\x1b[31m${reason.error?.message ?? 'dsh error'}\x1b[0m\n`);
        }
        break;
      }
    }
  });
  child.on('close', (code) => {
    running = undefined;
    if (code !== 0 && stderr.trim()) process.stdout.write(`\x1b[31m${stderr.trim()}\x1b[0m\n`);
    post({ hook_event_name: 'Stop' });
    done();
  });
  child.on('error', (err) => {
    process.stdout.write(`\x1b[31mCannot start DeepSeek Harness: ${err.message}\x1b[0m\n`);
  });
}

post({ hook_event_name: 'SessionStart', source: 'startup', cwd: process.cwd() });
process.stdout.write(
  'DeepSeek Harness — one headless turn per line. Ctrl+C stops a turn; Ctrl+C or /exit at the prompt exits.\n',
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'deepseek> ',
});
rl.on('SIGINT', () => {
  if (running) running.kill();
  else rl.close();
});
rl.on('line', (line) => {
  const task = line.trim();
  if (task === 'exit' || task === '/exit') return rl.close();
  if (!task || running) return rl.prompt();
  rl.pause();
  runTurn(task, () => {
    rl.resume();
    rl.prompt();
  });
});
rl.on('close', () => {
  post({ hook_event_name: 'SessionEnd', reason: 'exit' });
  setTimeout(() => process.exit(0), 300);
});
rl.prompt();
