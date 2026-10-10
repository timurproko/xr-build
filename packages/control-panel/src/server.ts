#!/usr/bin/env node
// XR Build control panel: a local server (127.0.0.1 only) with a browser UI for the
// projects in the user's workspace (projects/<section>/<project>): settings, web and package builds, runs on the
// display, live status and debug views. Start: start.vbs (no console) or `pnpm panel`.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultIcon } from '../../app-icon/src/icon.ts';
import { DEFAULT_PORT, log, openLog, PANEL_DIR, REPO, WORKSPACE } from './env.ts';
import { checkRequest, EventHub, HttpError, readBody, readJson, sendJson, serveStatic } from './http.ts';
import {
  ARCHIVE,
  defaultEntry,
  defaultManifest,
  discoverAll,
  discoverArchived,
  discoverProjects,
  identityOf,
  isArchivedId,
  isInside,
  MoveRefused,
  PROJECTS,
  UNSORTED,
  ManifestConflictError,
  MANIFEST,
  saveManifest,
  unregisteredApps,
  type Manifest,
  type Project,
} from './projects.ts';
import { Panel } from './panel.ts';
import { applyLayout, readLayout, validateLayout, type Layout } from './layout.ts';
import { createProject, createWorkspace, isWorkspace, ProjectRefused, writeEditorConfig } from './workspace.ts';

export const APP_NAME = 'xrb-control-panel';
const ICON_LIMIT = 8 * 1024 * 1024;

export interface ServerOptions {
  /** the core repo (default: the one the panel runs from) */
  repo?: string;
  /** the user's workspace (default: XRB_HOME or ~/.xr-build) */
  workspace?: string;
  port?: number;
  /** override for tests: the panel's services */
  panel?: Panel;
}

export interface PanelServer {
  server: http.Server;
  panel: Panel;
  hub: EventHub;
  port: number;
  url: string;
  close(): Promise<void>;
}

const isPng = (b: Buffer) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;

/** Project for an id ("x", or "archive/x" when archived), or a 404. */
async function findProject(repo: string, id: string): Promise<Project> {
  const p = (await discoverAll(repo)).find((x) => x.id === id);
  if (!p) throw new HttpError(404, `no project ${id}`);
  return p;
}

function usable(p: Project): Manifest {
  if (!p.manifest) throw new HttpError(409, `${p.id}: the manifest has errors`, p.errors);
  return p.manifest;
}

export function entryDir(p: Project, m: Manifest): string {
  return path.resolve(p.dir, m.entry ?? defaultEntry(m.kind));
}

export function iconPath(p: Project, m: Manifest | null): string | null {
  return m?.icon ? path.resolve(p.dir, m.icon) : null;
}

async function mtime(file: string | null): Promise<number | null> {
  if (!file) return null;
  return fs.stat(file).then((s) => s.mtimeMs, () => null);
}

/** A project as the UI sees it (`repo`: the workspace the project is in). */
export async function describeProject(repo: string, p: Project, panel: Panel) {
  const m = p.manifest;
  const entry = m ? entryDir(p, m) : null;
  const webBuildMs = entry ? await mtime(path.join(entry, 'index.html')) : null;
  const icon = iconPath(p, m);
  const iconMs = await mtime(icon);
  const packageId = m ? identityOf(m)?.id : undefined;
  const zipMs = typeof packageId === 'string' ? await mtime(path.join(repo, 'builds', `${packageId}.zip`)) : null;
  return {
    id: p.id,
    section: p.section,
    dir: path.relative(repo, p.dir).split(path.sep).join('/'),
    manifest: m,
    errors: p.errors,
    manifestMtimeMs: p.manifestMtimeMs,
    entryExists: webBuildMs !== null,
    webBuildMs,
    icon: { custom: iconMs !== null, mtimeMs: iconMs, changedSincePackage: iconMs !== null && zipMs !== null && iconMs > zipMs },
    running: panel.runner.projectId === p.id,
    canDev: !!m?.scripts?.dev,
    archived: isArchivedId(p.id),
    packaging: panel.packagingOf(m),
  };
}

