// Paths and the panel's own log. The panel runs hidden (start.vbs), so its log file is the
// only place its messages show up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The core repo the panel runs from: host, plugin SDK, SDK, templates. */
export const REPO = path.resolve(PANEL_DIR, '../..');
export const DEFAULT_PORT = 5180;

/** Runtime data of this machine (logs, run state): never versioned. */
export function dataDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'XRBuild');
}

/** The user's workspace (projects, plugins, panel layout, packages): XRB_HOME, else ~/.xr-build. */
export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XRB_HOME) return path.resolve(env.XRB_HOME);
  return path.join(env.USERPROFILE || os.homedir(), '.xr-build');
}

export const WORKSPACE = workspaceDir();

let logFile: string | null = null;

/**
 * Starts logging to the panel's log file. `rotate` keeps the previous run as .prev (like the
 * host does); only the instance that becomes the server rotates, a second start just appends.
 */
export function openLog(rotate: boolean, file = path.join(dataDir(), 'logs', 'control-panel.log')): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (rotate) {
    try {
      fs.renameSync(file, file + '.prev');
    } catch { /* first run */ }
  }
  logFile = file;
}

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch { /* log must never break the panel */ }
  }
}
