import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO } from '../src/env.ts';
import { discoverProjects } from '../src/projects.ts';
import { createProject, createWorkspace, isWorkspace, ProjectRefused, STARTER_APP, writeEditorConfig } from '../src/workspace.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'xrb-ws-'));

test('a new workspace gets the standard layout and a starter app the panel lists', async () => {
  const ws = await tmp();
  assert.equal(await isWorkspace(ws), false);
  const added = await createWorkspace(REPO, ws);
  assert.ok(added.includes('.gitignore') && added.includes('pnpm-workspace.yaml') && added.includes(`projects/Unsorted/${STARTER_APP}/xrb-project.json`));
  assert.equal(await isWorkspace(ws), true);
  for (const d of ['projects', 'plugins']) assert.ok((await fs.stat(path.join(ws, d))).isDirectory());
  const ignore = await fs.readFile(path.join(ws, '.gitignore'), 'utf8');
  for (const d of ['plugins/*/bin/', 'third_party/', 'node_modules/', 'dist/', 'build/']) assert.ok(ignore.split(/\r?\n/).includes(d), d);
  const projects = await discoverProjects(ws);
  assert.deepEqual(projects.map((p) => [p.id, p.manifest?.name, p.manifest?.kind]), [[STARTER_APP, STARTER_APP, 'app']]);
  const pkg = JSON.parse(await fs.readFile(path.join(ws, 'projects', 'Unsorted', STARTER_APP, 'package.json'), 'utf8'));
  assert.equal(pkg.name, STARTER_APP);
  assert.equal(pkg.dependencies['@xr-build/sdk'], undefined, 'the SDK comes from the core, not a dependency');
});

test('creating into an existing folder only adds what is missing', async () => {
  const ws = await tmp();
  await fs.writeFile(path.join(ws, '.gitignore'), 'mine\n');
  await fs.mkdir(path.join(ws, 'projects', 'Unsorted', STARTER_APP), { recursive: true });
  await fs.writeFile(path.join(ws, 'projects', 'Unsorted', STARTER_APP, 'notes.txt'), 'keep');
  const added = await createWorkspace(REPO, ws);
  assert.equal(await fs.readFile(path.join(ws, '.gitignore'), 'utf8'), 'mine\n');
  assert.ok(!added.includes('.gitignore'));
  assert.ok(!added.some((f) => f.startsWith(`projects/Unsorted/${STARTER_APP}/`)), 'an existing starter folder is left alone');
  assert.equal(await fs.readFile(path.join(ws, 'projects', 'Unsorted', STARTER_APP, 'notes.txt'), 'utf8'), 'keep');
});

test('a new project takes its name, and an existing folder or a bad name is refused', async () => {
  const ws = await tmp();
  await createProject(REPO, ws, 'globe', 'Globe <Demo>');
  const m = JSON.parse(await fs.readFile(path.join(ws, 'projects', 'Unsorted', 'globe', 'xrb-project.json'), 'utf8'));
  assert.equal(m.name, 'Globe <Demo>');
  assert.match(await fs.readFile(path.join(ws, 'projects', 'Unsorted', 'globe', 'index.html'), 'utf8'), /<title>Globe &lt;Demo&gt;<\/title>/);
  await assert.rejects(createProject(REPO, ws, 'globe'), ProjectRefused);
  await assert.rejects(createProject(REPO, ws, '../out'), ProjectRefused);
});

test('the editor config maps the SDK names to the core sources', async () => {
  const ws = await tmp();
  assert.equal(await writeEditorConfig(REPO, ws), true);
  const c = JSON.parse(await fs.readFile(path.join(ws, 'jsconfig.json'), 'utf8'));
  const sdk = c.compilerOptions.paths['@xr-build/sdk'][0];
  assert.equal(path.resolve(sdk), path.join(REPO, 'packages', 'sdk', 'src', 'index.ts'));
  await fs.access(sdk);
  await fs.access(c.compilerOptions.paths['@xr-build/ui-kit'][0]);
  assert.equal(await writeEditorConfig(REPO, ws), false, 'unchanged: not rewritten');
});
