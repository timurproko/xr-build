// The project list's sections, arranged by the developer (create, rename, delete, drag projects
// between them). Sections are folders: projects/<section>/<project> in the workspace; projects in no
// section are in projects/Unsorted/ and show under "Unsorted". xrb-panel.json in the workspace keeps only
// what folders cannot: the order of sections and projects, colours, and where archived projects came from.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE, liveId, moveProject, PROJECTS, removeIfEmpty, sectionFolders, sectionNameProblem, UNSORTED, type Project } from './projects.ts';

export const LAYOUT_FILE = 'xrb-panel.json';

export interface Section {
  name: string;
  /** project ids (folder names) in display order */
  items: string[];
}

/** Stripe colours a project can be given from the list's right-click menu. */
export const COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'grey'] as const;

export interface Layout {
  /** the section folders except Unsorted, in display order */
  sections: Section[];
  /** project id (live form) -> one of COLORS; projects without one keep their kind's colour */
  colors?: Record<string, string>;
  /** archived project id (live form) -> the section it was archived from */
  archivedFrom?: Record<string, string>;
}

/** Checks a layout from the UI; returns the problem or null. */
export function validateLayout(l: unknown): string | null {
  if (!l || typeof l !== 'object' || !Array.isArray((l as Layout).sections)) return 'layout must have a sections list';
  const names = new Set<string>();
  const seen = new Set<string>();
  for (const s of (l as Layout).sections) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) return 'every section needs a name';
    if (s.name.length > 60) return `section name "${s.name.slice(0, 20)}…" is too long`;
    const problem = sectionNameProblem(s.name.trim());
    if (problem) return problem;
    const key = s.name.trim().toLowerCase();
    if (names.has(key)) return `there are two sections named "${s.name.trim()}"`;
    names.add(key);
    if (!Array.isArray(s.items) || s.items.some((i) => typeof i !== 'string')) return `section "${s.name}" has a bad item list`;
    for (const i of s.items) {
      if (seen.has(i)) return `${i} is in two sections`;
      seen.add(i);
    }
  }
  const colors = (l as Layout).colors;
  if (colors !== undefined) {
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return 'colors must be an object';
    for (const [id, c] of Object.entries(colors)) if (!(COLORS as readonly string[]).includes(c)) return `unknown colour "${c}" for ${id}`;
  }
  return null;
}

async function readSaved(ws: string): Promise<Layout> {
  try {
    const l = JSON.parse((await fs.readFile(path.join(ws, LAYOUT_FILE), 'utf8')).replace(/^﻿/, '')) as Layout;
    if (l && Array.isArray(l.sections)) return { sections: l.sections, colors: { ...(l.colors ?? {}) }, archivedFrom: { ...(l.archivedFrom ?? {}) } };
  } catch { /* no layout yet, or unreadable */ }
  return { sections: [], colors: {}, archivedFrom: {} };
}

async function save(ws: string, l: Layout): Promise<void> {
  const clean: Layout = { sections: l.sections.map((s) => ({ name: s.name.trim(), items: s.items })), colors: l.colors ?? {}, archivedFrom: l.archivedFrom ?? {} };
  await fs.writeFile(path.join(ws, LAYOUT_FILE), JSON.stringify(clean, null, 2) + '\n', 'utf8');
}

/** Orders `names` like `order` (known ones first, in that order), the rest alphabetically after them. */
function ordered(names: string[], order: string[]): string[] {
  const rank = new Map(order.map((n, i) => [n.toLowerCase(), i]));
  return [...names].sort((a, b) => (rank.get(a.toLowerCase()) ?? 1e9) - (rank.get(b.toLowerCase()) ?? 1e9) || a.localeCompare(b));
}

/**
 * The layout as the folders are: one section per section folder (Unsorted excluded: its projects show as
 * "Unsorted"), with the saved order of sections and projects, colours and archive origins.
 */
export async function readLayout(ws: string, live: Project[]): Promise<Layout> {
  const saved = await readSaved(ws);
  const folders = (await sectionFolders(ws)).filter((f) => f !== UNSORTED);
  const sections = ordered(folders, saved.sections.map((s) => s.name)).map((name) => {
    const items = live.filter((p) => p.section === name).map((p) => p.id);
    const savedItems = saved.sections.find((s) => s.name.toLowerCase() === name.toLowerCase())?.items ?? [];
    return { name, items: ordered(items, savedItems) };
  });
  return { sections, colors: saved.colors, archivedFrom: saved.archivedFrom };
}

/**
 * Applies a layout from the UI to the folders: creates new section folders, moves each live project into the
 * folder of the section that lists it (Unsorted when none does), and removes section folders left empty. A
 * renamed section is the same: its projects move to the new folder. Then saves the order and colours.
 */
export async function applyLayout(ws: string, l: Layout, live: Project[]): Promise<void> {
  const saved = await readSaved(ws);
  const sectionOf = new Map<string, string>();
  for (const s of l.sections) for (const id of s.items) sectionOf.set(id, s.name.trim());
  for (const s of l.sections) {
    const dir = path.join(ws, PROJECTS, s.name.trim());
    await fs.mkdir(dir, { recursive: true });
    // An empty section folder stays in git only with a file in it.
    if (!(await fs.readdir(dir)).length) await fs.writeFile(path.join(dir, '.gitkeep'), '');
  }
  for (const p of live) {
    const want = sectionOf.get(p.id) ?? UNSORTED;
    if (p.section !== want) await moveProject(ws, p, want);
  }
  const keep = new Set([...l.sections.map((s) => s.name.trim().toLowerCase()), UNSORTED.toLowerCase()]);
  for (const f of await sectionFolders(ws)) if (!keep.has(f.toLowerCase())) await removeIfEmpty(path.join(ws, PROJECTS, f));
  await removeIfEmpty(path.join(ws, PROJECTS, UNSORTED));
  await save(ws, { sections: l.sections, colors: l.colors ?? saved.colors, archivedFrom: saved.archivedFrom });
}

/** Archives a live project into projects/archive/, remembering its section for unarchive. */
export async function archiveProject(ws: string, p: Project): Promise<string> {
  const to = await moveProject(ws, p, ARCHIVE);
  const saved = await readSaved(ws);
  saved.archivedFrom = { ...saved.archivedFrom, [p.id]: p.section ?? UNSORTED };
  await save(ws, saved);
  return to;
}

/** Moves an archived project back into the section it came from (Unsorted when that is gone or unknown). */
export async function unarchiveProject(ws: string, p: Project): Promise<string> {
  const id = liveId(p.id);
  const saved = await readSaved(ws);
  const from = saved.archivedFrom?.[id];
  const sections = await sectionFolders(ws);
  const to = await moveProject(ws, p, from && sections.includes(from) ? from : UNSORTED);
  delete saved.archivedFrom?.[id];
  await save(ws, saved);
  return to;
}
