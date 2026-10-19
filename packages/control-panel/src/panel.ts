// The panel's services behind the HTTP routes: jobs (web build, package build, host rebuild,
// icon render), the built package list, the host runner, and quitting.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultIcon } from '../../app-icon/src/icon.ts';
import { log } from './env.ts';
import { hostFreshness, hostPaths, listProviders, pluginBinDirs, rebuildHost } from './host-build.ts';
import { HostRunner, type RunMode } from './host-runner.ts';
import { HttpError, readJson, sendJson, type EventHub } from './http.ts';
import { JobRefused, JobRunner, runProcess, type Job, type JobContext } from './jobs.ts';
import { discoverPackagers, packagerFor, platformsFor, targetOf, type BuildTarget, type IdentityField, type PackagerDiscovery } from './packagers.ts';
import { PackageList } from './packages.ts';
import { ARCHIVE, buildTargetOf, compareVersions, defaultEntry, discoverAll, identityOf, isArchivedId, liveId, MANIFEST, MoveRefused, nextVersion, PROJECTS, saveManifest, selectionOf, validateManifest, type FieldError, type Manifest, type Project } from './projects.ts';
import { archiveProject, unarchiveProject } from './layout.ts';

/** Providers compiled into xrb-host: never shipped as plugin folders. */
const BUILTIN_PROVIDERS = new Set(['desktop', 'none', 'replay', 'simulated']);
const TARGET_LABEL: Record<BuildTarget, string> = { host: 'Host', webxr: 'WebXR headset' };
const APP_ICON = path.join('packages', 'app-icon', 'src', 'cli.ts');
const OPEN_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'open-folder.ps1');
const RECYCLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recycle.ps1');

const jobSummary = (j: Job) => ({ ...j, lines: undefined });

/** Whether and how a project can be packaged (shown by the UI, enforced by packageBuild). */
export interface Packaging {
  available: boolean;
  /** the project's platform ("" standalone) */
  platform: string;
  packager: string | null;
  /** identity fields the packager declares */
  fields: IdentityField[];
  /** the packager's complaints about the project's identity, as manifest fields (package.<key>) */
  errors: FieldError[];
  /** why packaging is unavailable */
  reason: string | null;
}

export class Panel {
  readonly jobs = new JobRunner();
  readonly runner = new HostRunner();
  readonly packages: PackageList;
  /** the core repo (host build, templates) */
  readonly repo: string;
  /** the user's workspace (projects, plugins, packages) */
  readonly workspace: string;
  /** packager plugins found in the workspace (loadPackagers) */
  packagers: PackagerDiscovery = { found: [], problems: [] };
  onQuit: () => void = () => {};

  constructor(repo: string, workspace: string, hub: EventHub) {
    this.repo = repo;
    this.workspace = workspace;
    this.packages = new PackageList(path.join(workspace, 'builds'));
    this.jobs.on('change', (j: Job) => {
      hub.send('job', jobSummary(j));
      if (j.state !== 'running') hub.send('projects-changed', { projectId: j.projectId });
    });
    this.jobs.on('line', (j: Job, text: string) => hub.send('job-line', { id: j.id, text }));
    this.runner.on('state', (s) => {
      hub.send('run', s);
      hub.send('projects-changed', { projectId: s.projectId });
    });
    this.runner.on('status', (s) => hub.send('status', s));
    this.runner.on('log', (text) => hub.send('run-log', text));
  }

  private startJob(...args: Parameters<JobRunner['start']>): Job {
    try {
      const job = this.jobs.start(...args);
      log(`[job ${job.id}] ${job.title}`);
      void this.jobs.wait(job).then((j) => log(`[job ${j.id}] ${j.state}${j.error ? `: ${j.error}` : ''}`));
      return job;
    } catch (e) {
      if (e instanceof JobRefused) throw new HttpError(409, e.message);
      throw e;
    }
  }

  private manifestOf(p: Project): Manifest {
    if (!p.manifest) throw new HttpError(409, `${p.id}: the manifest has errors`, p.errors);
    return p.manifest;
  }

