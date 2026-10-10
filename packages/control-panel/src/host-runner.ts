// Runs xrb-host for a project (design D4): built mode (--app-dir=<entry>) or dev mode (the
// project's dev server with live reload, --url=http://127.0.0.1:<port>/). Reads the host's
// stdout: "@channel <url>" once, "@status {json}" every second, everything else is the log.
// Stop is always the host's clean exit (taskkill without /F = WM_CLOSE: the display plugin ends its
// session); a forced end is the last resort after 20 s, because it can leave a 3D display in 3D or
// its device in a bad state.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { LineSplitter } from './jobs.ts';

export type RunMode = 'built' | 'dev';

export interface HostStatusLine {
  uptimeS: number;
  /** the display has a switchable session: the view can switch between 2D and 3D while the app runs (older hosts: absent) */
  session?: boolean;
  /** the page is side by side and shown in 3D */
  stereo?: boolean;
  pageFps: number | null;
  frameMs: number | null;
  latencyMs: number | null;
  eyeW: number | null;
  eyeH: number | null;
  pageAgeMs: number | null;
  handsHz: number;
  handState: string;
  hands: number;
  clients: number;
}

export interface ForeignHost {
  pid: number;
  exe: string;
}

export interface RunState {
  projectId: string | null;
  mode: RunMode | null;
  /** 2D mode: mono, no 3D. Started with --view=2d; follows the host's status while it runs (switchable) */
  flat: boolean;
  /** the host's display has a switchable session: 2D/3D can be switched while the app runs (known from the first status line) */
  switchable: boolean;
  /** camera view: the host streams the camera images on its channel (--camera-view=on) */
  cameraView: boolean;
  phase: 'idle' | 'starting' | 'running' | 'stopping';
  pid: number | null;
  startedMs: number | null;
  channelUrl: string | null;
  devUrl: string | null;
  status: HostStatusLine | null;
  last: { projectId: string; exitCode: number | null; endedMs: number; lines: string[]; forced: boolean } | null;
  warning: string | null;
  foreign: ForeignHost[];
}

export interface RunRequest {
  projectId: string;
  mode: RunMode;
  hostExe: string;
  projectDir: string;
  /** built mode: the folder served at https://app.local/ */
  entryDir: string;
  /** dev mode: the dev script name in the project's package.json */
  devScript?: string;
  /** dev mode: extra environment for the dev server (XRB_CORE: where the app's SDK comes from) */
  devEnv?: Record<string, string>;
  flat?: boolean;
  cameraView?: boolean;
  hostArgs: string[];
}

const STOP_GRACE_MS = 20_000;
const LOG_KEEP = 500;

/** Channel message kSetView (native/host/src/host_channel.h): 16-byte header, then u8 stereo. */
export function encodeSetView(stereo: boolean): Uint8Array {
  const b = new Uint8Array(17);
  b[0] = 101;  // kSetView
  b[1] = 1;    // protocol version
  b[16] = stereo ? 1 : 0;
  return b;
}

/** Sends one kSetView to the host's channel: a short-lived client like a page would be. */
export function sendSetView(channelUrl: string, stereo: boolean, Socket: typeof WebSocket = WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new Socket(channelUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('the host channel did not answer within 3 s')); }, 3000);
    ws.onopen = () => {
      ws.send(encodeSetView(stereo));
      // Let the frame leave before closing (the server reads and drops the socket otherwise).
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 50);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cannot reach the host channel')); };
  });
}

/** Exit code of a second host (the single-instance mutex is taken). */
export const EXIT_ALREADY_RUNNING = 3;

export function parseHostLine(line: string): { kind: 'channel'; url: string } | { kind: 'status'; status: HostStatusLine } | { kind: 'log'; text: string } {
  if (line.startsWith('@channel ')) return { kind: 'channel', url: line.slice(9).trim() };
  if (line.startsWith('@status ')) {
    try {
      return { kind: 'status', status: JSON.parse(line.slice(8)) as HostStatusLine };
    } catch {
      /* fall through: show it as a log line */
    }
  }
  return { kind: 'log', text: line };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function httpReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** taskkill: without force it posts WM_CLOSE (the host's clean exit). */
export function taskkill(pid: number, force: boolean): Promise<void> {
  const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid)];
  return new Promise((resolve) => execFile('taskkill.exe', args, { windowsHide: true }, () => resolve()));
}

/**
 * Hosts running outside the panel: processes whose exe folder holds libcef.dll and a plugins
 * folder or xrb-app.json (repo builds and installed packages). CEF helpers (same exe, child of a
 * host) are left out.
 */
