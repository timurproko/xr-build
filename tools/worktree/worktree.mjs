#!/usr/bin/env node
// Task worktrees: one checkout per task in .worktrees/<name> (git-ignored), on its own branch from origin/main.
// The fetched binaries are not copied: each entry of the primary checkout's third_party/ (CEF, nlohmann) is
// linked into the worktree's third_party/ (a directory junction), so a worktree builds the host without fetching.
//
//   pnpm worktree add <type/short-desc>        new branch + .worktrees/<short-desc>, linked third_party, pnpm install
//   pnpm worktree remove <name> [--discard]    unlink third_party, remove the worktree (refuses a dirty tree);
//                                              deletes the local branch when its PR is merged. A worktree whose PR
//                                              closed unmerged is removed only with --discard (branch deleted too)
//   pnpm worktree sweep [--apply]              every task worktree as dirty / active / merged / closed / unknown;
//                                              --apply removes the merged, clean ones and nothing else
//   pnpm worktree handoff <name> [--change <id>] [--pr <n>]
//                                              records worktree, branch, change, PR and head in .artifacts/handoff.json
//                                              and prints the handoff report skeleton
//
// Run from the primary checkout or any worktree. Only one host runs at a time (named mutex): worktrees build and
// test in parallel, but run apps one at a time. PR states come from `gh`.

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

/** A worktree's sweep state from what is known about it. `pr` is 'OPEN' | 'MERGED' | 'CLOSED' | null (no PR) | 'unknown'. */
export function classify({ dirty, pr }) {
  if (dirty) return 'dirty';
  if (pr === 'unknown') return 'unknown';
  if (pr === 'MERGED') return 'merged';
  if (pr === 'CLOSED') return 'closed';
  return 'active';
}

// Output is null when it goes to the terminal (stdio: 'inherit').
const git = (cwd, args, opts = {}) => (execFileSync('git', args, { cwd, encoding: 'utf8', ...opts }) ?? '').trim();

/** The primary checkout's root, from anywhere inside it or one of its worktrees. */
export function primaryRoot(cwd = process.cwd()) {
  return path.dirname(path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])));
}

