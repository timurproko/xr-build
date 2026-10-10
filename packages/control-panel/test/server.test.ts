import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { checkRequest } from '../src/http.ts';
import { freePort } from '../src/host-runner.ts';
import { launch, type PanelServer } from '../src/server.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let repo: string;
let port: number;
let panel: PanelServer;

async function write(rel: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), data);
}

/** Raw request with explicit headers (fetch would set Host and Origin itself). */
function request(method: string, urlPath: string, opts: { host?: string; origin?: string | null; body?: string | Buffer; type?: string } = {}) {
  return new Promise<{ status: number; body: string; json: any }>((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? `http://127.0.0.1:${port}`;
    if (opts.body !== undefined) headers['content-type'] = opts.type ?? 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body, json });
      });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-server-'));
  await write('projects/Apps/demo/xrb-project.json', JSON.stringify({ name: 'Demo', kind: 'app', entry: 'dist', platform: 'station', plugins: { station: { id: 'Demo', title: 'Demo', version: '0.1.0' } } }));
  await write('projects/Apps/demo/dist/index.html', '<h1>demo</h1>');
  await write('projects/Apps/demo/secret.txt', 'outside the entry folder');
  await write('projects/Unsorted/plain/package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
  await write('projects/Tests/rig-check/xrb-project.json', JSON.stringify({ name: 'Rig check', kind: 'test', entry: '.' }));
  await write('projects/Tests/rig-check/index.html', 'rig');
  port = await freePort();
  const r = await launch({ port, open: false, workspace: repo });
  assert.equal(r.result, 'started');
  panel = r.server!;
});

after(async () => {
  await panel.close();
});

test('checkRequest: loopback Host, same-origin writes', () => {
  assert.equal(checkRequest('GET', { host: '127.0.0.1:5180' }, 5180), null);
  assert.equal(checkRequest('GET', { host: 'localhost:5180' }, 5180), null);
  assert.match(checkRequest('GET', { host: 'evil.example:5180' }, 5180)!, /not the panel/);
  assert.match(checkRequest('GET', { host: '127.0.0.1:80' }, 5180)!, /not the panel/);
  assert.equal(checkRequest('POST', { host: '127.0.0.1:5180', origin: 'http://127.0.0.1:5180' }, 5180), null);
  assert.match(checkRequest('POST', { host: '127.0.0.1:5180', origin: 'https://evil.example' }, 5180)!, /origin/);
  assert.match(checkRequest('PUT', { host: '127.0.0.1:5180' }, 5180)!, /origin/);
});

test('rejects a foreign Host and cross-origin writes over HTTP', async () => {
  assert.equal((await request('GET', '/api/ping', { host: 'rebind.example' })).status, 403);
  assert.equal((await request('POST', '/api/projects/create', { origin: 'https://evil.example', body: '{"id":"Unsorted/plain"}' })).status, 403);
  assert.equal((await request('POST', '/api/projects/create', { origin: null, body: '{"id":"Unsorted/plain"}' })).status, 403);
  await assert.rejects(fs.access(path.join(repo, 'projects/Unsorted/plain/xrb-project.json')), 'nothing created');
});

test('a second start finds the running panel and only opens the browser', async () => {
  const opened: string[] = [];
  const r = await launch({ port, open: true, workspace: repo, browser: (u) => opened.push(u) });
  assert.equal(r.result, 'already-running');
  assert.deepEqual(opened, [`http://127.0.0.1:${port}/`]);
});