export function findHosts(): Promise<ForeignHost[]> {
  const ps = [
    "$all = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Where-Object {",
    "  $d = Split-Path $_.ExecutablePath;",
    "  (Test-Path (Join-Path $d 'libcef.dll')) -and ((Test-Path (Join-Path $d 'plugins')) -or (Test-Path (Join-Path $d 'xrb-app.json'))) };",
    '$ids = @($all | ForEach-Object { $_.ProcessId });',
    "$all | Where-Object { $ids -notcontains $_.ParentProcessId } | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
  ].join(' ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            const [pid, exe] = l.split('\t');
            return { pid: Number(pid), exe };
          })
          .filter((h) => h.pid > 0),
      );
    });
  });
}

export class HostRunner extends EventEmitter {
  private host: ChildProcess | null = null;
  private dev: ChildProcess | null = null;
  private log: string[] = [];
  private s: RunState = { projectId: null, mode: null, flat: false, switchable: false, cameraView: false, phase: 'idle', pid: null, startedMs: null, channelUrl: null, devUrl: null, status: null, last: null, warning: null, foreign: [] };

  private readonly findForeign: typeof findHosts;
  private readonly kill: typeof taskkill;
  private readonly send: typeof sendSetView;

  /** The process and channel helpers can be replaced in tests. */
  constructor(findForeign = findHosts, kill = taskkill, send = sendSetView) {
    super();
    this.findForeign = findForeign;
    this.kill = kill;
    this.send = send;
  }

  get projectId(): string | null {
    return this.s.phase === 'idle' ? null : this.s.projectId;
  }

  get busy(): boolean {
    return this.s.phase !== 'idle';
  }

  state(): RunState {
    return { ...this.s };
  }

  logLines(): string[] {
    return [...this.log];
  }

  /** Empties the kept log (the UI's Clear); new host lines keep arriving. */
  clearLog(): void {
    this.log = [];
  }

  private set(patch: Partial<RunState>): void {
    this.s = { ...this.s, ...patch };
    this.emit('state', this.state());
  }

  private addLog(text: string): void {
    this.log.push(text);
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
    this.emit('log', text);
  }