/** The PR state of a branch through `gh`: 'OPEN' | 'MERGED' | 'CLOSED', null without a PR, 'unknown' when gh fails. */
export function ghPrState(branch, cwd) {
  try {
    const out = execFileSync('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'state', '--jq', '.[0].state // ""'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return 'unknown';
  }
}

/** Task worktrees (registered, under .worktrees/): [{ name, dir, branch }]. */
export function taskWorktrees(root) {
  // Compared as real paths: Windows may give the same folder as an 8.3 short path and as the long one.
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const base = real(path.join(root, '.worktrees')).toLowerCase() + path.sep;
  const out = [];
  let current = null;
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { dir: real(line.slice('worktree '.length)), branch: null };
      if (current.dir.toLowerCase().startsWith(base)) out.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return out.map((w) => ({ ...w, name: path.basename(w.dir) }));
}

function findWorktree(root, name) {
  const w = taskWorktrees(root).find((t) => t.name === name);
  if (!w || !fs.existsSync(w.dir)) throw new Error(`no worktree ${path.join(root, '.worktrees', name)}`);
  return w;
}

export function add(branch, { root = primaryRoot(), install = true, log = console.log } = {}) {
  const name = worktreeName(branch);
  const dir = path.join(root, '.worktrees', name);
  if (fs.existsSync(dir)) throw new Error(`${dir} exists`);
  git(root, ['fetch', '--quiet', 'origin', 'main']);
  git(root, ['worktree', 'add', '--quiet', '-b', branch, dir, 'origin/main'], { stdio: 'inherit' });
  // A branch from origin/main tracks it; pushing goes to origin/<branch> instead.
  git(dir, ['branch', '--quiet', '--unset-upstream']);
  const linked = linkThirdParty(path.join(root, 'third_party'), path.join(dir, 'third_party'));
  log(linked.length ? `third_party: linked ${linked.join(', ')}` : 'third_party: nothing fetched in the primary checkout (run `pnpm fetch-deps` there)');
  if (install) execSync('pnpm install --frozen-lockfile --silent', { cwd: dir, stdio: 'inherit' });
  log(`worktree ready: ${dir} (branch ${branch})`);
  return dir;
}

export function remove(name, { root = primaryRoot(), discard = false, prState = ghPrState, log = console.log } = {}) {
  const w = findWorktree(root, name);
  const dirty = git(w.dir, ['status', '--porcelain']);
  if (dirty) throw new Error(`${w.dir} has uncommitted changes:\n${dirty}`);
  const pr = w.branch ? prState(w.branch, root) : null;
  if (discard && pr !== 'CLOSED') throw new Error(`--discard is for a worktree whose PR closed unmerged; ${w.branch}'s PR is ${pr ?? 'missing'}`);
  if (!discard && pr === 'CLOSED') throw new Error(`${w.branch}'s PR closed unmerged: remove it with --discard if its work is not needed`);
  unlinkThirdParty(path.join(w.dir, 'third_party'));
  // Ignored files (node_modules, builds) go with it; the clean-tree check above guards the rest.
  git(root, ['worktree', 'remove', '--force', w.dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  // git leaves ignored folders it could not empty (pnpm's node_modules); the links in them are removed as links.
  fs.rmSync(w.dir, { recursive: true, force: true });
  log(`removed ${w.dir}`);
  if (w.branch && (pr === 'MERGED' || discard)) {
    git(root, ['branch', '-D', w.branch]);
    log(`deleted branch ${w.branch} (${discard ? 'discarded' : 'its PR is merged'})`);
  } else if (w.branch) {
    log(`kept branch ${w.branch} (no merged PR for it)`);
  }
}

/** Lists task worktrees with their state; with `apply`, removes the merged clean ones. Returns [{ name, branch, state }]. */
export function sweep({ root = primaryRoot(), apply = false, prState = ghPrState, log = console.log } = {}) {
  const rows = taskWorktrees(root).filter((w) => fs.existsSync(w.dir)).map((w) => {
    const dirty = Boolean(git(w.dir, ['status', '--porcelain']));
    const pr = w.branch ? prState(w.branch, root) : null;
    return { name: w.name, branch: w.branch, state: classify({ dirty, pr }) };
  });
  for (const r of rows) log(`${r.state.padEnd(8)} ${r.name} (${r.branch ?? 'detached'})`);
  if (!rows.length) log('no task worktrees');
  if (apply) for (const r of rows.filter((x) => x.state === 'merged')) remove(r.name, { root, prState, log });
  return rows;
}

/** Writes .artifacts/handoff.json in the worktree and returns the report skeleton. */
export function handoff(name, { root = primaryRoot(), change = null, pr = null, now = new Date() } = {}) {
  const w = findWorktree(root, name);
  const record = { worktree: w.dir, branch: w.branch, change, pr: pr ? Number(pr) : null, head: git(w.dir, ['rev-parse', 'HEAD']), time: now.toISOString() };
  fs.mkdirSync(path.join(w.dir, '.artifacts'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, '.artifacts', 'handoff.json'), `${JSON.stringify(record, null, 2)}\n`);
  return [
    `Worktree: ${record.worktree}`,
    `Branch and PR: ${record.branch}${record.pr ? `, #${record.pr}` : ''}${change ? ` (change ${change})` : ''}`,
    `Commit: ${record.head.slice(0, 7)}`,
    'Commands run: ',
    'Behaviour: ',
    'Gaps: ',
    'Manual test: ',
  ].join('\n');
}

function options(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply' || argv[i] === '--discard') out[argv[i].slice(2)] = true;
    else if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = options(rest);
  try {
    if (cmd === 'add' && o._[0]) add(o._[0]);
    else if (cmd === 'remove' && o._[0]) remove(o._[0], { discard: Boolean(o.discard) });
    else if (cmd === 'sweep') sweep({ apply: Boolean(o.apply) });
    else if (cmd === 'handoff' && o._[0]) console.log(handoff(o._[0], { change: o.change ?? null, pr: o.pr ?? null }));
    else throw new Error('usage: worktree add <type/short-desc> | remove <name> [--discard] | sweep [--apply] | handoff <name> [--change <id>] [--pr <n>]');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
