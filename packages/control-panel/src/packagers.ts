// Packager plugins (design D5): how a platform turns a built app into a package for its stations.
// The panel knows no platform: a packager is any package in the core (packages/*) or in the user's
// workspace (plugins/*, plugins/*/*) whose package.json names its module in
// "xrBuild": { "packager": "./src/packager.ts" }. Without one the panel still builds and runs every
// project and shows packaging as unavailable.
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** One identity field the packager needs per project (stored in the manifest's `plugins.<platform>` section). */
export interface IdentityField {
  key: string;
  label: string;
  /** 'version': dotted numbers, raised after each package; 'text': free text */
  kind: 'text' | 'version';
  required: boolean;
  /** cannot change once the project was packaged (e.g. the id stations know the app by) */
  fixed?: boolean;
  hint?: string;
}

export interface IdentityError {
  /** the identity key, e.g. "id" */
  field: string;
  message: string;
}

/** Which provider runs each role (the project's selection). */
export interface RoleSelection {
  input: string;
  display: string;
  /** "" when the app runs standalone */
  platform: string;
}

export interface PackagerBuildOptions {
  /** built web app (index.html at its root) */
  app: string;
  /** xrb-host build output: the exe and CEF */
  runtimeDir: string;
  /**
   * Where each selected plugin's built files are: plugin name -> folder (a workspace plugin's bin/).
   * Ship each into the package's plugins/<name>/. Unset (an older caller): `<runtimeDir>/plugins/<name>`.
   */
  pluginDirs?: Record<string, string>;
  /** plugin names to ship (the selected ones that are plugins, not built-ins) */
  plugins: string[];
  selection: RoleSelection;
  /** the manifest's `plugins.<platform>` section: the declared identity fields, version included */
  identity: Record<string, string>;
  /** PNG icon; a default one when absent */
  icon?: string;
  iconColor?: string;
  /** output folder */
  out: string;
  log(msg: string): void;
}

export interface PackagerBuildResult {
  /** the package file */
  file: string;
  sizeBytes: number;
}

export interface Packager {
  /** platform name, as projects select it (e.g. "station") */
  name: string;
  identityFields: IdentityField[];
  validate(identity: Record<string, unknown>): IdentityError[];
  build(o: PackagerBuildOptions): Promise<PackagerBuildResult>;
  /** reproduces the station's install in a folder, for local testing */
  install?(file: string, dir: string): Promise<{ files: number }>;
}

export interface FoundPackager {
  packager: Packager;
  /** folder of the package.json that declared it */
  dir: string;
}

export interface PackagerDiscovery {
  found: FoundPackager[];
  /** declared packagers that failed to load: shown, never fatal */
  problems: string[];
}

function candidateDirs(repo: string, workspace: string): string[] {
  const subdirs = (d: string) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => path.join(d, e.name)) : []);
  const plugins = subdirs(path.join(workspace, 'plugins'));
  return [...subdirs(path.join(repo, 'packages')), ...plugins, ...plugins.flatMap(subdirs)];
}

/** The folder of one plugin to ship (PackagerBuildOptions.pluginDirs, with its default). */
export function pluginDirOf(o: Pick<PackagerBuildOptions, 'runtimeDir' | 'pluginDirs'>, name: string): string {
  return o.pluginDirs?.[name] ?? path.join(o.runtimeDir, 'plugins', name);
}

function isPackager(p: unknown): p is Packager {
  const o = p as Partial<Packager> | null;
  return !!o && typeof o.name === 'string' && !!o.name && Array.isArray(o.identityFields) && typeof o.validate === 'function' && typeof o.build === 'function';
}

/** Finds and loads every declared packager. A module exports the contract as `packager` (or default). */
export async function discoverPackagers(repo: string, workspace: string): Promise<PackagerDiscovery> {
  const found: FoundPackager[] = [], problems: string[] = [];
  for (const dir of candidateDirs(repo, workspace)) {
    let decl: unknown;
    try {
      decl = (JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { xrBuild?: { packager?: unknown } }).xrBuild?.packager;
    } catch {
      continue;  // no package.json
    }
    if (decl === undefined) continue;
    const where = dir.startsWith(workspace) ? path.relative(workspace, dir) : path.relative(repo, dir);
    if (typeof decl !== 'string') {
      problems.push(`${where}: xrBuild.packager must be a module path`);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(path.resolve(dir, decl)).href)) as { packager?: unknown; default?: unknown };
      const p = mod.packager ?? mod.default;
      if (!isPackager(p)) throw new Error('the module does not export a packager (name, identityFields, validate, build)');
      if (found.some((f) => f.packager.name === p.name)) throw new Error(`a packager named "${p.name}" is already loaded`);
      found.push({ packager: p, dir });
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message}`);
    }
  }
  return { found, problems };
}

/** The packager for a platform; null when the project runs standalone or no plugin packages for it. */
export function packagerFor(d: PackagerDiscovery, platform: string): FoundPackager | null {
  return platform ? (d.found.find((f) => f.packager.name === platform) ?? null) : null;
}