export function createServer(opts: ServerOptions = {}): PanelServer {
  const core = opts.repo ?? REPO;
  // `repo` below is where the projects are: the workspace.
  const repo = opts.workspace ?? opts.panel?.workspace ?? WORKSPACE;
  const port = opts.port ?? DEFAULT_PORT;
  const hub = new EventHub();
  const panel = opts.panel ?? new Panel(core, repo, hub);
  const uiDir = path.join(PANEL_DIR, 'ui');

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const reject = checkRequest(method, req.headers, port);
    if (reject) throw new HttpError(403, reject);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'preview') {
      // /preview/[archive/]<project>/<file...>: a project's entry folder, for the icon studio.
      const n = parts[1] === ARCHIVE ? 2 : 1;
      const p = await findProject(repo, parts.slice(1, 1 + n).join('/'));
      return serveStatic(res, entryDir(p, usable(p)), url.pathname.split('/').slice(2 + n).join('/'));
    }
    if (parts[0] !== 'api') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      return serveStatic(res, uiDir, url.pathname === '/' ? 'index.html' : url.pathname);
    }

    const api = parts.slice(1).map(decodeURIComponent);
    const is = (m: string, ...segs: string[]) => method === m && api.length === segs.length && segs.every((s, i) => s === '*' || s === api[i]);

    if (is('GET', 'ping')) return sendJson(res, 200, { app: APP_NAME, repo: core, workspace: repo });
    if (is('GET', 'workspace')) return sendJson(res, 200, { path: repo, exists: await isWorkspace(repo) });
    if (is('POST', 'workspace', 'open-folder')) {
      await fs.mkdir(repo, { recursive: true });
      panel.openInShell(repo);
      return sendJson(res, 200, { opened: repo });
    }
    if (is('POST', 'workspace', 'create')) {
      const added = await createWorkspace(core, repo);
      await writeEditorConfig(core, repo);
      log(`[workspace] ${repo}: added ${added.length} files`);
      await panel.loadPackagers();
      hub.send('projects-changed', {});
      return sendJson(res, 200, { path: repo, added });
    }
    if (is('POST', 'projects', 'new')) {
      const { folder, name } = await readJson<{ folder?: string; name?: string }>(req);
      if (!folder) throw new HttpError(400, 'folder missing');
      try {
        await createProject(core, repo, folder, name?.trim() || folder);
      } catch (e) {
        if (e instanceof ProjectRefused) throw new HttpError(409, e.message);
        throw e;
      }
      log(`[projects] created ${folder} from the template (projects/${UNSORTED}/${folder})`);
      hub.send('projects-changed', {});
      return sendJson(res, 200, await describeProject(repo, await findProject(repo, folder), panel));
    }
    if (is('GET', 'events')) {
      hub.attach(res);
      hub.send('run', panel.runner.state());
      return;
    }
    if (is('GET', 'projects')) {
      const [projects, archived] = await Promise.all([discoverProjects(repo), discoverArchived(repo)]);
      return sendJson(res, 200, {
        projects: await Promise.all(projects.map((p) => describeProject(repo, p, panel))),
        archived: await Promise.all(archived.map((p) => describeProject(repo, p, panel))),
        layout: await readLayout(repo, projects),
        unregistered: await unregisteredApps(repo),
      });
    }
    if (is('PUT', 'layout')) {
      const l = await readJson<Layout>(req);
      const problem = validateLayout(l);
      if (problem) throw new HttpError(400, problem);
      try {
        await applyLayout(repo, l, await discoverProjects(repo));
      } catch (e) {
        if (e instanceof MoveRefused) throw new HttpError(409, e.message);
        throw e;
      }
      hub.send('projects-changed', {});
      return sendJson(res, 200, { saved: true });
    }
    if (is('POST', 'projects', 'create')) {
      const { id } = await readJson<{ id?: string }>(req);
      if (!id || !(await unregisteredApps(repo)).includes(id)) throw new HttpError(400, `${id} is not an app folder without a manifest`);
      const dir = path.join(repo, PROJECTS, id);
      // The new app runs like the workspace's first app (same providers and platform).
      const like = (await discoverProjects(repo)).find((x) => x.manifest?.kind === 'app')?.manifest ?? null;
      const r = await saveManifest(dir, await defaultManifest(dir, like));
      if (r.errors.length) throw new HttpError(400, 'default manifest is invalid', r.errors);
      log(`[projects] created ${id}/${MANIFEST}`);
      return sendJson(res, 200, await describeProject(repo, await findProject(repo, path.basename(dir)), panel));
    }
    // /api/projects/[archive/]<project>/...
    if (api[0] === 'projects' && api.length >= 2) {
      const n = api[1] === ARCHIVE ? 2 : 1;
      const id = api.slice(1, 1 + n).join('/');
      const rest = api.slice(1 + n);
      const p = await findProject(repo, id);
      if (method === 'GET' && rest.length === 0) return sendJson(res, 200, await describeProject(repo, p, panel));
      if (method === 'PUT' && rest[0] === 'manifest' && rest.length === 1) {
        const body = await readJson<{ manifest?: Manifest; mtimeMs?: number }>(req);
        if (!body.manifest) throw new HttpError(400, 'manifest missing');
        try {
          const r = await saveManifest(p.dir, body.manifest, body.mtimeMs);
          if (r.errors.length) return sendJson(res, 400, { error: 'invalid settings', fields: r.errors });
        } catch (e) {
          if (e instanceof ManifestConflictError) throw new HttpError(409, e.message);
          throw e;
        }
        log(`[projects] saved ${id}/${MANIFEST}`);
        return sendJson(res, 200, await describeProject(repo, await findProject(repo, id), panel));
      }
      if (rest[0] === 'icon' && rest.length === 1) {
        if (method === 'GET') {
          const file = iconPath(p, p.manifest);
          const png = file ? await fs.readFile(file).catch(() => null) : null;
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          res.end(png ?? defaultIcon(256, p.manifest?.iconColor));
          return;
        }
        if (method === 'PUT') {
          const m = usable(p);
          const png = await readBody(req, ICON_LIMIT);
          if (!isPng(png)) throw new HttpError(400, 'the icon must be a PNG');
          const rel = m.icon ?? 'icon.png';
          const file = path.resolve(p.dir, rel);
          if (!isInside(p.dir, rel)) throw new HttpError(400, 'icon path outside the project');
          await fs.writeFile(file, png);
          if (!m.icon) await saveManifest(p.dir, { ...m, icon: rel }, p.manifestMtimeMs);
          log(`[projects] icon of ${id} written (${png.length} bytes)`);
          const d = await describeProject(repo, await findProject(repo, id), panel);
          hub.send('project', d);
          return sendJson(res, 200, d);
        }
      }
      const handled = await panel.projectRoute(method, p, rest, req, res);
      if (handled) return;
    }
    if (await panel.route(method, api, req, res)) return;
    throw new HttpError(404, `no route ${method} ${url.pathname}`);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log(`[http] ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: (e as Error).message, details: e instanceof HttpError ? e.details : undefined });
    });
  });
  const url = `http://127.0.0.1:${port}/`;
  panel.onQuit = () => void closeServer();
  async function closeServer() {
    hub.closeAll();
    await panel.dispose();
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
  }
  return { server, panel, hub, port, url, close: closeServer };
}

