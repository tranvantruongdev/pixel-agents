/** The CLI that + Agent launches (Claude, Codex, OpenCode, DeepSeek...), chosen
 *  on the desktop toolbar and remembered per browser. Read at send time by both
 *  the desktop drawer and the mobile shell, so they always launch the same CLI.
 *  Undefined = the server's default (Claude). */

const STORAGE_KEY = 'pixel-agents.launchProviderId';

export interface LaunchProvider {
  id: string;
  displayName: string;
}

export function getLaunchProviderId(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setLaunchProviderId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private window / blocked storage: the choice just isn't remembered */
  }
}