test('lists projects and unregistered apps', async () => {
  const r = await request('GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.projects.map((p: any) => p.id), ['demo', 'rig-check']);
  const demo = r.json.projects[0];
  assert.equal(demo.entryExists, true);
  assert.equal(demo.icon.custom, false);
  assert.deepEqual(r.json.unregistered, ['Unsorted/plain']);
});

test('saves settings, refuses invalid ones per field and stale ones', async () => {
  const p = (await request('GET', '/api/projects/demo')).json;
  const manifest = { ...p.manifest, plugins: { station: { ...p.manifest.plugins.station, id: 'Demo App', title: 'Demo App' } } };
  const bad = await request('PUT', '/api/projects/demo/manifest', { body: JSON.stringify({ manifest: { ...manifest, plugins: { station: { ...manifest.plugins.station, version: 'v1-beta' } } }, mtimeMs: p.manifestMtimeMs }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.fields.map((f: any) => f.field), ['plugins.station.version']);
  const ok = await request('PUT', '/api/projects/demo/manifest', { body: JSON.stringify({ manifest, mtimeMs: p.manifestMtimeMs }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.manifest.plugins.station.id, 'Demo App');
  const stale = await request('PUT', '/api/projects/demo/manifest', { body: JSON.stringify({ manifest, mtimeMs: p.manifestMtimeMs }) });
  assert.equal(stale.status, 409);
});

test('creates a manifest for an app folder without one', async () => {
  const r = await request('POST', '/api/projects/create', { body: JSON.stringify({ id: 'Unsorted/plain' }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.manifest.kind, 'app');
  assert.equal((await request('POST', '/api/projects/create', { body: JSON.stringify({ id: 'Unsorted/plain' }) })).status, 400, 'only once');
});

test('serves a project entry folder for the icon studio, nothing outside it', async () => {
  const r = await request('GET', '/preview/demo/');
  assert.equal(r.status, 200);
  assert.equal(r.body, '<h1>demo</h1>');
  // The URL parser already folds %2e%2e segments (404: no such project); encoded backslashes
  // reach the static server, which refuses them (403). Either way nothing is served.
  for (const p of ['/preview/demo/%2e%2e/secret.txt', '/preview/demo/..%5csecret.txt', '/preview/demo/%2e%2e%5csecret.txt']) {
    const r = await request('GET', p);
    assert.ok(r.status === 403 || r.status === 404, `${p}: ${r.status}`);
    assert.notEqual(r.body, 'outside the entry folder');
  }
  assert.equal((await request('GET', '/preview/nope/')).status, 404);
});

test('icon upload: PNG only, written to the project and recorded in the manifest', async () => {
  const notPng = await request('PUT', '/api/projects/demo/icon', { body: Buffer.from('GIF89a'), type: 'image/png' });
  assert.equal(notPng.status, 400);
  const ok = await request('PUT', '/api/projects/demo/icon', { body: PNG, type: 'image/png' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.icon.custom, true);
  assert.deepEqual(await fs.readFile(path.join(repo, 'projects/Apps/demo/icon.png')), PNG);
  assert.equal(JSON.parse(await fs.readFile(path.join(repo, 'projects/Apps/demo/xrb-project.json'), 'utf8')).icon, 'icon.png');
  const get = await request('GET', '/api/projects/demo/icon');
  assert.equal(get.status, 200);
});

test('delete moves the project folder to the Recycle Bin; node_modules links never reach their target', { skip: process.platform !== 'win32' }, async () => {
  await write('projects/Tests/scratch/xrb-project.json', JSON.stringify({ name: 'Scratch', kind: 'test', entry: '.' }));
  await write('projects/Tests/scratch/index.html', 'x');
  // pnpm-style node_modules: a junction into a shared store outside the project
  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-store-'));
  await fs.writeFile(path.join(store, 'keep.txt'), 'shared');
  await fs.mkdir(path.join(repo, 'projects/Tests/scratch/node_modules'), { recursive: true });
  await fs.symlink(store, path.join(repo, 'projects/Tests/scratch/node_modules/pkg'), 'junction');

  const r = await request('POST', '/api/projects/scratch/delete', { body: '{}' });
  assert.equal(r.status, 200, r.body);
  await assert.rejects(fs.access(path.join(repo, 'projects/Tests/scratch')), 'folder gone');
  assert.equal(await fs.readFile(path.join(store, 'keep.txt'), 'utf8'), 'shared', 'the store behind the link is untouched');
  const list = await request('GET', '/api/projects');
  assert.ok(!list.json.projects.some((p: any) => p.id === 'scratch'));
  assert.equal((await request('POST', '/api/projects/scratch/delete', { body: '{}' })).status, 404);
});

test('archived projects are full projects under "archive/<id>"; archive and unarchive move them back to their section', async () => {
  await write('projects/Tests/old-check/xrb-project.json', JSON.stringify({ name: 'Old check', kind: 'test', entry: '.' }));
  await write('projects/Tests/old-check/index.html', 'old');
  const a = await request('POST', '/api/projects/old-check/archive', { body: '{}' });
  assert.equal(a.status, 200, a.body);
  assert.equal(a.json.id, 'archive/old-check');
  assert.equal(await fs.readFile(path.join(repo, 'projects/archive/old-check/index.html'), 'utf8'), 'old');
  await assert.rejects(fs.access(path.join(repo, 'projects/Tests/old-check')));

  const list = (await request('GET', '/api/projects')).json;
  assert.ok(!list.projects.some((p: any) => p.id === 'old-check'));
  const arch = list.archived.find((p: any) => p.id === 'archive/old-check');
  assert.equal(arch.manifest.name, 'Old check');
  assert.equal(arch.archived, true);
  assert.equal(arch.entryExists, true);

  // usable like any project: details, icon, preview, settings
  assert.equal((await request('GET', '/api/projects/archive/old-check')).status, 200);
  assert.equal((await request('GET', '/api/projects/archive/old-check/icon')).status, 200);
  assert.equal((await request('GET', '/preview/archive/old-check/')).body, 'old');
  assert.equal((await request('POST', '/api/projects/archive/old-check/archive', { body: '{}' })).status, 409, 'already archived');

  const r = await request('POST', '/api/projects/archive/old-check/unarchive', { body: '{}' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.id, 'old-check');
  assert.equal(await fs.readFile(path.join(repo, 'projects/Tests/old-check/index.html'), 'utf8'), 'old');
  assert.deepEqual((await request('GET', '/api/projects')).json.archived.map((p: any) => p.id), []);

  // never overwrite: unarchiving onto an existing project is refused
  await request('POST', '/api/projects/old-check/archive', { body: '{}' });
  await write('projects/Tests/old-check/xrb-project.json', JSON.stringify({ name: 'New check', kind: 'test', entry: '.' }));
  assert.equal((await request('POST', '/api/projects/archive/old-check/unarchive', { body: '{}' })).status, 409);
  assert.equal((await request('GET', '/api/projects')).json.projects.find((p: any) => p.id === 'old-check').manifest.name, 'New check');
});

test('unknown routes are 404, bad JSON is 400', async () => {
  assert.equal((await request('GET', '/api/nothing')).status, 404);
  assert.equal((await request('PUT', '/api/projects/demo/manifest', { body: '{oops' })).status, 400);
});

test('reports the workspace and creates a new project from the core template', async () => {
  const ws = await request('GET', '/api/workspace');
  assert.deepEqual(ws.json, { path: repo, exists: true });
  const r = await request('POST', '/api/projects/new', { body: JSON.stringify({ folder: 'globe', name: 'Globe' }) });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.id, 'globe');
  assert.equal(r.json.manifest.name, 'Globe');
  assert.ok((await request('GET', '/api/projects')).json.projects.some((p: any) => p.id === 'globe'));
  assert.equal((await request('POST', '/api/projects/new', { body: JSON.stringify({ folder: 'globe' }) })).status, 409, 'never overwrites');
  assert.equal((await request('POST', '/api/projects/new', { body: JSON.stringify({ folder: '../x' }) })).status, 409);
});

test('app scripts run with XRB_CORE set to the core', async () => {
  await write('projects/Apps/envcheck/xrb-project.json', JSON.stringify({ name: 'Env', kind: 'app', entry: 'dist', scripts: { build: 'build' } }));
  await write('projects/Apps/envcheck/package.json', JSON.stringify({ name: 'envcheck', scripts: { build: `node -e "require('fs').writeFileSync('core.txt', process.env.XRB_CORE || '')"` } }));
  await fs.mkdir(path.join(repo, 'node_modules'), { recursive: true });  // installed: no pnpm install in the test
  const r = await request('POST', '/api/projects/envcheck/build-web', { body: '{}' });
  assert.equal(r.status, 202, r.body);
  const done = await panel.panel.jobs.wait(panel.panel.jobs.list().find((j) => j.id === r.json.id)!);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(await fs.readFile(path.join(repo, 'projects/Apps/envcheck/core.txt'), 'utf8'), panel.panel.repo);
});

test('a run is refused while a selected plugin is not built in the workspace', async () => {
  await write('projects/Tests/needs-plugin/xrb-project.json', JSON.stringify({ name: 'Needs', kind: 'test', entry: '.', input: 'some-tracker' }));
  await write('projects/Tests/needs-plugin/index.html', 'x');
  const p = (await import('../src/projects.ts')).discoverProjects(repo).then((ps) => ps.find((x) => x.id === 'needs-plugin')!);
  const fake = Object.create(panel.panel, { repo: { value: repo } });  // a "core" with a built host exe
  await write('native/host/build/Release/xrb-host.exe', 'exe');
  await assert.rejects(fake.run(await p, 'built'), /plugin some-tracker is not built in the workspace: rebuild the host first/);
});