  async start(req: RunRequest): Promise<void> {
    if (this.busy) throw new Error(`${this.s.projectId} is already running; stop it first`);
    this.log = [];
    this.set({ projectId: req.projectId, mode: req.mode, flat: !!req.flat, switchable: false, cameraView: !!req.cameraView, phase: 'starting', pid: null, startedMs: Date.now(), channelUrl: null, devUrl: null, status: null, warning: null, foreign: [] });
    try {
      const args = [...req.hostArgs, '--status=stdout', ...(req.cameraView ? ['--camera-view=on'] : [])];
      if (req.mode === 'dev') {
        if (!req.devScript) throw new Error('this project has no dev script');
        const port = await freePort();
        const devUrl = `http://127.0.0.1:${port}/`;
        this.addLog(`[panel] starting the dev server: pnpm run ${req.devScript} on ${devUrl}`);
        // pnpm is a .cmd: it needs cmd.exe. The script name is validated by the manifest rules.
        this.dev = spawn('cmd.exe', ['/d', '/s', '/c', `pnpm run ${req.devScript} --host 127.0.0.1 --port ${port} --strictPort`], {
          cwd: req.projectDir, env: { ...process.env, ...req.devEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const devOut = new LineSplitter((l) => this.addLog(`[dev] ${l}`));
        this.dev.stdout!.setEncoding('utf8').on('data', (d: string) => devOut.push(d));
        this.dev.stderr!.setEncoding('utf8').on('data', (d: string) => devOut.push(d));
        const until = Date.now() + 30_000;
        while (!(await httpReady(devUrl))) {
          if (this.dev.exitCode !== null) throw new Error(`the dev server exited (code ${this.dev.exitCode})`);
          if (Date.now() > until) throw new Error('the dev server did not answer within 30 s');
          await sleep(300);
        }
        this.set({ devUrl });
        args.push(`--url=${devUrl}`);
      } else {
        await fs.access(path.join(req.entryDir, 'index.html')).catch(() => {
          throw new Error(`${req.entryDir} has no index.html: run Build first`);
        });
        args.push(`--app-dir=${req.entryDir}`);
      }
      this.addLog(`[panel] ${path.basename(req.hostExe)} ${args.join(' ')}`);
      const host = spawn(req.hostExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.host = host;
      const out = new LineSplitter((l) => this.onHostLine(l));
      host.stdout!.setEncoding('utf8').on('data', (d: string) => out.push(d));
      host.stderr!.setEncoding('utf8').on('data', (d: string) => out.push(d));
      host.on('error', (e) => this.addLog(`[panel] cannot start the host: ${e.message}`));
      host.on('close', (code) => void this.onHostExit(host, code, out));
      this.set({ pid: host.pid ?? null, phase: 'running' });
    } catch (e) {
      this.stopDev();
      this.addLog(`[panel] ${(e as Error).message}`);
      this.set({ phase: 'idle', last: { projectId: req.projectId, exitCode: null, endedMs: Date.now(), lines: this.log.slice(-30), forced: false }, warning: (e as Error).message });
      throw e;
    }
  }

  private onHostLine(line: string): void {
    // A display runtime writes to the same stdout without line locking: a host line can arrive
    // glued to the end of one of its partial lines ("[clien@status {...}"). Split it off.
    const glued = line.search(/@(status|channel) /);
    if (glued > 0) {
      this.onHostLine(line.slice(0, glued));
      this.onHostLine(line.slice(glued));
      return;
    }
    const m = parseHostLine(line);
    if (m.kind === 'channel') this.set({ channelUrl: m.url });
    else if (m.kind === 'status') {
      this.s = { ...this.s, status: m.status };
      this.emit('status', m.status);
      // With a session the host owns the view: the panel shows what it reports (a page may switch too).
      const switchable = m.status.session === true;
      const flat = switchable ? m.status.stereo !== true : this.s.flat;
      if (switchable !== this.s.switchable || flat !== this.s.flat) this.set({ switchable, flat });
    } else this.addLog(m.text);
  }

  private forced = false;

  private async onHostExit(host: ChildProcess, code: number | null, out: LineSplitter): Promise<void> {
    out.flush();
    if (this.host !== host) return;
    this.host = null;
    this.stopDev();
    const projectId = this.s.projectId!;
    const quick = this.s.startedMs !== null && Date.now() - this.s.startedMs < 5000;
    let warning = this.forced ? 'the host did not exit within 20 s and was ended by force: if the display stays in 3D or does not start next time, replug its USB and power' : null;
    let foreign: ForeignHost[] = [];
    if (code === EXIT_ALREADY_RUNNING && quick) {
      foreign = await this.findForeign();
      warning = `another host is already running${foreign.length ? `: ${foreign.map((f) => `${path.basename(f.exe)} (pid ${f.pid})`).join(', ')}` : ''}`;
    }
    this.addLog(`[panel] host exited with code ${code}`);
    this.set({ phase: 'idle', pid: null, channelUrl: null, devUrl: null, last: { projectId, exitCode: code, endedMs: Date.now(), lines: this.log.slice(-30), forced: this.forced }, warning, foreign });
    this.forced = false;
    this.emit('exit', code);
  }

  private stopDev(): void {
    if (this.dev?.pid && this.dev.exitCode === null) void this.kill(this.dev.pid, true);
    this.dev = null;
  }

  /** Clean stop; forced only if the host is still there after the grace period. */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    const host = this.host;
    if (!host?.pid) {
      this.stopDev();
      if (this.s.phase !== 'idle') this.set({ phase: 'idle' });
      return;
    }
    this.set({ phase: 'stopping' });
    const exited = new Promise<void>((r) => host.once('close', () => r()));
    await this.kill(host.pid, false);
    const done = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
    if (!done) {
      this.forced = true;
      this.addLog(`[panel] the host did not exit within ${graceMs / 1000} s: ending it by force`);
      await this.kill(host.pid, true);
      await exited;
    }
    // onHostExit runs from 'close' and may still be finishing (foreign check).
    while (this.s.phase !== 'idle') await sleep(20);
  }

  /** 2D or 3D while the app runs: asks the host over its channel; the status line then confirms. */
  async setView(flat: boolean): Promise<void> {
    if (this.s.phase !== 'running' || !this.s.channelUrl) throw new Error('no app is running');
    if (!this.s.switchable) throw new Error('this host cannot switch between 2D and 3D: its display has no switchable session');
    await this.send(this.s.channelUrl, !flat);
    this.addLog(`[panel] asked the host for ${flat ? '2D' : '3D'}`);
    this.set({ flat });  // the host applies it at once; its next status line confirms
  }

  /** Stops a host the panel did not start, the clean way. */
  async stopForeign(pid: number): Promise<void> {
    await this.kill(pid, false);
    this.set({ foreign: this.s.foreign.filter((f) => f.pid !== pid) });
  }
}
