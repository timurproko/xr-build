import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyLayout, archiveProject, LAYOUT_FILE, readLayout, unarchiveProject, validateLayout } from '../src/layout.ts';
import { discoverArchived, discoverProjects } from '../src/projects.ts';

test('layout rules: named, unique sections that can be folders; a project in at most one', () => {
  assert.equal(validateLayout({ sections: [] }), null);
  assert.equal(validateLayout({ sections: [{ name: 'Demos', items: ['a'] }, { name: 'Checks', items: [] }] }), null);
  assert.match(validateLayout(null)!, /sections/);
  assert.match(validateLayout({ sections: [{ name: ' ', items: [] }] })!, /name/);
  assert.match(validateLayout({ sections: [{ name: 'A', items: [] }, { name: 'a', items: [] }] })!, /two sections named/);
  assert.match(validateLayout({ sections: [{ name: 'A', items: ['x'] }, { name: 'B', items: ['x'] }] })!, /in two sections/);
  assert.match(validateLayout({ sections: [{ name: 'A', items: [1] }] })!, /bad item list/);
  assert.match(validateLayout({ sections: [{ name: 'A/B', items: [] }] })!, /folder name/);
  assert.match(validateLayout({ sections: [{ name: 'archive', items: [] }] })!, /reserved/);
  assert.match(validateLayout({ sections: [{ name: 'Unsorted', items: [] }] })!, /reserved/);
  assert.equal(validateLayout({ sections: [], colors: { a: 'purple' } }), null);
  assert.match(validateLayout({ sections: [], colors: { a: 'pink' } })!, /unknown colour/);
});

async function workspace() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-layout-'));
  const project = async (rel: string, kind = 'app') => {
    await fs.mkdir(path.join(ws, 'projects', rel), { recursive: true });
    await fs.writeFile(path.join(ws, 'projects', rel, 'xrb-project.json'), JSON.stringify({ name: path.basename(rel), kind }));
  };
  return { ws, project };
}

test('sections are the folders under projects/, in the saved order; Unsorted is not a section', async () => {
  const { ws, project } = await workspace();
  await project('Demos/b');
  await project('Demos/a');
  await project('Checks/rig', 'test');
  await project('Unsorted/loose');
  let l = await readLayout(ws, await discoverProjects(ws));
  assert.deepEqual(l.sections, [{ name: 'Checks', items: ['rig'] }, { name: 'Demos', items: ['a', 'b'] }], 'alphabetical without a saved layout');
  await fs.writeFile(path.join(ws, LAYOUT_FILE), JSON.stringify({ sections: [{ name: 'Demos', items: ['b', 'a'] }, { name: 'Checks', items: [] }], colors: { b: 'teal' } }));
  l = await readLayout(ws, await discoverProjects(ws));
  assert.deepEqual(l.sections, [{ name: 'Demos', items: ['b', 'a'] }, { name: 'Checks', items: ['rig'] }]);
  assert.deepEqual(l.colors, { b: 'teal' });
  await fs.writeFile(path.join(ws, LAYOUT_FILE), '{ broken');
  assert.deepEqual((await readLayout(ws, await discoverProjects(ws))).sections.map((s) => s.name), ['Checks', 'Demos'], 'unreadable file: the folders still count');
});

test('saving a layout moves project folders: drag, new, renamed and deleted sections', async () => {
  const { ws, project } = await workspace();
  await project('Demos/a');
  await project('Demos/b');
  await project('Unsorted/c');
  const apply = async (sections: { name: string; items: string[] }[]) => applyLayout(ws, { sections, colors: {} }, await discoverProjects(ws));
  const where = async () => Object.fromEntries((await discoverProjects(ws)).map((p) => [p.id, p.section]));

  await apply([{ name: 'Demos', items: ['a'] }, { name: 'Tours', items: ['c'] }]);
  assert.deepEqual(await where(), { a: 'Demos', b: 'Unsorted', c: 'Tours' }, 'b left every section: Unsorted; c dragged into the new Tours');

  await apply([{ name: 'Showcase', items: ['a'] }, { name: 'Tours', items: ['c'] }]);
  assert.deepEqual(await where(), { a: 'Showcase', b: 'Unsorted', c: 'Tours' }, 'renaming Demos moves its projects');
  await assert.rejects(fs.access(path.join(ws, 'projects', 'Demos')), 'the old section folder is gone');

  await apply([{ name: 'Showcase', items: ['a', 'b', 'c'] }, { name: 'Empty', items: [] }]);
  assert.deepEqual(await where(), { a: 'Showcase', b: 'Showcase', c: 'Showcase' });
  await assert.rejects(fs.access(path.join(ws, 'projects', 'Tours')), 'a deleted, emptied section folder is removed');
  await assert.rejects(fs.access(path.join(ws, 'projects', 'Unsorted')), 'an empty Unsorted folder is removed');
  await fs.access(path.join(ws, 'projects', 'Empty', '.gitkeep'));
  assert.deepEqual((await readLayout(ws, await discoverProjects(ws))).sections.map((s) => s.name), ['Showcase', 'Empty'], 'the saved order');
});

test('archive is flat and unarchive returns a project to its section', async () => {
  const { ws, project } = await workspace();
  await project('Demos/a');
  await project('Demos/keep');
  const [a] = (await discoverProjects(ws)).filter((p) => p.id === 'a');
  await archiveProject(ws, a);
  const [archived] = await discoverArchived(ws);
  assert.equal(archived.id, 'archive/a');
  await fs.access(path.join(ws, 'projects', 'archive', 'a', 'xrb-project.json'));
  await unarchiveProject(ws, archived);
  assert.equal((await discoverProjects(ws)).find((p) => p.id === 'a')?.section, 'Demos');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(ws, LAYOUT_FILE), 'utf8')).archivedFrom, {});
});
