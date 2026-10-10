// The user's workspace (design D1, D6): projects, plugins and the panel layout, outside the core repo.
// The panel creates one from templates/workspace and new projects from templates/app; it only adds
// files that are missing and never runs git there (versioning the workspace is the user's choice).
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverAll, liveId, PROJECTS, UNSORTED } from './projects.ts';

export const WORKSPACE_TEMPLATE = path.join('templates', 'workspace');
export const APP_TEMPLATE = path.join('templates', 'app');
/** Folder name of the starter app a new workspace gets. */
export const STARTER_APP = 'hello-xr';

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** A folder is a workspace once it has the workspace's pnpm file or a projects/ folder. */
export async function isWorkspace(dir: string): Promise<boolean> {
  return (await exists(path.join(dir, 'pnpm-workspace.yaml'))) || (await exists(path.join(dir, PROJECTS)));
}

/** Copies `from` into `to`, file by file, skipping files that already exist; `edit` may rewrite text files. */
async function copyMissing(from: string, to: string, edit: (rel: string, text: string) => string = (_r, t) => t, rel = ''): Promise<string[]> {
  const added: string[] = [];
  await fs.mkdir(path.join(to, rel), { recursive: true });
  for (const e of await fs.readdir(path.join(from, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) {
      added.push(...(await copyMissing(from, to, edit, r)));
      continue;
    }
    const dest = path.join(to, r);
    if (await exists(dest)) continue;
    await fs.writeFile(dest, edit(r, await fs.readFile(path.join(from, r), 'utf8')), { flag: 'wx' });
    added.push(r.split(path.sep).join('/'));
  }
  return added;
}

/** Creates or completes a workspace in `dir` with a starter app; returns the files it added. */
export async function createWorkspace(core: string, dir: string): Promise<string[]> {
  const added = await copyMissing(path.join(core, WORKSPACE_TEMPLATE), dir);
  if (!(await discoverAll(dir)).some((p) => liveId(p.id) === STARTER_APP) && !(await exists(path.join(dir, PROJECTS, UNSORTED, STARTER_APP))))
    added.push(...(await createProject(core, dir, STARTER_APP)).map((f) => `${PROJECTS}/${UNSORTED}/${STARTER_APP}/${f}`));
  return added;
}

export class ProjectRefused extends Error {}

/** Folder names a new project may have: lower case words with dashes (also its package name). */
export const PROJECT_FOLDER = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A new app from templates/app in `<workspace>/projects/Unsorted/<folder>`; refused when a project has that name. */
export async function createProject(core: string, workspace: string, folder: string, name = folder): Promise<string[]> {
  if (!PROJECT_FOLDER.test(folder)) throw new ProjectRefused(`"${folder}" is not a project folder name (lower case letters, digits, dashes)`);
  const dir = path.join(workspace, PROJECTS, UNSORTED, folder);
  const taken = (await discoverAll(workspace)).find((p) => liveId(p.id).toLowerCase() === folder.toLowerCase());
  if (taken) throw new ProjectRefused(`a project named ${folder} already exists (${path.relative(workspace, taken.dir).split(path.sep).join('/')})`);
  if (await exists(dir)) throw new ProjectRefused(`${PROJECTS}/${UNSORTED}/${folder} already exists`);
  const json = (s: string) => JSON.stringify(s).slice(1, -1);
  const html = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' } as Record<string, string>)[c]};`);
  return copyMissing(path.join(core, APP_TEMPLATE), dir, (rel, text) =>
    text.replaceAll('__PACKAGE__', folder).replaceAll('__NAME__', rel.endsWith('.html') ? html(name) : json(name)));
}

/**
 * Editor resolution of the SDK (app-sdk-supply): an ignored jsconfig.json in the workspace mapping the
 * SDK names to this core's sources. Rewritten only when it changes.
 */
export async function writeEditorConfig(core: string, workspace: string): Promise<boolean> {
  const src = (pkg: string) => path.join(core, 'packages', pkg, 'src', 'index.ts').split(path.sep).join('/');
  const config = {
    compilerOptions: {
      module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', checkJs: false, allowJs: true,
      paths: { '@xr-build/sdk': [src('sdk')], '@xr-build/ui-kit': [src('ui-kit')] },
    },
    exclude: ['**/node_modules', '**/dist', '**/build', 'plugins/*/bin', 'third_party', 'builds'],
  };
  const file = path.join(workspace, 'jsconfig.json');
  const text = JSON.stringify(config, null, 2) + '\n';
  if ((await fs.readFile(file, 'utf8').catch(() => null)) === text) return false;
  await fs.writeFile(file, text, 'utf8');
  return true;
}
