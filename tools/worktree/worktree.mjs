#!/usr/bin/env node
// Task worktrees: one checkout per task in .worktrees/<name> (git-ignored), on its own branch from origin/main.
// The fetched binaries are not copied: each entry of the primary checkout's third_party/ (CEF, nlohmann) is
// linked into the worktree's third_party/ (a directory junction), so a worktree builds the host without fetching.
//
//   pnpm worktree add <type/short-desc>   new branch + .worktrees/<short-desc>, linked third_party, pnpm install
//   pnpm worktree remove <name>           unlink third_party, `git worktree remove` (refuses a dirty tree);
//                                         deletes the local branch when its PR is merged
//
// Run from the primary checkout. Only one host runs at a time (named mutex): worktrees build and test in
// parallel, but run apps one at a time.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'ci', 'perf'];

/** The worktree folder name for a branch: `fix/hand-jitter` -> `hand-jitter`. */
export function worktreeName(branch) {
  const m = /^([a-z]+)\/([a-z0-9][a-z0-9-]*)$/.exec(branch);
  if (!m || !TYPES.includes(m[1])) {
    throw new Error(`branch must be <type>/<short-desc> (lower case, digits, dashes); types: ${TYPES.join(', ')}`);
  }
  return m[2];
}

/** Links every entry of `from` (except tracked README.md) into `to`; entries already in `to` are kept. Returns the linked names. */
export function linkThirdParty(from, to) {
  if (!fs.existsSync(from)) return [];
  fs.mkdirSync(to, { recursive: true });
  const linked = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'README.md') continue;
    const target = path.join(to, entry.name);
    if (fs.existsSync(target)) continue;
    fs.symlinkSync(path.join(from, entry.name), target, entry.isDirectory() ? 'junction' : 'file');
    linked.push(entry.name);
  }
  return linked;
}

/** Removes the links in `dir` without touching what they point to. Returns the unlinked names. */
export function unlinkThirdParty(dir) {
  if (!fs.existsSync(dir)) return [];
  const unlinked = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    // A junction is removed as a link (rmdir on the link itself), never by recursing into its target.
    const link = path.join(dir, entry.name);
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
    unlinked.push(entry.name);
  }
  return unlinked;
}

// Output is null when it goes to the terminal (stdio: 'inherit').
const git = (cwd, args, opts = {}) => (execFileSync('git', args, { cwd, encoding: 'utf8', ...opts }) ?? '').trim();

function primaryRoot() {
  const common = path.resolve(git(process.cwd(), ['rev-parse', '--git-common-dir']));
  return path.dirname(common);
}

function add(branch) {
  const name = worktreeName(branch);
  const root = primaryRoot();
  const dir = path.join(root, '.worktrees', name);
  if (fs.existsSync(dir)) throw new Error(`${dir} exists`);
  git(root, ['fetch', '--quiet', 'origin', 'main']);
  git(root, ['worktree', 'add', '--quiet', '-b', branch, dir, 'origin/main'], { stdio: 'inherit' });
  // A branch from origin/main tracks it; pushing goes to origin/<branch> instead.
  git(dir, ['branch', '--quiet', '--unset-upstream']);
  const linked = linkThirdParty(path.join(root, 'third_party'), path.join(dir, 'third_party'));
  console.log(linked.length ? `third_party: linked ${linked.join(', ')}` : 'third_party: nothing fetched in the primary checkout (run `pnpm fetch-deps` there)');
  execSync('pnpm install --frozen-lockfile --silent', { cwd: dir, stdio: 'inherit' });
  console.log(`worktree ready: ${dir} (branch ${branch})`);
}

function prMerged(branch, cwd) {
  try {
    return execFileSync('gh', ['pr', 'view', branch, '--json', 'state', '--jq', '.state'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'MERGED';
  } catch {
    return false;
  }
}

function remove(name) {
  const root = primaryRoot();
  const dir = path.join(root, '.worktrees', name);
  // Only a registered worktree: git run in any other folder under the repo would answer for the primary checkout.
  const registered = git(root, ['worktree', 'list', '--porcelain']).split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice('worktree '.length)).toLowerCase());
  if (!fs.existsSync(dir) || !registered.includes(path.resolve(dir).toLowerCase())) throw new Error(`no worktree ${dir}`);
  const branch = git(dir, ['branch', '--show-current']);
  const dirty = git(dir, ['status', '--porcelain']);
  if (dirty) throw new Error(`${dir} has uncommitted changes:\n${dirty}`);
  unlinkThirdParty(path.join(dir, 'third_party'));
  // Ignored files (node_modules, builds) go with it; the clean-tree check above guards the rest.
  git(root, ['worktree', 'remove', '--force', dir], { stdio: 'inherit' });
  // git leaves ignored folders it could not empty (pnpm's node_modules); the links in them are removed as links.
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}`);
  if (branch && prMerged(branch, root)) {
    git(root, ['branch', '-D', branch]);
    console.log(`deleted branch ${branch} (its PR is merged)`);
  } else if (branch) {
    console.log(`kept branch ${branch} (no merged PR for it)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'add' && arg) add(arg);
    else if (cmd === 'remove' && arg) remove(arg);
    else throw new Error('usage: worktree add <type/short-desc> | worktree remove <name>');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