/** What answers on the port: our panel, something else, or nothing. */
export async function probe(port: number): Promise<'panel' | 'other' | 'free'> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: `127.0.0.1:${port}` }, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === APP_NAME ? 'panel' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

/** Opens a URL in the default browser without a console window. */
export function openBrowser(url: string): void {
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Single-instance start (design D2): when a panel already answers on the port, only open the
 * browser on it; when another program holds the port, give up with a message.
 */
export async function launch(opts: { port: number; open: boolean; repo?: string; workspace?: string; browser?: (url: string) => void }): Promise<
  { result: 'started'; server: PanelServer } | { result: 'already-running' | 'port-taken'; server: null }
> {
  const browser = opts.browser ?? openBrowser;
  const url = `http://127.0.0.1:${opts.port}/`;
  const state = await probe(opts.port);
  if (state === 'panel') {
    log(`[panel] already running at ${url}`);
    if (opts.open) browser(url);
    return { result: 'already-running', server: null };
  }
  if (state === 'other') {
    log(`[panel] port ${opts.port} is used by another program; set XRB_PANEL_PORT to use another port`);
    return { result: 'port-taken', server: null };
  }
  const s = createServer({ port: opts.port, repo: opts.repo, workspace: opts.workspace });
  // Workspace packagers load the core's modules from XRB_CORE (they never import it by a relative path).
  process.env.XRB_CORE ??= s.panel.repo;
  await s.panel.loadPackagers();
  if (await isWorkspace(s.panel.workspace)) await writeEditorConfig(s.panel.repo, s.panel.workspace).catch((e) => log(`[workspace] jsconfig.json not written: ${(e as Error).message}`));
  await new Promise<void>((resolve, reject) => {
    s.server.once('error', reject);
    s.server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  log(`[panel] listening on ${url} (core ${s.panel.repo}, workspace ${s.panel.workspace})`);
  if (opts.open) browser(url);
  return { result: 'started', server: s };
}

async function main(): Promise<void> {
  const port = Number(process.env.XRB_PANEL_PORT) || DEFAULT_PORT;
  openLog((await probe(port)) === 'free');
  const r = await launch({ port, open: process.argv.includes('--open') });
  if (r.result === 'port-taken') process.exitCode = 1;
  if (r.server) {
    const s = r.server;
    s.panel.onQuit = () => {
      void s.close().then(() => {
        log('[panel] stopped');
        process.exit(0);
      });
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    log(`[panel] ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  });
}