  private entryOf(p: Project, m: Manifest): string {
    return path.resolve(p.dir, m.entry ?? defaultEntry(m.kind));
  }

  /** Re-reads the project (its manifest may have changed during a job) and applies `change`. */
  private async updateManifest(projectId: string, change: (m: Manifest) => Manifest): Promise<void> {
    const p = (await discoverAll(this.workspace)).find((x) => x.id === projectId);
    if (!p?.manifest) return;
    const next = change(p.manifest);
    if (validateManifest(next, p.dir).length) return;
    await saveManifest(p.dir, next, p.manifestMtimeMs);
  }

  /**
   * xrb-host options from the manifest: the providers and their plugin sections as a config file
   * (--config; the host reads `{ input, display, platform, plugins }`), the host section and the icon.
   */
  async hostArgs(p: Project, m: Manifest): Promise<string[]> {
    const h = m.host ?? {};
    const config = path.join(os.tmpdir(), 'xrb-runs', `${p.id.replace(/[\\/:]/g, '_')}.json`);
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, JSON.stringify({ ...selectionOf(m), plugins: m.plugins ?? {} }, null, 2));
    // Plugins are built into the workspace, each into its own bin/ (user-workspace: Host loads workspace plugins).
    const args: string[] = [`--config=${config}`, ...pluginBinDirs(this.workspace).map((d) => `--plugin-dir=${d}`)];
    if (h.recordHands) {
      const file = path.resolve(p.dir, h.recordHands);
      await fs.mkdir(path.dirname(file), { recursive: true });
      args.push(`--record-hands=${file}`);
    }
    const icon = m.icon ? path.resolve(p.dir, m.icon) : null;
    if (icon && (await fs.access(icon).then(() => true, () => false))) args.push(`--icon=${icon}`);
    else if (!m.icon && m.iconColor && m.iconColor !== 'blue') {
      // The host's built-in icon is the blue default: a coloured default goes in as a PNG.
      const file = path.join(os.tmpdir(), 'xrb-icons', `default-${m.iconColor}.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, defaultIcon(256, m.iconColor));
      args.push(`--icon=${file}`);
    }
    args.push(...(h.args ?? []));
    return args;
  }

  webBuild(p: Project): Job {
    const m = this.manifestOf(p);
    const script = m.scripts?.build;
    if (!script) throw new HttpError(400, `${p.id} has no build script`);
    return this.startJob('web-build', p.id, `build: ${m.name}`, async (ctx) => {
      await this.ensureInstalled(ctx);
      // pnpm is a .cmd file: it runs through cmd.exe. Script names are plain names (manifest rules).
      await ctx.run('cmd.exe', ['/d', '/s', '/c', `pnpm run ${script}`], { cwd: p.dir, env: { ...process.env, ...this.appEnv() } });
    });
  }

  /** Environment of an app script: XRB_CORE names the core whose SDK the app is built with (app-sdk-supply). */
  appEnv(): Record<string, string> {
    return { XRB_CORE: this.repo };
  }

  /** `pnpm install` in the workspace when it has never been installed (a fresh workspace or clone). */
  async ensureInstalled(ctx: Pick<JobContext, 'run' | 'line'>): Promise<void> {
    if (await fs.access(path.join(this.workspace, 'node_modules')).then(() => true, () => false)) return;
    ctx.line(`installing the workspace's packages (pnpm install in ${this.workspace})`);
    await ctx.run('cmd.exe', ['/d', '/s', '/c', 'pnpm install'], { cwd: this.workspace });
  }

  /** Built plugins by the name they report (`xrb-host --list-plugins`) -> the folder holding their files. */
  async pluginDirs(): Promise<Record<string, string>> {
    const list = await listProviders(this.repo, this.workspace);
    return Object.fromEntries(list.providers.filter((p) => !p.builtin && p.path).map((p) => [p.name, path.dirname(p.path!)]));
  }

  /** Selected plugins the host does not find (not built in the workspace). */
  async missingPlugins(names: string[]): Promise<string[]> {
    const dirs = await this.pluginDirs();
    return names.filter((n) => !dirs[n]);
  }

  /** Finds the packager plugins; problems are logged, never fatal. */
  async loadPackagers(): Promise<void> {
    this.packagers = await discoverPackagers(this.repo, this.workspace);
    for (const f of this.packagers.found) log(`[panel] packager ${f.packager.name} from ${f.dir}`);
    for (const problem of this.packagers.problems) log(`[panel] packager not loaded: ${problem}`);
  }

  packagingOf(m: Manifest | null): Packaging {
    const none = (platform: string, reason: string): Packaging => ({ available: false, platform, packager: null, fields: [], errors: [], reason });
    if (!m) return none('', 'the manifest has errors');
    if (m.kind !== 'app') return none('', 'test projects are not packaged');
    const platform = selectionOf(m).platform;
    if (!platform) return none('', 'the app runs standalone (no platform)');
    const found = packagerFor(this.packagers, platform);
    if (!found) return none(platform, `no packager plugin for platform "${platform}"`);
    const target = buildTargetOf(m);
    if (targetOf(found.packager) !== target) return none(platform, `the "${platform}" packager builds for the ${TARGET_LABEL[targetOf(found.packager)]} target, the app is set to ${TARGET_LABEL[target]}`);
    const errors = found.packager.validate(identityOf(m) ?? {}).map((e) => ({ field: `plugins.${platform}.${e.field}`, message: e.message }));
    return { available: true, platform, packager: found.packager.name, fields: found.packager.identityFields, errors, reason: null };
  }

  async packageBuild(p: Project, body: { version?: string; confirm?: string[] }): Promise<Job> {
    const m = this.manifestOf(p);
    const packaging = this.packagingOf(m);
    if (!packaging.available) throw new HttpError(409, `packaging unavailable: ${packaging.reason}`);
    const id = identityOf(m);
    if (!id) throw new HttpError(400, `${p.id} has no package identity (plugins.${packaging.platform})`);
    const str = (k: string) => (typeof id[k] === 'string' ? (id[k] as string) : undefined);
    if (packaging.errors.length) throw new HttpError(400, packaging.errors.map((e) => e.message).join('; '), { errors: packaging.errors });
    const entry = this.entryOf(p, m);
    if (!(await fs.access(path.join(entry, 'index.html')).then(() => true, () => false)))
      throw new HttpError(400, `${path.relative(this.workspace, entry)} has no index.html: run Build first`);
    const version = body.version ?? str('version') ?? '0.1.0';
    const confirm = new Set(body.confirm ?? []);
    const zipVersion = str('id') ? await this.packages.versionOf(str('id')!) : null;
    const last = [str('lastPackaged'), zipVersion ?? undefined].filter((v): v is string => !!v).sort(compareVersions).pop();
    if (last && compareVersions(version, last) <= 0 && !confirm.has('version'))
      throw new HttpError(409, `version ${version} is not higher than ${last}, which was already packaged: a station may reject a version that exists. Use ${nextVersion(last)}?`, { needsConfirm: 'version', suggested: nextVersion(last) });
    // A headset package carries the web app only: no host, no plugins (packager contract, target webxr).
    const headset = buildTargetOf(m) === 'webxr';
    let runtimeDir = '', pluginDirs: Record<string, string> = {}, plugins: string[] = [];
    const selection = selectionOf(m);
    if (!headset) {
      const fresh = hostFreshness(this.repo, this.workspace);
      if (!fresh.exists) throw new HttpError(409, 'xrb-host.exe is not built: rebuild the host first');
      if (fresh.outdated && !confirm.has('host'))
        throw new HttpError(409, `xrb-host.exe is older than ${fresh.newestSource}: the package would ship an outdated host. Rebuild the host first?`, { needsConfirm: 'host' });
      // The selected providers that are plugins go into the package; each must be built in the workspace.
      runtimeDir = hostPaths(this.repo).releaseDir;
      const built = await this.pluginDirs();
      plugins = [selection.input, selection.display, selection.platform].filter((n) => n && !BUILTIN_PROVIDERS.has(n));
      const missing = plugins.filter((n) => !built[n]);
      if (missing.length) throw new HttpError(409, `plugin ${missing.join(', ')} is not built in the workspace: rebuild the host first`);
      pluginDirs = Object.fromEntries(plugins.map((n) => [n, built[n]]));
    }
    const packager = packagerFor(this.packagers, packaging.platform)!.packager;
    const identity = Object.fromEntries(Object.entries({ ...id, version }).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const label = str('id') ?? m.name;
    const platform = packaging.platform;
    return this.startJob('package', p.id, `package (${packager.name}): ${label} ${version}`, async (ctx: JobContext) => {
      ctx.line(headset
        ? `${packager.name} package of ${p.id} ${version}: WebXR headset app (no host)`
        : `${packager.name} package of ${p.id} ${version}: ${selection.display} + ${selection.input} + ${selection.platform}; plugins ${plugins.join(', ') || 'none'}`);
      const r = await packager.build({
        app: entry, runtimeDir, ...(headset ? {} : { pluginDirs }), plugins, selection, identity,
        icon: m.icon ? path.resolve(p.dir, m.icon) : undefined, iconColor: m.iconColor,
        out: path.join(this.workspace, 'builds'), log: (msg) => ctx.line(msg),
      });
      await this.updateManifest(p.id, (cur) => ({ ...cur, plugins: { ...cur.plugins, [platform]: { ...cur.plugins?.[platform], lastPackaged: version, version: nextVersion(version) } } }));
      ctx.line(`package ${label} ${version}: ${r.file} (${(r.sizeBytes / 1e9).toFixed(2)} GB). Next version: ${nextVersion(version)}`);
      return { zip: r.file, sizeBytes: r.sizeBytes, version };
    });
  }

  renderIcon(p: Project): Job {
    const m = this.manifestOf(p);
    const entry = this.entryOf(p, m);
    const rel = m.icon ?? 'icon.png';
    return this.startJob('icon-render', p.id, `icon render: ${m.name}`, async (ctx) => {
      await ctx.run(process.execPath, [APP_ICON, 'render', '--app', entry, '--out', path.resolve(p.dir, rel), '--runtime', hostPaths(this.repo).releaseDir], { cwd: this.repo });
      if (!m.icon) await this.updateManifest(p.id, (cur) => ({ ...cur, icon: rel }));
    });
  }

  /** flat: 2D mode, the app starts mono without the 3D effect (--view=2d); switchable while it runs. */
  async run(p: Project, mode: RunMode, flat = false, cameraView = false): Promise<void> {
    const m = this.manifestOf(p);
    if (buildTargetOf(m) === 'webxr') throw new HttpError(409, `${p.id} is a WebXR headset app: open it in a browser, or build a package for the headset`);
    const fresh = hostFreshness(this.repo, this.workspace);
    if (!fresh.exists) throw new HttpError(409, 'xrb-host.exe is not built: rebuild the host first');
    if (this.runner.busy) throw new HttpError(409, `${this.runner.projectId} is running: stop it first`);
    const selection = selectionOf(m);
    const missing = await this.missingPlugins([selection.input, selection.display, selection.platform].filter((n) => n && !BUILTIN_PROVIDERS.has(n)));
    if (missing.length) throw new HttpError(409, `plugin ${missing.join(', ')} is not built in the workspace: rebuild the host first`, { needsRebuild: true });
    if (mode === 'dev') {
      const lines: string[] = [];
      try {
        await this.ensureInstalled({ line: (l) => log(`[panel] ${l}`), run: async (cmd, args, opts) => {
          const code = await runProcess(cmd, args, (l) => lines.push(l), opts);
          if (code !== 0) throw new Error(`pnpm install failed (code ${code}): ${lines.slice(-5).join(' / ')}`);
        } });
      } catch (e) {
        throw new HttpError(500, (e as Error).message);
      }
    }
    try {
      await this.runner.start({
        projectId: p.id, mode, hostExe: fresh.exe, projectDir: p.dir, entryDir: this.entryOf(p, m),
        devScript: m.scripts?.dev, devEnv: this.appEnv(), flat, cameraView, hostArgs: [...(await this.hostArgs(p, m)), ...(flat ? ['--view=2d'] : [])],
      });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  /**
   * Moves a project folder to the Recycle Bin (recoverable). node_modules is removed first and
   * for good: it is pnpm links into the shared store (recycling them is slow and could reach the
   * store), and `pnpm install` recreates it.
   */
  private refuseIfBusy(id: string): void {
    if (this.runner.projectId === id) throw new HttpError(409, `${id} is running: stop it first`);
    const busy = this.jobs.running().find((j) => j.projectId === id);
    if (busy) throw new HttpError(409, `${busy.title} is running for this project`);
  }

  /** Archive (projects/<section>/x -> projects/archive/x) or unarchive (back to its section). */
  private async move(p: Project, toArchive: boolean): Promise<void> {
    try {
      const to = toArchive ? await archiveProject(this.workspace, p) : await unarchiveProject(this.workspace, p);
      log(`[projects] ${p.id} ${toArchive ? 'archived' : 'unarchived'}: ${path.relative(this.workspace, to)}`);
    } catch (e) {
      if (e instanceof MoveRefused) throw new HttpError(409, e.message);
      throw e;
    }
  }

  async deleteProject(p: Project): Promise<void> {
    this.refuseIfBusy(p.id);
    const rel = path.relative(this.workspace, p.dir);
    // projects/<section>/x, or projects/archive/x
    const segs = rel.split(path.sep);
    if (segs.length !== 3 || segs[0] !== PROJECTS || !segs[1] || !segs[2]) throw new HttpError(400, `not a project folder: ${rel}`);
    await fs.rm(path.join(p.dir, 'node_modules'), { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RECYCLE, '-Path', p.dir],
        { windowsHide: true }, (err, _out, stderr) => (err ? reject(new HttpError(500, `could not move ${rel} to the Recycle Bin: ${stderr.trim() || err.message}`)) : resolve()));
    });
    log(`[projects] ${rel} moved to the Recycle Bin`);
  }

  /** Opens a folder in Explorer or a file in its default app, in front of the browser (open-folder.ps1). */
  openInShell(target: string): void {
    log(`[panel] open ${target}`);
    // explorer.exe started directly opens the window reliably (through PowerShell it often did
    // not); the helper then only waits for that window and brings it to the front.
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OPEN_FOLDER, '-Path', target, '-FocusOnly'],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  /** Routes under /api/projects/<id>/... ; true when handled. */
  async projectRoute(method: string, p: Project, rest: string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (method !== 'POST' || rest.length !== 1) return false;
    switch (rest[0]) {
      case 'build-web':
        sendJson(res, 202, jobSummary(this.webBuild(p)));
        return true;
      case 'package':
        sendJson(res, 202, jobSummary(await this.packageBuild(p, await readJson(req))));
        return true;
      case 'render-icon':
        sendJson(res, 202, jobSummary(this.renderIcon(p)));
        return true;
      case 'delete':
        await this.deleteProject(p);
        sendJson(res, 200, { deleted: p.id });
        return true;
      case 'archive':
        if (isArchivedId(p.id)) throw new HttpError(409, `${p.id} is already archived`);
        this.refuseIfBusy(p.id);
        await this.move(p, true);
        sendJson(res, 200, { archived: p.id, id: `${ARCHIVE}/${p.id}` });
        return true;
      case 'unarchive':
        if (!isArchivedId(p.id)) throw new HttpError(409, `${p.id} is not archived`);
        this.refuseIfBusy(p.id);
        await this.move(p, false);
        sendJson(res, 200, { unarchived: p.id, id: liveId(p.id) });
        return true;
      case 'open-folder':
        this.openInShell(p.dir);
        sendJson(res, 200, { opened: p.dir });
        return true;
      case 'open-manifest':
        this.openInShell(path.join(p.dir, MANIFEST));
        sendJson(res, 200, { opened: true });
        return true;
      case 'run': {
        const { mode, flat, cameraView } = await readJson<{ mode?: RunMode; flat?: boolean; cameraView?: boolean }>(req);
        await this.run(p, mode === 'dev' ? 'dev' : 'built', flat === true, cameraView === true);
        sendJson(res, 200, this.runner.state());
        return true;
      }
    }
    return false;
  }

  /** Other /api routes; true when handled. */
  async route(method: string, api: string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const key = `${method} ${api.join('/')}`;
    switch (key) {
      case 'GET jobs':
        sendJson(res, 200, { jobs: this.jobs.list() });
        return true;
      case 'POST jobs/clear':
        sendJson(res, 200, { removed: this.jobs.clearFinished(), jobs: this.jobs.list() });
        return true;
      case 'GET packages':
        sendJson(res, 200, { packages: await this.packages.list() });
        return true;
      case 'POST packages/open-folder': {
        const out = path.join(this.workspace, 'builds');
        await fs.mkdir(out, { recursive: true });
        this.openInShell(out);
        sendJson(res, 200, { opened: out });
        return true;
      }
      case 'GET host':
        sendJson(res, 200, { ...hostFreshness(this.repo, this.workspace), workspace: this.workspace });
        return true;
      case 'GET plugins':
        // What a project can select: the host's providers, and the platforms a packager plugin packages for
        // (`packagers`: for host apps; `headsetPlatforms`: for WebXR headset apps).
        sendJson(res, 200, {
          ...(await listProviders(this.repo, this.workspace)),
          packagers: platformsFor(this.packagers, 'host'), headsetPlatforms: platformsFor(this.packagers, 'webxr'), packagerProblems: this.packagers.problems,
        });
        return true;
      case 'POST host/rebuild':
        if (this.runner.busy) throw new HttpError(409, 'stop the running host first: its exe is locked while it runs');
        sendJson(res, 202, jobSummary(this.startJob('host-rebuild', null, 'rebuild xrb-host', (ctx) => rebuildHost(this.repo, this.workspace, ctx))));
        return true;
      case 'GET run':
        sendJson(res, 200, { state: this.runner.state(), log: this.runner.logLines() });
        return true;
      case 'POST run/clear-log':
        this.runner.clearLog();
        sendJson(res, 200, { cleared: true });
        return true;
      case 'POST run/stop':
        await this.runner.stop();
        sendJson(res, 200, this.runner.state());
        return true;
      case 'POST run/view': {
        const { flat } = await readJson<{ flat?: boolean }>(req);
        try {
          await this.runner.setView(flat === true);
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
        sendJson(res, 200, this.runner.state());
        return true;
      }
      case 'POST run/stop-foreign': {
        const { pid } = await readJson<{ pid?: number }>(req);
        if (!pid || !this.runner.state().foreign.some((f) => f.pid === pid)) throw new HttpError(400, 'not a host reported as running elsewhere');
        await this.runner.stopForeign(pid);
        sendJson(res, 200, this.runner.state());
        return true;
      }
      case 'POST quit': {
        const { confirm } = await readJson<{ confirm?: boolean }>(req);
        const busy = [this.runner.busy ? `${this.runner.projectId} is running` : '', ...this.jobs.running().map((j) => `${j.title} is running`)].filter(Boolean);
        if (busy.length && !confirm) throw new HttpError(409, `${busy.join('; ')}. Quit anyway? The host is stopped cleanly first.`, { needsConfirm: 'quit' });
        sendJson(res, 200, { quitting: true });
        log('[panel] quit requested');
        setTimeout(() => this.onQuit(), 50);
        return true;
      }
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this.runner.busy) await this.runner.stop();
  }
}
