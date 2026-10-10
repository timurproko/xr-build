// Background jobs (design D10): web build, package build, host rebuild, icon render. Output is
// kept per job (last lines, so a reloaded page shows the history) and streamed to the UI.
import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type JobKind = 'web-build' | 'package' | 'host-rebuild' | 'icon-render';
export type JobState = 'running' | 'done' | 'failed';

export interface Job {
  id: number;
  kind: JobKind;
  projectId: string | null;
  title: string;
  state: JobState;
  startedMs: number;
  endedMs: number | null;
  exitCode: number | null;
  error: string | null;
  result: unknown;
  lines: string[];
}

export const MAX_LINES = 2000;

export class JobRefused extends Error {}

export interface JobContext {
  /** Appends a line to the job output. */
  line(text: string): void;
  /** Runs a program (no shell), streaming its output; rejects on a non-zero exit. */
  run(cmd: string, args: string[], opts?: SpawnOptions): Promise<void>;
}

/** Removes terminal colour/control sequences (ESC [ ... letter). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

/** Splits streamed output into lines; progress written with \r counts as a line too. */
export class LineSplitter {
  private rest = '';
  private readonly onLine: (l: string) => void;
  constructor(onLine: (l: string) => void) {
    this.onLine = onLine;
  }
  push(chunk: string): void {
    const parts = (this.rest + chunk).split(/\r\n|\n|\r/);
    this.rest = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) this.onLine(p);
  }
  flush(): void {
    if (this.rest.trim()) this.onLine(this.rest);
    this.rest = '';
  }
}

/** Starts a process and resolves with its exit code; output goes to onLine. */
export function runProcess(cmd: string, args: string[], onLine: (l: string) => void, opts: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = new LineSplitter(onLine), err = new LineSplitter(onLine);
    p.stdout!.setEncoding('utf8').on('data', (d: string) => out.push(d));
    p.stderr!.setEncoding('utf8').on('data', (d: string) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      out.flush();
      err.flush();
      resolve(code ?? 1);
    });
  });
}

export class JobRunner extends EventEmitter {
  private readonly jobs: Job[] = [];
  private nextId = 1;
  private readonly keep: number;

  constructor(keep = 30) {
    super();
    this.keep = keep;
  }

  list(): Job[] {
    return this.jobs.map((j) => ({ ...j, lines: j.lines.slice(-200) }));
  }

  get(id: number): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  running(): Job[] {
    return this.jobs.filter((j) => j.state === 'running');
  }

  /** Forgets finished jobs (done or failed); running ones stay. Returns how many were removed. */
  clearFinished(): number {
    const before = this.jobs.length;
    for (let i = this.jobs.length - 1; i >= 0; i--) if (this.jobs[i].state !== 'running') this.jobs.splice(i, 1);
    return before - this.jobs.length;
  }

  /**
   * Why a new job may not start now, or null. One job of each kind at a time; a package build
   * and a web build of the same project exclude each other (one reads what the other writes).
   */
  conflict(kind: JobKind, projectId: string | null): string | null {
    for (const j of this.running()) {
      if (j.kind === kind) return `a ${kind} job is already running (${j.title})`;
      const pair = new Set([j.kind, kind]);
      if (j.projectId && j.projectId === projectId && pair.has('package') && pair.has('web-build'))
        return `${j.title} is running for this project`;
    }
    return null;
  }

  /** Starts a job; throws JobRefused when a conflicting job runs. Returns at once. */
  start(kind: JobKind, projectId: string | null, title: string, body: (ctx: JobContext) => Promise<unknown>): Job {
    const why = this.conflict(kind, projectId);
    if (why) throw new JobRefused(why);
    const job: Job = { id: this.nextId++, kind, projectId, title, state: 'running', startedMs: Date.now(), endedMs: null, exitCode: null, error: null, result: null, lines: [] };
    this.jobs.push(job);
    while (this.jobs.length > this.keep) {
      const i = this.jobs.findIndex((j) => j.state !== 'running');
      if (i < 0) break;
      this.jobs.splice(i, 1);
    }
    const line = (raw: string) => {
      const text = stripAnsi(raw);  // tools like vite colour their output even into a pipe
      job.lines.push(text);
      if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
      this.emit('line', job, text);
    };
    const ctx: JobContext = {
      line,
      run: async (cmd, args, opts) => {
        line(`> ${[cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
        const code = await runProcess(cmd, args, line, opts);
        job.exitCode = code;
        if (code !== 0) throw new Error(`exit code ${code}`);
      },
    };
    this.emit('change', job);
    void (async () => {
      try {
        job.result = await body(ctx);
        job.state = 'done';
      } catch (e) {
        job.state = 'failed';
        job.error = (e as Error).message;
        line(`FAILED: ${job.error}`);
      }
      job.endedMs = Date.now();
      this.emit('change', job);
      this.emit('end', job);
    })();
    return job;
  }

  /** Resolves when the job has ended. */
  wait(job: Job): Promise<Job> {
    if (job.state !== 'running') return Promise.resolve(job);
    return new Promise((resolve) => {
      const on = (j: Job) => {
        if (j.id !== job.id) return;
        this.off('end', on);
        resolve(j);
      };
      this.on('end', on);
    });
  }
}
